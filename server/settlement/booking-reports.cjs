'use strict';
const {rows,parse,id,hash,transaction,sqlDate}=require('./primitives.cjs');
const {registerContext}=require('./business.cjs');
const bookingPolicy=require('./booking-policy.cjs');
function dateOnly(value){return value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);}
function yuan(value){if(value==null)return null;const m=String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);return m?(BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0'))).toString():null;}
async function sync(pool,{limit=500,after_id=0,now=Date.now}={}){
 const exists=await rows(pool,"SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='booking_orders'");if(!exists.length)return {count:0,has_more:false};
 // 品类（民宿/长租）来自 projects.channel；隔离库没有 projects 表时保持 NULL，不阻塞对账同步。
 const hasProjects=(await rows(pool,"SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects'")).length>0;
 const orders=await rows(pool,"SELECT o.*,"+(hasProjects?'p.channel':'NULL AS channel')+",b.party_id FROM booking_orders o "+(hasProjects?'LEFT JOIN projects p ON p.id=o.project_id ':'')+"JOIN commerce_settlement_party_bindings b ON b.source_domain='booking' AND b.source_entity_type='vendor' AND b.source_entity_id COLLATE utf8mb4_general_ci=CAST(o.owner_vendor_id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci AND b.status='approved' WHERE o.id>? ORDER BY o.id LIMIT ?",[String(after_id),String(Math.min(500,Number(limit)))]);
 for(const observed of orders)await transaction(pool,async c=>{
  const [current]=await rows(c,'SELECT * FROM booking_orders WHERE id=? FOR UPDATE',[observed.id]);if(!current)return;const o={...current,channel:observed.channel,party_id:observed.party_id};
  const config=parse(o.payment_config_snapshot),fallback={id:String(o.id),order_no:o.order_no,checkin:dateOnly(o.checkin),checkout:dateOnly(o.checkout),rooms:Number(o.rooms||1),commission_rate:o.commission_rate==null?null:String(o.commission_rate),commission_fee:o.commission_fee==null?null:String(o.commission_fee),price_total:String(o.price_total)};
  const category=bookingPolicy.categoryOf(o.channel)??config.booking?.category??null,booking={...(config.booking||fallback),category,category_label:bookingPolicy.categoryLabel(category)};
  const ctx=await registerContext(c,{biz_type:'booking',source_order_system:'booking_orders',biz_order_no:o.order_no,party_id:config.settlement_profile?.party_id||o.party_id,payment_mode:o.pay_status==null?'offline':'pay_center',snapshot:{booking,settlement_profile:config.settlement_profile||null,account_id:o.user_id==null?null:String(o.user_id),vendor_id:String(o.owner_vendor_id)}});
  const snapshot={booking,project_id:String(o.project_id),order_status:o.status,pay_status:o.pay_status||'offline',refund_status:o.refund_status||null,quoted_minor:yuan(o.price_total),commission_minor:yuan(o.commission_fee),source_created_at:sqlDate(o.created_at),collection_evidence:ctx.payment_mode==='offline'?'NOT_RECEIVED':o.paid_payment_order_id?'ACCEPTED_PAYMENT_REFERENCE':'NOT_RECEIVED'};
  const fingerprint=hash(snapshot),[prior]=await rows(c,'SELECT snapshot_hash FROM commerce_booking_statement_facts WHERE context_id=? ORDER BY sequence_no DESC LIMIT 1',[ctx.id]);if(prior?.snapshot_hash===fingerprint)return;
  await c.execute('INSERT INTO commerce_booking_statement_facts(id,context_id,snapshot_hash,snapshot,recorded_at) VALUES(?,?,?,?,?)',[id(),ctx.id,fingerprint,JSON.stringify(snapshot),sqlDate(now())]);
 });
 return {count:orders.length,has_more:orders.length===Math.min(500,Number(limit)),next_after_id:orders.length?String(orders.at(-1).id):String(after_id)};
}
async function source(c,scope,asOf){
 if(!scope.biz_types.includes('booking'))return [];
 const facts=await rows(c,"SELECT f.*,x.biz_order_no,x.payment_mode,x.execution_scope,x.currency,x.snapshot context_snapshot FROM commerce_booking_statement_facts f JOIN commerce_settlement_business_contexts x ON x.id COLLATE utf8mb4_general_ci=f.context_id COLLATE utf8mb4_general_ci WHERE x.party_id=? AND f.recorded_at<=? ORDER BY f.recorded_at,f.sequence_no",[scope.party_id,asOf]),latest=new Map();
 for(const f of facts){if(!scope.payment_modes.includes(f.payment_mode))continue;const profile=parse(f.context_snapshot).settlement_profile;if(scope.contract_ref&&profile?.contract_ref!==scope.contract_ref)continue;latest.set(f.context_id,f);}
 return [...latest.values()].map(f=>{const s=parse(f.snapshot),category=s.booking?.category??null,label=bookingPolicy.categoryLabel(category);return {line_key:'booking-order:'+f.id,record_type:'BOOKING_ORDER',biz_type:'booking',payment_mode:f.payment_mode,execution_scope:f.execution_scope,order_ref:f.biz_order_no,context_id:f.context_id,currency:f.currency,amount_minor:null,quoted_minor:s.quoted_minor,commission_minor:s.commission_minor,booking:s.booking,category,category_label:label,order_status:s.order_status,pay_status:s.pay_status,refund_status:s.refund_status||null,verification_status:f.payment_mode==='offline'?'PENDING_EVIDENCE':'ORDER_RECORDED',occurred_at:s.source_created_at,received_at:sqlDate(f.recorded_at),note:(label?'品类 '+label+'；':'')+'按订单离店日期 '+s.booking.checkout+'；订单状态 '+s.order_status+(s.refund_status?'；退款状态 '+s.refund_status:'')+'；房费及佣金为下单快照，收付款以资金流水为准'};});
}
module.exports={sync,source,dateOnly,yuan};
