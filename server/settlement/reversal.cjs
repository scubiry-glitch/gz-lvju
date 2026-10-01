'use strict';
const {assert,id,parse,rows,postLedger,sqlDate}=require('./primitives.cjs');
const ddl=[`CREATE TABLE IF NOT EXISTS commerce_shared_recovery_cases (
 id VARCHAR(36) PRIMARY KEY,context_id VARCHAR(36) NOT NULL,unit_id VARCHAR(36) NOT NULL,
 original_execution_line_id VARCHAR(36) NOT NULL,reversal_id BIGINT NOT NULL,party_id VARCHAR(64) NOT NULL,
 recovery_kind VARCHAR(24) NOT NULL,principal_minor BIGINT NOT NULL,recovered_minor BIGINT NOT NULL DEFAULT 0,
 status VARCHAR(24) NOT NULL,reason VARCHAR(1000) NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,
 UNIQUE KEY uk_original_line(original_execution_line_id),KEY unit_idx(unit_id),KEY party_idx(party_id,status)
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commerce_shared_recovery_events (
 event_key VARCHAR(160) PRIMARY KEY,recovery_id VARCHAR(36) NOT NULL,amount_minor BIGINT NOT NULL,
 kind VARCHAR(24) NOT NULL,created_at DATETIME NOT NULL,KEY case_idx(recovery_id)
) ENGINE=InnoDB`];
async function migrate(c){for(const sql of ddl)await c.query(sql);}
async function installed(c){return Boolean((await rows(c,"SELECT 1 ok FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_settlement_units'"))[0]);}
async function recordRecovery(c,{original_line_id,amount_minor,event_key,kind}) {
 const [table]=await rows(c,"SELECT 1 ok FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='commerce_shared_recovery_cases'");if(!table)return null;
 const [recovery]=await rows(c,'SELECT * FROM commerce_shared_recovery_cases WHERE original_execution_line_id=? FOR UPDATE',[original_line_id]);if(!recovery)return null;
 const [prior]=await rows(c,'SELECT * FROM commerce_shared_recovery_events WHERE event_key=?',[event_key]);if(prior){assert(prior.recovery_id===recovery.id&&String(prior.amount_minor)===String(amount_minor),'回收事件幂等冲突',409);return recovery;}
 const amount=BigInt(amount_minor),total=BigInt(recovery.recovered_minor)+amount;assert(amount>0n&&total<=BigInt(recovery.principal_minor),'实际回收超过本笔追偿余额',409);
 await c.execute('INSERT INTO commerce_shared_recovery_events(event_key,recovery_id,amount_minor,kind,created_at) VALUES(?,?,?,?,?)',[event_key,recovery.id,amount.toString(),kind,sqlDate()]);
 await c.execute('UPDATE commerce_shared_recovery_cases SET recovered_minor=?,status=?,updated_at=? WHERE id=?',[total.toString(),total===BigInt(recovery.principal_minor)?'RECOVERED':'OPEN',sqlDate(),recovery.id]);return recovery;
}
async function applySharedReversal(c,{service,principal,reversal,note}) {
 if(!await installed(c))return false;
 const [reference]=await rows(c,"SELECT u.*,x.biz_type,x.biz_order_no FROM commerce_settlement_units u JOIN commerce_settlement_business_contexts x ON x.id=u.context_id WHERE u.recognition_id=? AND x.biz_type='commerce'",[reversal.redemption_id]);
 if(!reference)return false;
 assert(String(reversal.requested_by)!==String(principal.account.id),'申请人不能批准自己的核销撤销',403,'review_separation');
 const [guard]=await rows(c,"SELECT * FROM payment_order_guards WHERE biz_type='commerce' AND biz_order_no=? FOR UPDATE",[reference.biz_order_no.replaceAll('-','')]);assert(guard,'共享核销缺少原支付保护域',409);
 const [payment]=await rows(c,'SELECT * FROM payment_orders WHERE id=? FOR UPDATE',[guard.paid_payment_id]);assert(payment&&payment.pay_status==='paid','原支付状态需核验',409);
 await rows(c,'SELECT id FROM payment_refunds WHERE payment_order_id=? ORDER BY id FOR UPDATE',[payment.id]);
 const sourceIds=(await rows(c,'SELECT DISTINCT source_id FROM commerce_settlement_items WHERE unit_id=? AND source_id IS NOT NULL',[reference.id])).map(i=>i.source_id);
 const lots=await rows(c,'SELECT source_id FROM commerce_commission_funding_lots WHERE unit_id=?',[reference.id]);sourceIds.push(reference.source_id,...lots.map(l=>l.source_id));
 for(const sourceId of [...new Set(sourceIds)].filter(Boolean).sort())await rows(c,'SELECT id FROM commerce_funding_sources WHERE id=? FOR UPDATE',[sourceId]);
 const [unit]=await rows(c,'SELECT * FROM commerce_settlement_units WHERE id=? FOR UPDATE',[reference.id]);assert(unit.status==='CONFIRMED','共享结算单位已经撤销或状态已变更',409);
 const items=await rows(c,'SELECT * FROM commerce_settlement_items WHERE unit_id=? ORDER BY id FOR UPDATE',[unit.id]);assert(items.length,'共享核销结算组件缺失',409);
 assert(items.every(i=>BigInt(i.reserved_minor)===0n),'有资金执行在途，须查清原机构请求后撤销核销',409,'shared_reversal_in_flight');
 assert(items.every(i=>BigInt(i.offset_minor)===0n),'已结抵扣须先按原抵扣凭据冲回',409,'shared_reversal_offset_pending');
 const lines=await rows(c,'SELECT l.* FROM commerce_execution_lines l JOIN commerce_settlement_items i ON i.id=l.item_id WHERE i.unit_id=? ORDER BY l.id FOR UPDATE',[unit.id]);
 assert(lines.every(l=>['SUCCEEDED','FAILED_FINAL','CANCELLED'].includes(l.status)),'原资金执行状态未明确',409,'shared_reversal_in_flight');
 if(lines.length){const linked=await rows(c,`SELECT status FROM commerce_execution_lines WHERE original_line_id IN (${lines.map(()=>'?').join(',')})`,lines.map(l=>l.id));assert(linked.every(l=>['DRAFT','SUCCEEDED','FAILED_FINAL','CANCELLED'].includes(l.status)),'资金回退在途，须等机构确认',409,'shared_reversal_in_flight');}
 const [redemption]=await rows(c,'SELECT r.*,cc.status coupon_status,cc.order_id coupon_order_id FROM commerce_redemptions r JOIN commerce_coupons cc ON cc.id=r.coupon_id WHERE r.id=? FOR UPDATE',[reversal.redemption_id]);assert(redemption&&redemption.status==='confirmed','原核销状态已经变化',409);assert(redemption.coupon_order_id===reference.biz_order_no,'共享核销与原支付订单归属不一致',409);
 if(typeof service.allowed==='function')await service.allowed(c,principal,'commerce.fund.review',{merchant_id:redemption.merchant_id,city_id:redemption.city_id});
 assert(redemption.coupon_status==='redeemed','卡券已进入其他售后流程，不能恢复可核销状态',409);
 const [recognition]=await rows(c,'SELECT * FROM commerce_ledger_events WHERE event_key=?',['recognition:'+reference.context_id+':'+reference.recognition_id]);assert(recognition,'缺少原核销账务事件，不可猜测冲账',409);
 const economicEvents=[recognition];
 const adjustments=await rows(c,"SELECT a.id FROM commerce_settlement_adjustments a JOIN commerce_settlement_items i ON i.id=a.item_id WHERE i.unit_id=? AND a.status='APPLIED' AND a.kind='ENTITLEMENT_ADJUSTMENT'",[unit.id]);
 for(const adjustment of adjustments){const [event]=await rows(c,'SELECT * FROM commerce_ledger_events WHERE event_key=?',['adjustment:'+adjustment.id]);assert(event,'已批准金额调整缺少账务事件',409);economicEvents.push(event);}
 const entries=[],recoverySnapshots=[];
 for(const event of economicEvents)for(const line of parse(event.payload).lines)entries.push({...line,side:line.side==='debit'?'credit':'debit'});
 for(const line of lines.filter(l=>l.status==='SUCCEEDED')) {
  const item=items.find(i=>String(i.id)===String(line.item_id));
  assert(['merchant','promoter','platform_transfer'].includes(item.line_kind),'此组件必须通过独立业务撤销',409);
  const internal=line.effect_kind==='PLATFORM_TRANSFER';
  const principalMinor=BigInt(line.amount_minor)-(internal?0n:BigInt(line.bank_returned_minor)),recovered=BigInt(line.returned_minor);
  assert(principalMinor>=recovered,'原执行回收历史不守恒',409);
  if(principalMinor>0n) {
   const recoveryId=id();recoverySnapshots.push({id:recoveryId,original_execution_line_id:line.id,party_id:item.beneficiary_party_id,recovery_kind:internal?'INTERNAL_RETURN':'BENEFICIARY',principal_minor:principalMinor.toString(),initial_recovered_minor:recovered.toString()});
   await c.execute('INSERT INTO commerce_shared_recovery_cases(id,context_id,unit_id,original_execution_line_id,reversal_id,party_id,recovery_kind,principal_minor,recovered_minor,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[recoveryId,reference.context_id,unit.id,line.id,reversal.id,item.beneficiary_party_id,internal?'INTERNAL_RETURN':'BENEFICIARY',principalMinor.toString(),recovered.toString(),principalMinor===recovered?'RECOVERED':'OPEN',String(reversal.reason||note).slice(0,1000),sqlDate(),sqlDate()]);
   if(!internal){entries.push({account:'settlement_recovery:'+line.id,side:'debit',amount_minor:principalMinor.toString()},{account:'payable:'+item.beneficiary_party_id,side:'credit',amount_minor:principalMinor.toString()});}
  }
 }
 const itemCancellations=items.map(item=>({item_id:String(item.id),amount_minor:(BigInt(item.payable_minor)-BigInt(item.discharged_minor)-BigInt(item.cancelled_minor)-BigInt(item.offset_minor)).toString()})).filter(item=>BigInt(item.amount_minor)>0n);
 await postLedger(c,{event_key:'shared-reversal:'+String(reversal.id),context_id:reference.context_id,source_type:'shared_reversal',source_id:String(reversal.id),rule_ref:unit.id,memo:'误核销撤销；不将追偿应收当作机构实收',item_cancellations:itemCancellations,recovery_cases:recoverySnapshots,lines:entries});
 for(const item of items){const rest=BigInt(item.payable_minor)-BigInt(item.discharged_minor)-BigInt(item.cancelled_minor)-BigInt(item.offset_minor);assert(rest>=0n,'原应付清偿超额',409);await c.execute("UPDATE commerce_settlement_items SET cancelled_minor=cancelled_minor+?,revision=revision+1,authorization_id=NULL,hold_reason='原核销已撤销',status='REVERSED' WHERE id=?",[rest.toString(),item.id]);await c.execute("UPDATE commerce_settlement_authorizations SET status='REVOKED' WHERE item_id=? AND status IN ('ACTIVE','AUTHORIZED')",[item.id]);await c.execute("UPDATE commerce_settlement_approval_instances SET status='SUPERSEDED' WHERE item_id=? AND status='PENDING'",[item.id]);await c.execute("UPDATE commerce_settlement_adjustments SET status='SUPERSEDED' WHERE item_id=? AND status='PENDING'",[item.id]);}
 await c.execute("UPDATE commerce_settlement_units SET status='REVERSED' WHERE id=?",[unit.id]);
 await c.execute("UPDATE commerce_redemptions SET status='reversed',reversed_at=UTC_TIMESTAMP() WHERE id=?",[redemption.id]);await c.execute("UPDATE commerce_coupons SET status='available',token_hash=NULL,token_expires_at=NULL WHERE id=?",[redemption.coupon_id]);
 await c.execute("UPDATE commerce_redemption_reversals SET status='approved',reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[principal.account.id,note,reversal.id]);
 await service.audit(c,principal,'reversal.apply',reversal.reversal_no,{redemption_id:redemption.id,unit_id:unit.id,shared:true},{city_id:redemption.city_id,merchant_id:redemption.merchant_id});return {id:reversal.id,status:'approved',unit_id:unit.id,shared:true};
}
function createReversals({pool,authorize}) {
 async function listRecoveries(p,input={}){const cases=await rows(pool,'SELECT r.*,c.biz_type,c.payment_mode,c.party_id context_party_id FROM commerce_shared_recovery_cases r JOIN commerce_settlement_business_contexts c ON c.id=r.context_id ORDER BY r.created_at DESC LIMIT 500'),out=[];for(const r of cases){try{await authorize(p,'settlement.fund.read',{...r,party_id:r.context_party_id});out.push({...r,outstanding_minor:(BigInt(r.principal_minor)-BigInt(r.recovered_minor)).toString()});}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 return {listRecoveries};
}
module.exports={ddl,migrate,applySharedReversal,recordRecovery,createReversals};
