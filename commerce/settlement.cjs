'use strict';
// Settlement closed loop (结算域): per-coupon confirmation → period batches → dual review →
// instrument execution → receipts → reversals/recoveries → reconciliation → conservation invariants.
// Money stays in the sandbox provider mirror (commerce_provider_requests); nothing here claims a real institution.
const crypto=require('node:crypto');
const {assert}=require('./configuration.cjs');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const no=prefix=>prefix+'-'+crypto.randomUUID().replace(/-/g,'').slice(0,16);
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const isPeriod=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'');
const bjToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const openBatchStates=['draft','submitted','approved','frozen'];
const INSTRUMENT={payout:{table:'commerce_payout_instructions',no:'instruction_no'},refund:{table:'commerce_refund_orders',no:'refund_no'}};

// ── migration 004_settlement ──
const ddl=[
 `CREATE TABLE IF NOT EXISTS commerce_ledger_entries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, group_no VARCHAR(48) NOT NULL, side ENUM('debit','credit') NOT NULL,
  account VARCHAR(96) NOT NULL, amount_minor BIGINT NOT NULL, source_type VARCHAR(32) NOT NULL, source_id VARCHAR(48) NOT NULL,
  rule_ref VARCHAR(64) NULL, memo VARCHAR(255) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY group_idx(group_no), KEY source_idx(source_type,source_id), KEY account_idx(account)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_provider_requests (
  request_no VARCHAR(48) PRIMARY KEY, target_type ENUM('payout','refund') NOT NULL, target_id VARCHAR(48) NOT NULL,
  amount_minor BIGINT NOT NULL, simulated VARCHAR(16) NULL, status VARCHAR(16) NOT NULL DEFAULT 'processing',
  paid_at DATETIME NULL, query_count INT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY target_idx(target_type,target_id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_settlement_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, batch_no VARCHAR(48) NOT NULL UNIQUE, kind ENUM('merchant','promoter') NOT NULL,
  merchant_id BIGINT NOT NULL DEFAULT 0, promoter_account_id BIGINT NOT NULL DEFAULT 0, city_id BIGINT NULL,
  period_start DATE NOT NULL, period_end DATE NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'draft',
  item_count INT NOT NULL DEFAULT 0, payable_minor BIGINT NOT NULL DEFAULT 0, offset_minor BIGINT NOT NULL DEFAULT 0,
  pre_freeze_status VARCHAR(16) NULL, submitted_by BIGINT NULL, reviewed_by BIGINT NULL, review_note VARCHAR(1000) NULL,
  executed_at DATETIME NULL, closed_by BIGINT NULL, closed_reason VARCHAR(500) NULL, created_by BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch_period(kind,merchant_id,promoter_account_id,period_start,period_end), KEY state_idx(status)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_settlement_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, batch_id BIGINT NOT NULL, line_kind ENUM('merchant','promoter') NOT NULL,
  redemption_id VARCHAR(40) NOT NULL, coupon_id VARCHAR(40) NOT NULL, order_id VARCHAR(40) NOT NULL,
  merchant_id BIGINT NOT NULL, promoter_account_id BIGINT NULL, city_id BIGINT NOT NULL, rule_ref VARCHAR(64) NOT NULL,
  basis_minor BIGINT NOT NULL, payable_minor BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_settle_once(redemption_id,line_kind), KEY batch_idx(batch_id,status), KEY merchant_idx(merchant_id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_payout_instructions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, instruction_no VARCHAR(48) NOT NULL UNIQUE, batch_id BIGINT NOT NULL UNIQUE,
  request_no VARCHAR(48) NOT NULL UNIQUE, target_kind VARCHAR(16) NOT NULL, merchant_id BIGINT NOT NULL DEFAULT 0,
  promoter_account_id BIGINT NOT NULL DEFAULT 0, amount_minor BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0, fail_reason VARCHAR(500) NULL, submitted_at DATETIME NULL, settled_at DATETIME NULL,
  last_query_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_refund_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, refund_no VARCHAR(48) NOT NULL UNIQUE, case_id VARCHAR(40) NOT NULL UNIQUE,
  coupon_id VARCHAR(40) NOT NULL, order_id VARCHAR(40) NOT NULL, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL,
  city_id BIGINT NOT NULL, amount_minor BIGINT NOT NULL, kind VARCHAR(16) NOT NULL DEFAULT 'unused',
  status VARCHAR(16) NOT NULL DEFAULT 'pending', request_no VARCHAR(48) NOT NULL UNIQUE, retry_count INT NOT NULL DEFAULT 0,
  fail_reason VARCHAR(500) NULL, created_by BIGINT NOT NULL, submitted_at DATETIME NULL, settled_at DATETIME NULL, last_query_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY account_idx(account_id), KEY state_idx(status)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_receipts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, target_type ENUM('payout','refund') NOT NULL, target_id BIGINT NOT NULL,
  request_no VARCHAR(48) NOT NULL, outcome VARCHAR(16) NOT NULL, payload JSON NULL, digest CHAR(64) NOT NULL,
  received_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_receipt(request_no,digest), KEY target_idx(target_type,target_id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_recovery_cases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, recovery_no VARCHAR(48) NOT NULL UNIQUE, debtor_kind ENUM('merchant','promoter') NOT NULL,
  merchant_id BIGINT NOT NULL DEFAULT 0, promoter_account_id BIGINT NOT NULL DEFAULT 0, redemption_id VARCHAR(40) NOT NULL,
  reason VARCHAR(1000) NOT NULL, amount_minor BIGINT NOT NULL, recovered_minor BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'open', close_kind VARCHAR(16) NULL, close_reason VARCHAR(500) NULL,
  closed_by BIGINT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY debtor_idx(debtor_kind,merchant_id,promoter_account_id,status)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_redemption_reversals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, reversal_no VARCHAR(48) NOT NULL UNIQUE, redemption_id VARCHAR(40) NOT NULL UNIQUE,
  reason VARCHAR(1000) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'requested', requested_by BIGINT NOT NULL,
  reviewed_by BIGINT NULL, review_note VARCHAR(1000) NULL, reviewed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_recon_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, recon_no VARCHAR(48) NOT NULL UNIQUE, period_start DATE NOT NULL, period_end DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'completed', total_instructions INT NOT NULL DEFAULT 0, matched_count INT NOT NULL DEFAULT 0,
  diff_count INT NOT NULL DEFAULT 0, created_by BIGINT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY period_idx(period_start,period_end)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_recon_diffs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, recon_id BIGINT NOT NULL, diff_no VARCHAR(48) NOT NULL UNIQUE,
  biz_type VARCHAR(24) NOT NULL, biz_id VARCHAR(48) NOT NULL, kind VARCHAR(24) NOT NULL,
  expected_minor BIGINT NULL, actual_minor BIGINT NULL, detail VARCHAR(1000) NOT NULL, owner_id BIGINT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open', resolution VARCHAR(1000) NULL, closed_by BIGINT NULL,
  closed_reason VARCHAR(500) NULL, closed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_diff(recon_id,biz_type,biz_id,kind), KEY state_idx(status)
 ) ENGINE=InnoDB`,
];
async function migrate(c){
 const [r]=await c.execute('SELECT checksum FROM commerce_migrations WHERE version=?',['004_settlement']);
 const checksum=digest(ddl.join('\n'));
 if(r.length){assert(r[0].checksum===checksum,'结算迁移004校验失败',500);}else{
 for(const sql of ddl)await c.query(sql);
 // MySQL 8 lacks ADD COLUMN IF NOT EXISTS: check information_schema before altering existing tables.
 const alterations=[
  ['commerce_redemptions','COLUMN','status',"ALTER TABLE commerce_redemptions ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'confirmed'"],
  ['commerce_redemptions','COLUMN','reversed_at','ALTER TABLE commerce_redemptions ADD COLUMN reversed_at DATETIME NULL'],
  ['commerce_redemptions','INDEX','state_idx','ALTER TABLE commerce_redemptions ADD KEY state_idx(status,merchant_id)'],
  // 误核销撤销保留原核销记录，撤销后同券可重新履约：唯一约束改为普通索引，改由核销事务在券行锁内防重。
  ['commerce_redemptions','UNIQUE_COUPON','coupon_id','ALTER TABLE commerce_redemptions DROP INDEX coupon_id, ADD KEY coupon_idx(coupon_id)'],
 ];
 for(const [table,type,name,sql] of alterations){
  if(type==='UNIQUE_COUPON'){
   const [idx]=await c.execute('SELECT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',[table,name]);
   if(idx.length&&Number(idx[0].NON_UNIQUE)===0)await c.query(sql);
   continue;
  }
  const info=type==='COLUMN'?'information_schema.COLUMNS':'information_schema.STATISTICS';
  const [rows]=await c.execute(`SELECT 1 FROM ${info} WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND ${type==='COLUMN'?'COLUMN_NAME':'INDEX_NAME'}=? LIMIT 1`,[table,name]);
  if(!rows.length)await c.query(sql);
 }
 await c.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',['004_settlement',checksum]);
 }
 // 005_compensation：已核销服务失败的先行赔付（平台自有资金口径）与应收代偿联动。
 const ddl5=[`CREATE TABLE IF NOT EXISTS commerce_compensation_cases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, compensation_no VARCHAR(48) NOT NULL UNIQUE, case_id VARCHAR(40) NOT NULL UNIQUE,
  coupon_id VARCHAR(40) NOT NULL, order_id VARCHAR(40) NOT NULL, account_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL,
  city_id BIGINT NOT NULL, amount_minor BIGINT NOT NULL, reason VARCHAR(1000) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending', requested_by BIGINT NOT NULL, reviewed_by BIGINT NULL,
  review_note VARCHAR(1000) NULL, reviewed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY state_idx(status)
 ) ENGINE=InnoDB`];
 const [r5]=await c.execute('SELECT checksum FROM commerce_migrations WHERE version=?',['005_compensation']);
 const checksum5=digest(ddl5.join('\n'));
 if(r5.length){assert(r5[0].checksum===checksum5,'结算迁移005校验失败',500);}else{
  for(const sql of ddl5)await c.query(sql);
  await c.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',['005_compensation',checksum5]);
 }
}

// ── append-only balanced ledger ──
async function post(c,{sourceType,sourceId,lines,memo}){
 assert(Array.isArray(lines)&&lines.length>=2,'账务分组至少两行',500,'ledger_shape');
 let debit=0,credit=0;
 for(const l of lines){assert(['debit','credit'].includes(l.side),'账务方向无效',500,'ledger_side');assert(Number.isSafeInteger(l.amount)&&l.amount>0,'账务金额须为正整数分',500,'ledger_amount');l.side==='debit'?debit+=l.amount:credit+=l.amount;}
 assert(debit===credit&&debit>0,'账务分组借贷不平衡',500,'ledger_unbalanced');
 const group=no('LG');
 for(const l of lines)await c.execute('INSERT INTO commerce_ledger_entries(group_no,side,account,amount_minor,source_type,source_id,rule_ref,memo) VALUES(?,?,?,?,?,?,?,?)',[group,l.side,l.account,l.amount,sourceType,sourceId,l.rule_ref||null,l.memo||memo||null]);
 return group;
}
// Redemption confirm posting: liability out, four-way split in. Reversal flips every side.
function confirmLines(r){
 const lines=[{side:'debit',account:'unredeemed_liability',amount:Number(r.allocation_minor)},
  {side:'credit',account:'merchant_payable:'+Number(r.merchant_id),amount:Number(r.supplier_minor)}];
 if(Number(r.channel_minor)>0)lines.push({side:'credit',account:'channel_commission:'+Number(r.source_account_id||0),amount:Number(r.channel_minor)});
 lines.push({side:'credit',account:'platform_retained',amount:Number(r.retained_minor)});
 return lines;
}
const reverseLines=r=>confirmLines(r).map(l=>({side:l.side==='debit'?'credit':'debit',account:l.account,amount:l.amount}));

// ── sandbox provider (institution stand-in; deterministic for acceptance) ──
async function sandboxSubmit(c,input){
 const [old]=await c.execute('SELECT * FROM commerce_provider_requests WHERE request_no=? FOR UPDATE',[input.requestNo]);
 if(old.length){
  const row=old[0];
  assert(row.amount_minor===input.amount&&row.target_type===input.targetType,'机构指令金额或类型与原请求不一致',409,'request_conflict');
  if(row.simulated==='failed')return {status:'failed'};
  if(row.simulated==='paid')return {status:'paid'};
  if(row.simulated==='unknown')return {status:'timeout'};
  return {status:'processing'};
 }
 await c.execute('INSERT INTO commerce_provider_requests(request_no,target_type,target_id,amount_minor,status) VALUES(?,?,?,?,?)',[input.requestNo,input.targetType,input.targetId,input.amount,'processing']);
 return {status:'processing'};
}
async function sandboxSimulate(c,requestNo,result){
 assert(['paid','failed','unknown','clear'].includes(result),'沙箱结果无效');
 const [rows]=await c.execute('SELECT * FROM commerce_provider_requests WHERE request_no=?',[requestNo]);assert(rows.length,'机构指令不存在',404);
 if(result==='clear')await c.execute('UPDATE commerce_provider_requests SET simulated=NULL,status=\'processing\',paid_at=NULL WHERE request_no=?',[requestNo]);
 else if(result==='paid')await c.execute('UPDATE commerce_provider_requests SET simulated=\'paid\',status=\'paid\',paid_at=UTC_TIMESTAMP() WHERE request_no=?',[requestNo]);
 else await c.execute('UPDATE commerce_provider_requests SET simulated=? WHERE request_no=?',[result,requestNo]);
 return sandboxQuery(c,requestNo);
}
async function sandboxQuery(c,requestNo){
 const [rows]=await c.execute('SELECT * FROM commerce_provider_requests WHERE request_no=?',[requestNo]);assert(rows.length,'机构指令不存在',404);
 const row=rows[0];
 await c.execute('UPDATE commerce_provider_requests SET query_count=query_count+1 WHERE request_no=?',[requestNo]);
 return {request_no:requestNo,amount_minor:Number(row.amount_minor),target_type:row.target_type,status:row.simulated==='paid'?'paid':row.simulated==='failed'?'failed':'processing',paid_at:row.paid_at,query_count:Number(row.query_count)+1};
}

// ── instrument (payout instruction / refund order) shared lifecycle ──
async function applyInstrument(c,type,rowId,status,note,controlled=false){
 const table=INSTRUMENT[type].table;
 const [rows]=await c.execute(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[rowId]);assert(rows.length,'指令不存在',404);
 const row=rows[0];
 if(row.status==='paid'&&status!=='paid')assert(false,'指令已回执成功，不能改为失败或未知',409,'receipt_conflict');
 if(['paid','cancelled'].includes(row.status)||(row.status==='failed'&&!controlled))return {id:rowId,status:row.status,unchanged:true};
 if(status==='paid'&&row.status==='failed'&&!controlled)assert(false,'已明确失败的指令不能经回执直接改为成功，请走受控重试',409,'receipt_conflict');
 if(status==='paid'){
  await c.execute(`UPDATE ${table} SET status='paid',settled_at=UTC_TIMESTAMP(),fail_reason=NULL WHERE id=?`,[rowId]);
  if(type==='refund'){
   await c.execute("UPDATE commerce_cases SET status='closed',resolution=CONCAT_WS(' / ',NULLIF(resolution,''),'退款指令已完成原路退回（沙箱回执）') WHERE id=?",[row.case_id]);
   await c.execute("UPDATE commerce_coupons SET status='refunded' WHERE id=? AND status='frozen'",[row.coupon_id]);
   await post(c,{sourceType:'refund',sourceId:row.refund_no,lines:[{side:'debit',account:'unredeemed_liability',amount:Number(row.amount_minor)},{side:'credit',account:'provider_refund_out',amount:Number(row.amount_minor)}],memo:'refund paid '+row.refund_no});
  }else{
   const account=row.target_kind==='merchant'?'merchant_payable:'+row.merchant_id:'channel_commission:'+row.promoter_account_id;
   await post(c,{sourceType:'payout',sourceId:row.instruction_no,lines:[{side:'debit',account,amount:Number(row.amount_minor)},{side:'credit',account:'provider_payout_out',amount:Number(row.amount_minor)}],memo:'payout paid '+row.instruction_no});
   if(row.batch_id)await refreshBatch(c,row.batch_id);
  }
 }
 else if(status==='failed')await c.execute(`UPDATE ${table} SET status='failed',fail_reason=? WHERE id=?`,[note||'机构返回失败',rowId]);
 else if(status==='unknown')await c.execute(`UPDATE ${table} SET status='unknown',last_query_at=UTC_TIMESTAMP() WHERE id=?`,[rowId]);
 else if(status==='submitted')await c.execute(`UPDATE ${table} SET status='submitted',submitted_at=COALESCE(submitted_at,UTC_TIMESTAMP()) WHERE id=?`,[rowId]);
 return {id:rowId,status:status==='paid'?'paid':status};
}
async function refreshBatch(c,batchId){
 const [batches]=await c.execute('SELECT * FROM commerce_settlement_batches WHERE id=? FOR UPDATE',[batchId]);if(!batches.length)return;
 const batch=batches[0];if(batch.status!=='executing')return;
 const [instructions]=await c.execute('SELECT status FROM commerce_payout_instructions WHERE batch_id=?',[batchId]);
 if(instructions.length&&instructions.every(i=>i.status==='paid'))await c.execute("UPDATE commerce_settlement_batches SET status='completed' WHERE id=?",[batchId]);
}

// ── batch generation: one batch per payee per period; uk_settle_once makes double entry impossible ──
async function generateBatches(service,p,input,key){
 assert(['merchant','promoter','both'].includes(input.kind),'账单类型无效');
 assert(isPeriod(input.period_start)&&isPeriod(input.period_end)&&input.period_start<=input.period_end,'账期起止日期无效');
 assert(input.period_end<=bjToday(),'账期尚未结束，不能生成账单');
 return service.tx(c=>service.idem(c,p,'settlement.generate',key,input,async()=>{
  const city=input.city_id?Number(input.city_id):null;
  if(city){const got=await service.get(c,'SELECT id FROM cities WHERE id=?',[city]);assert(got.length,'城市不存在',404);}
  const kinds=input.kind==='both'?['merchant','promoter']:[input.kind];
  const summary=[];let added=0;
  for(const kind of kinds){
   const args=[input.period_start,input.period_end];
   let citySql='';
   if(city){citySql=' AND r.city_id=?';args.push(city);}
   const sourceSql=kind==='promoter'?' AND o.source_account_id IS NOT NULL':'';
   const candidates=await service.get(c,
    `SELECT r.id redemption_id,r.coupon_id,r.merchant_id,r.city_id,r.supplier_minor,r.channel_minor,cc.order_id,cc.allocation_minor basis_minor,cc.snapshot,o.source_account_id,
     JSON_UNQUOTE(JSON_EXTRACT(oi.snapshot,'$.rule_id')) rule_id,JSON_EXTRACT(oi.snapshot,'$.rule_version') rule_version
     FROM commerce_redemptions r JOIN commerce_coupons cc ON cc.id=r.coupon_id JOIN commerce_orders o ON o.id=cc.order_id JOIN commerce_order_items oi ON oi.id=cc.item_id
     WHERE r.status='confirmed' AND NOT (JSON_EXTRACT(cc.snapshot,'$.is_demo') <=> TRUE)${sourceSql}
     AND DATE(CONVERT_TZ(r.created_at,'+00:00','+08:00')) BETWEEN ? AND ?${citySql}
     AND NOT EXISTS (SELECT 1 FROM commerce_settlement_items i WHERE i.redemption_id=r.id AND i.line_kind=?)`,
    [...args,kind]);
   const groups=new Map();
   for(const r of candidates){
    const payee=kind==='merchant'?Number(r.merchant_id):Number(r.source_account_id);
    if(!groups.has(payee))groups.set(payee,[]);
    groups.get(payee).push(r);
   }
   for(const [payee,rows] of groups){
    const [existing]=await c.execute('SELECT * FROM commerce_settlement_batches WHERE kind=? AND merchant_id=? AND promoter_account_id=? AND period_start=? AND period_end=? FOR UPDATE',
     [kind,kind==='merchant'?payee:0,kind==='promoter'?payee:0,input.period_start,input.period_end]);
    let batch;
    if(existing.length){
     batch=existing[0];
     assert(openBatchStates.includes(batch.status),'收款方 '+payee+' 本期账单已执行或关账，不能追加',409,'batch_locked');
    }else{
     const batchNo=no('SB');
     const [r1]=await c.execute('INSERT INTO commerce_settlement_batches(batch_no,kind,merchant_id,promoter_account_id,city_id,period_start,period_end,created_by) VALUES(?,?,?,?,?,?,?,?)',
      [batchNo,kind,kind==='merchant'?payee:0,kind==='promoter'?payee:0,city,input.period_start,input.period_end,p.account.id]);
     batch={id:r1.insertId,batch_no:batchNo,kind};
    }
    let batchAdded=0;
    for(const r of rows){
     const payable=Number(kind==='merchant'?r.supplier_minor:r.channel_minor);
     const ruleRef='rule:'+r.rule_id+'.v'+(r.rule_version??'?');
     const [ins]=await c.execute(`INSERT IGNORE INTO commerce_settlement_items
      (batch_id,line_kind,redemption_id,coupon_id,order_id,merchant_id,promoter_account_id,city_id,rule_ref,basis_minor,payable_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [batch.id,kind,r.redemption_id,r.coupon_id,r.order_id,r.merchant_id,kind==='promoter'?Number(r.source_account_id):null,r.city_id,ruleRef,Number(r.basis_minor),payable]);
     if(ins.affectedRows){batchAdded++;added++;}
    }
    await recomputeBatch(c,batch.id);
    const [after]=await c.execute('SELECT item_count,payable_minor FROM commerce_settlement_batches WHERE id=?',[batch.id]);
    summary.push({batch_id:batch.id,batch_no:batch.batch_no,kind,payee_id:payee,items_added:batchAdded,item_count:Number(after[0].item_count),payable_minor:Number(after[0].payable_minor)});
   }
   if(!summary.some(s=>s.kind===kind)){
    // 没有新增候选时回显该期既有批次：重复生成是空操作而不是错误。
    const existing=await c.execute('SELECT id,batch_no,kind,merchant_id,promoter_account_id,item_count,payable_minor FROM commerce_settlement_batches WHERE kind=? AND period_start=? AND period_end=?'+(city?' AND city_id=?':''),
     city?[kind,input.period_start,input.period_end,city]:[kind,input.period_start,input.period_end]);
    for(const b of existing[0])summary.push({batch_id:b.id,batch_no:b.batch_no,kind,payee_id:b.kind==='merchant'?b.merchant_id:b.promoter_account_id,items_added:0,item_count:Number(b.item_count),payable_minor:Number(b.payable_minor)});
   }
  }
  assert(added>0||summary.length>0,'本期没有可结算的已确认核销明细',409,'nothing_to_settle');
  await service.audit(c,p,'settlement.generate',input.kind+'/'+input.period_start+'..'+input.period_end,{items_added:added,batches:summary.length},city!==null?{city_id:city}:{});
  return {items_added:added,batches:summary};
 }));
}
async function recomputeBatch(c,batchId){
 await c.execute(`UPDATE commerce_settlement_batches b SET
  b.item_count=(SELECT COUNT(*) FROM commerce_settlement_items i WHERE i.batch_id=b.id AND i.status='pending'),
  b.payable_minor=(SELECT COALESCE(SUM(i.payable_minor),0) FROM commerce_settlement_items i WHERE i.batch_id=b.id AND i.status='pending')
  WHERE b.id=? AND b.status IN ('draft','submitted','approved','frozen')`,[batchId]);
}
async function loadBatch(c,key,scope){
 const [rows]=await c.execute('SELECT * FROM commerce_settlement_batches WHERE id=? FOR UPDATE',[key]);assert(rows.length,'结算批次不存在',404);
 const batch=rows[0];
 if(scope&&scope.level==='city')assert(!batch.city_id||scope.cityIds.includes(Number(batch.city_id)),'批次不在授权城市内',403);
 return batch;
}
const TRANSITIONS={freeze:{from:['draft','submitted','approved','executing']},unfreeze:{from:['frozen']},submit:{from:['draft']},execute:{from:['approved']},close:{from:['executing','frozen']}};
async function batchAction(service,p,perm,key,input,action){
 const scope=service.scope(p,perm);
 return service.tx(async c=>{
  const batch=await loadBatch(c,key,scope);
  if(action==='review'){
   assert(input.action==='approve'||input.action==='reject','复核动作无效');
   assert(batch.status==='submitted','批次不在待复核状态',409,'batch_state');
   assert(batch.submitted_by&&Number(batch.submitted_by)!==Number(p.account.id),'申请人不能复核自己的结算批次',403,'review_separation');
   assert(typeof input.note==='string'&&input.note.trim().length>=2,'请填写复核意见');
   await c.execute('UPDATE commerce_settlement_batches SET status=?,reviewed_by=?,review_note=? WHERE id=?',[input.action==='approve'?'approved':'draft',p.account.id,input.note.trim(),key]);
   await service.audit(c,p,'settlement.review',batch.batch_no,{action:input.action,note:input.note.trim()},{city_id:batch.city_id,merchant_id:batch.merchant_id||null});
   return batchView(c,key);
  }
  const rule=TRANSITIONS[action];assert(rule,'结算操作无效',404);
  assert(rule.from.includes(batch.status),'批次当前状态不能执行该操作',409,'batch_state');
  if(['freeze','unfreeze','close'].includes(action))assert(typeof input.reason==='string'&&input.reason.trim().length>=2,'请填写操作原因');
  if(action==='freeze')await c.execute('UPDATE commerce_settlement_batches SET status=\'frozen\',pre_freeze_status=? WHERE id=?',[batch.status,key]);
  if(action==='unfreeze')await c.execute('UPDATE commerce_settlement_batches SET status=?,pre_freeze_status=NULL WHERE id=?',[batch.pre_freeze_status||'draft',key]);
  if(action==='submit')await c.execute("UPDATE commerce_settlement_batches SET status='submitted',submitted_by=? WHERE id=?",[p.account.id,key]);
  if(action==='close'){
   const [instructions]=await c.execute('SELECT status FROM commerce_payout_instructions WHERE batch_id=?',[key]);
   assert(instructions.every(i=>['paid','failed','cancelled'].includes(i.status)),'批次仍有未完结指令，不能关账',409,'batch_state');
   await c.execute("UPDATE commerce_settlement_batches SET status='closed',closed_by=?,closed_reason=? WHERE id=?",[p.account.id,input.reason.trim(),key]);
  }
  if(action==='execute')await executeBatch(c,service,p,batch,input);
  await service.audit(c,p,'settlement.'+action,batch.batch_no,{reason:input.reason||input.note||null,offset_recovery:input.offset_recovery??null},{city_id:batch.city_id,merchant_id:batch.merchant_id||null});
  return batchView(c,key);
 });
}
async function executeBatch(c,service,p,batch,input){
 const [items]=await c.execute("SELECT COALESCE(SUM(payable_minor),0) total FROM commerce_settlement_items WHERE batch_id=? AND status='pending'",[batch.id]);
 const payable=Number(items[0].total);
 assert(payable>0,'批次没有可结算明细（可能已全部冲回）',409,'nothing_to_settle');
 let offset=0;
 if(batch.kind==='merchant'&&input.offset_recovery!==false){
  const [recoveries]=await c.execute("SELECT * FROM commerce_recovery_cases WHERE debtor_kind='merchant' AND merchant_id=? AND status='open' AND amount_minor>recovered_minor ORDER BY id FOR UPDATE",[batch.merchant_id]);
  let capacity=payable;
  for(const rec of recoveries){
   if(capacity<=0)break;
   const use=Math.min(Number(rec.amount_minor)-Number(rec.recovered_minor),capacity);
   if(use<=0)continue;
   await c.execute("UPDATE commerce_recovery_cases SET recovered_minor=recovered_minor+?,status='closed',close_kind='offset',close_reason=?,closed_by=? WHERE id=?",[use,'在结算批次'+batch.batch_no+'应结中抵扣',p.account.id,rec.id]);
   await post(c,{sourceType:'recovery',sourceId:rec.recovery_no,lines:[{side:'debit',account:'merchant_payable:'+batch.merchant_id,amount:use},{side:'credit',account:'recovery_settlement',amount:use}],memo:'offset in '+batch.batch_no});
   capacity-=use;offset+=use;
  }
 }
 const amount=payable-offset;
 if(amount<=0){
  // 应结被追偿全额抵扣：无款可付，批次直接完成（无指令、无机构请求）。
  await c.execute("UPDATE commerce_settlement_batches SET status='completed',executed_at=UTC_TIMESTAMP(),offset_minor=?,closed_reason='应结被追偿全额抵扣，无付款指令' WHERE id=?",[offset,batch.id]);
  return {offset,amount:0,fully_offset:true};
 }
 const instructionNo=no('PI'),requestNo=no('PR');
 const submit=await sandboxSubmit(c,{requestNo,targetType:'payout',targetId:instructionNo,amount});
 await c.execute(`INSERT INTO commerce_payout_instructions(instruction_no,batch_id,request_no,target_kind,merchant_id,promoter_account_id,amount_minor,status) VALUES(?,?,?,?,?,?,?,?)`,
  [instructionNo,batch.id,requestNo,batch.kind,batch.merchant_id,batch.promoter_account_id,amount,submit.status==='timeout'?'unknown':'submitted']);
 await c.execute("UPDATE commerce_settlement_batches SET status='executing',executed_at=UTC_TIMESTAMP(),offset_minor=? WHERE id=?",[offset,batch.id]);
}
async function batchView(c,key){
 const [batches]=await c.execute('SELECT b.*,mb.name merchant_name FROM commerce_settlement_batches b LEFT JOIN commerce_merchants mb ON mb.id=b.merchant_id WHERE b.id=?',[key]);
 assert(batches.length,'结算批次不存在',404);
 const batch=batches[0];
 const items=(await c.execute('SELECT i.*,JSON_UNQUOTE(JSON_EXTRACT(cc.snapshot,\'$.sku.name\')) sku_name FROM commerce_settlement_items i LEFT JOIN commerce_coupons cc ON cc.id=i.coupon_id WHERE i.batch_id=? ORDER BY i.id',[key]))[0];
 const instructions=(await c.execute('SELECT * FROM commerce_payout_instructions WHERE batch_id=? ORDER BY id',[key]))[0];
 let payeeName=batch.merchant_name||null;
 if(batch.kind==='promoter'&&!payeeName){const [accounts]=await c.execute('SELECT display_name FROM accounts WHERE id=?',[batch.promoter_account_id]);payeeName=accounts[0]?.display_name||null;}
 return {...batch,payee_name:payeeName,items:items.map(i=>({id:i.id,line_kind:i.line_kind,redemption_id:i.redemption_id,coupon_id:i.coupon_id,order_id:i.order_id,rule_ref:i.rule_ref,basis_minor:i.basis_minor,payable_minor:i.payable_minor,status:i.status,sku_name:i.sku_name})),instructions};
}

// ── receipts (idempotent by digest), query (UNKNOWN → original request only), controlled retry ──
async function ingestReceipt(service,p,input){
 assert(typeof input.request_no==='string'&&/^PR-[0-9a-f]{16}$/.test(input.request_no),'回执请求号无效');
 assert(['paid','failed','unknown'].includes(input.outcome),'回执结果无效');
 return service.tx(async c=>{
  const payloadDigest=digest({request_no:input.request_no,outcome:input.outcome,payload:input.payload||null});
  const [dupe]=await c.execute('SELECT id FROM commerce_receipts WHERE request_no=? AND digest=?',[input.request_no,payloadDigest]);
  if(dupe.length)return {deduplicated:true,receipt_id:dupe[0].id};
  let type,row;
  let [rows]=await c.execute('SELECT * FROM commerce_payout_instructions WHERE request_no=? FOR UPDATE',[input.request_no]);
  if(rows.length){type='payout';row=rows[0];}
  else{
   [rows]=await c.execute('SELECT * FROM commerce_refund_orders WHERE request_no=? FOR UPDATE',[input.request_no]);
   assert(rows.length,'回执请求号未匹配到任何付款或退款指令',404,'unknown_request');
   type='refund';row=rows[0];
  }
  const applied=await applyInstrument(c,type,row.id,input.outcome,input.note);
  await c.execute('INSERT INTO commerce_receipts(target_type,target_id,request_no,outcome,payload,digest,received_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())',
   [type,row.id,input.request_no,input.outcome,JSON.stringify(input.payload||null),payloadDigest]);
  if(input.outcome!=='unknown')await sandboxSimulate(c,input.request_no,input.outcome==='paid'?'paid':'failed'); // institution mirror follows accepted receipts
  await service.audit(c,p,'settlement.receipt',input.request_no,{outcome:input.outcome,type,applied:applied.status,duplicated:false},{});
  return {deduplicated:false,receipt:{type,request_no:input.request_no,outcome:input.outcome},instrument:applied};
 });
}
async function queryInstrument(service,p,type,key){
 return service.tx(async c=>{
  const table=INSTRUMENT[type].table;
  const [rows]=await c.execute(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[key]);assert(rows.length,'指令不存在',404);
  const row=rows[0];
  assert(['submitted','unknown'].includes(row.status),'只有已提交或结果未知的指令可以查单',409,'instrument_state');
  const remote=await sandboxQuery(c,row.request_no);
  const applied=remote.status==='paid'?await applyInstrument(c,type,row.id,'paid'):remote.status==='failed'?await applyInstrument(c,type,row.id,'failed','机构查单返回失败'):await applyInstrument(c,type,row.id,'unknown');
  if(remote.status==='paid'){
   const payloadDigest=digest({request_no:row.request_no,outcome:'paid',source:'provider-query'});
   const [dupe]=await c.execute('SELECT id FROM commerce_receipts WHERE request_no=? AND digest=?',[row.request_no,payloadDigest]);
   if(!dupe.length)await c.execute('INSERT INTO commerce_receipts(target_type,target_id,request_no,outcome,payload,digest,received_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())',[type,row.id,row.request_no,'paid',JSON.stringify({source:'provider-query',query_count:remote.query_count}),payloadDigest]);
  }
  await service.audit(c,p,'settlement.query',row.request_no,{remote:remote.status,type},{});
  return {request_no:row.request_no,remote_status:remote.status,instrument:applied,query_count:remote.query_count};
 });
}
async function retryInstrument(service,p,type,key){
 return service.tx(async c=>{
  const table=INSTRUMENT[type].table;
  const [rows]=await c.execute(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[key]);assert(rows.length,'指令不存在',404);
  const row=rows[0];
  assert(row.status==='failed','只有明确失败的指令可以重试',409,'instrument_state');
  assert(row.retry_count<3,'重试已达上限，请人工核实机构结果或关账',409,'retry_exhausted');
  await c.execute(`UPDATE ${table} SET retry_count=retry_count+1 WHERE id=?`,[key]);
  const submit=await sandboxSubmit(c,{requestNo:row.request_no,targetType:type,targetId:row[INSTRUMENT[type].no],amount:row.amount_minor});
  const applied=submit.status==='paid'?await applyInstrument(c,type,row.id,'paid',undefined,true):submit.status==='failed'?{id:row.id,status:'failed'}:submit.status==='timeout'?await applyInstrument(c,type,row.id,'unknown'):await applyInstrument(c,type,row.id,'submitted');
  await service.audit(c,p,'settlement.retry',row.request_no,{retry:row.retry_count+1,submit:submit.status},{});
  return {request_no:row.request_no,retry_count:row.retry_count+1,instrument:applied};
 });
}
async function listInstructions(service,p,query){
 let where='1=1',args=[];
 if(query.batch_id){where+=' AND batch_id=?';args.push(Number(query.batch_id));}
 if(['pending','submitted','paid','failed','unknown','cancelled'].includes(query.status)){where+=' AND status=?';args.push(query.status);}
 return {rows:await service.get(service.pool,`SELECT * FROM commerce_payout_instructions WHERE ${where} ORDER BY id DESC LIMIT 200`,args)};
}

// ── refund instruments (原路退回执行) ──
async function createRefundOrder(service,p,input,key){
 assert(typeof input.case_id==='string'&&/^[0-9a-f-]{36}$/.test(input.case_id),'售后单编号无效');
 return service.tx(c=>service.idem(c,p,'refund.create',key,input,async()=>{
  const [dupe]=await c.execute('SELECT id,refund_no,status FROM commerce_refund_orders WHERE case_id=?',[input.case_id]);
  if(dupe.length)return {id:dupe[0].id,refund_no:dupe[0].refund_no,status:dupe[0].status,existing:true};
  const [cases]=await c.execute('SELECT * FROM commerce_cases WHERE id=? FOR UPDATE',[input.case_id]);assert(cases.length,'售后单不存在',404);
  const cs=cases[0];
  assert(cs.kind==='refund','仅退款工单可以建立退款指令',409,'case_kind');
  assert(cs.status==='awaiting_provider','售后单不在待退款通道状态',409,'case_state');
  const [coupons]=await c.execute('SELECT * FROM commerce_coupons WHERE id=? FOR UPDATE',[cs.coupon_id]);assert(coupons.length,'卡券不存在',404);
  const coupon=coupons[0],snapshot=parse(coupon.snapshot);
  assert(snapshot.is_demo!==true,'演示卡券不发生资金退款',409,'demo_excluded');
  assert(coupon.status==='frozen','卡券应处于退款冻结状态',409,'coupon_state');
  const [orders]=await c.execute('SELECT id FROM commerce_orders WHERE id=?',[coupon.order_id]);assert(orders.length,'原订单缺失',409);
  const refundNo=no('RF'),requestNo=no('PR');
  const kind=/到期|expiry|自动/.test(cs.reason||'')?'expiry':'unused';
  const [r]=await c.execute(`INSERT INTO commerce_refund_orders
   (refund_no,case_id,coupon_id,order_id,account_id,merchant_id,city_id,amount_minor,kind,request_no,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
   [refundNo,input.case_id,coupon.id,coupon.order_id,coupon.account_id,coupon.merchant_id,coupon.city_id,coupon.allocation_minor,kind,requestNo,p.account.id]);
  await service.audit(c,p,'refund.create',refundNo,{case_id:input.case_id,amount:coupon.allocation_minor,kind},{city_id:coupon.city_id,merchant_id:coupon.merchant_id});
  return {id:r.insertId,refund_no:refundNo,status:'pending'};
 }));
}
async function refundAction(service,p,key,action,input){
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_refund_orders WHERE id=? FOR UPDATE',[key]);assert(rows.length,'退款指令不存在',404);
  const row=rows[0];
  if(action==='cancel'){
   assert(row.status==='pending','仅待执行退款可以作废',409,'refund_state');
   assert(typeof input.reason==='string'&&input.reason.trim().length>=2,'请填写作废原因');
   await c.execute("UPDATE commerce_refund_orders SET status='cancelled' WHERE id=?",[key]);
   await service.audit(c,p,'refund.cancel',row.refund_no,{reason:input.reason.trim()},{city_id:row.city_id,merchant_id:row.merchant_id});
   return {id:Number(key),status:'cancelled'};
  }
  if(action==='execute'){
   assert(row.status==='pending','退款指令不在待执行状态',409,'refund_state');
   const submit=await sandboxSubmit(c,{requestNo:row.request_no,targetType:'refund',targetId:row.refund_no,amount:row.amount_minor});
   const applied=submit.status==='timeout'?await applyInstrument(c,'refund',row.id,'unknown'):submit.status==='paid'?await applyInstrument(c,'refund',row.id,'paid'):submit.status==='failed'?await applyInstrument(c,'refund',row.id,'failed','机构返回失败'):await applyInstrument(c,'refund',row.id,'submitted');
   await service.audit(c,p,'refund.execute',row.refund_no,{submit:submit.status},{city_id:row.city_id,merchant_id:row.merchant_id});
   return {id:Number(key),request_no:row.request_no,submit:submit.status,instrument:applied};
  }
  assert(false,'退款操作无效',404);
 });
}

// ── reversal of a mistaken redemption (误核销撤销): dual control, history preserved ──
async function requestReversal(service,p,input,key){
 assert(typeof input.redemption_id==='string'&&/^[0-9a-f-]{36}$/.test(input.redemption_id),'核销记录编号无效');
 assert(typeof input.reason==='string'&&input.reason.trim().length>=5&&input.reason.length<=1000,'请填写撤销原因（5-1000字）');
 return service.tx(c=>service.idem(c,p,'reversal.request',key,input,async()=>{
  const [dupe]=await c.execute('SELECT id FROM commerce_redemption_reversals WHERE redemption_id=? AND status<>\'rejected\'',[input.redemption_id]);
  assert(!dupe.length,'该核销已有撤销申请或已撤销',409,'reversal_exists');
  const [rows]=await c.execute('SELECT r.*,cc.snapshot coupon_snapshot FROM commerce_redemptions r JOIN commerce_coupons cc ON cc.id=r.coupon_id WHERE r.id=? FOR UPDATE',[input.redemption_id]);
  assert(rows.length,'核销记录不存在',404);
  const r=rows[0];
  assert(r.status==='confirmed','仅已确认核销可以申请撤销',409,'redemption_state');
  assert(parse(r.coupon_snapshot).is_demo!==true,'演示核销不进入资金域',409,'demo_excluded');
  const reversalNo=no('RV');
  const [ins]=await c.execute('INSERT INTO commerce_redemption_reversals(reversal_no,redemption_id,reason,requested_by) VALUES(?,?,?,?)',[reversalNo,input.redemption_id,input.reason.trim(),p.account.id]);
  await service.audit(c,p,'reversal.request',reversalNo,{redemption_id:input.redemption_id},{city_id:r.city_id,merchant_id:r.merchant_id});
  return {id:ins.insertId,reversal_no:reversalNo,status:'requested'};
 }));
}
async function reviewReversal(service,p,key,input){
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_redemption_reversals WHERE id=? FOR UPDATE',[key]);assert(rows.length,'撤销申请不存在',404);
  const reversal=rows[0];
  assert(reversal.status==='requested','该申请已处理',409,'reversal_state');
  assert(Number(reversal.requested_by)!==Number(p.account.id),'申请人不能复核自己的撤销申请',403,'review_separation');
  assert(typeof input.note==='string'&&input.note.trim().length>=2,'请填写复核意见');
  if(input.action!=='approve'){
   await c.execute("UPDATE commerce_redemption_reversals SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[p.account.id,input.note.trim(),key]);
   await service.audit(c,p,'reversal.review',reversal.reversal_no,{action:'rejected'},{});
   return {id:key,status:'rejected'};
  }
  await applyReversal(c,service,p,reversal,input.note.trim());
  return {id:key,status:'approved'};
 });
}
async function applyReversal(c,service,p,reversal,note){
 const [rows]=await c.execute(`SELECT r.*,cc.id coupon_id,cc.status coupon_status,cc.snapshot coupon_snapshot,cc.order_id,
  COALESCE(o.source_account_id,0) source_account_id FROM commerce_redemptions r
  JOIN commerce_coupons cc ON cc.id=r.coupon_id LEFT JOIN commerce_orders o ON o.id=cc.order_id WHERE r.id=? FOR UPDATE`,[reversal.redemption_id]);
 assert(rows.length,'核销记录缺失',409,'redemption_missing');
 const r=rows[0];
 assert(r.status==='confirmed','核销状态已变化，撤销失败',409,'redemption_state');
 await post(c,{sourceType:'reversal',sourceId:reversal.reversal_no,lines:reverseLines(r),memo:'reverse redemption '+reversal.redemption_id});
 await c.execute("UPDATE commerce_redemptions SET status='reversed',reversed_at=UTC_TIMESTAMP() WHERE id=?",[reversal.redemption_id]);
 await c.execute("UPDATE commerce_coupons SET status='available',token_hash=NULL,token_expires_at=NULL WHERE id=? AND status='redeemed'",[r.coupon_id]);
 await c.execute('UPDATE commerce_redemption_reversals SET status=\'approved\',reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?',[p.account.id,note,reversal.id]);
 // Settlement linkage: un-executed batches lose the line; already-committed money becomes a recovery receivable.
 const [items]=await c.execute('SELECT i.*,b.status batch_status FROM commerce_settlement_items i JOIN commerce_settlement_batches b ON b.id=i.batch_id WHERE i.redemption_id=? ORDER BY i.line_kind FOR UPDATE',[reversal.redemption_id]);
 for(const item of items){
  const kind=item.line_kind;
  if(openBatchStates.includes(item.batch_status)){
   await c.execute("UPDATE commerce_settlement_items SET status='reversed' WHERE id=?",[item.id]);
   await recomputeBatch(c,item.batch_id);
  }else{
   await openRecovery(c,kind,kind==='merchant'?item.merchant_id:0,kind==='promoter'?item.promoter_account_id:0,reversal.redemption_id,Number(item.payable_minor),'核销撤销：'+(kind==='merchant'?'商户应结':'渠道佣金')+'所在批次已执行'+(item.batch_status==='completed'?'并完成付款':'，指令未结，需冲抵或追回'));
  }
 }
 await service.audit(c,p,'reversal.apply',reversal.reversal_no,{redemption_id:reversal.redemption_id,basis:Number(r.allocation_minor),supplier:Number(r.supplier_minor),channel:Number(r.channel_minor),retained:Number(r.retained_minor)},{city_id:r.city_id,merchant_id:r.merchant_id});
}
async function openRecovery(c,debtorKind,merchantId,promoterAccountId,redemptionId,amount,reason){
 assert(amount>0,'追偿金额无效',500,'recovery_amount');
 const recoveryNo=no('RC');
 const [r]=await c.execute('INSERT INTO commerce_recovery_cases(recovery_no,debtor_kind,merchant_id,promoter_account_id,redemption_id,reason,amount_minor) VALUES(?,?,?,?,?,?,?)',
  [recoveryNo,debtorKind,merchantId||0,promoterAccountId||0,redemptionId,reason,amount]);
 return {id:r.insertId,recovery_no:recoveryNo,amount_minor:amount};
}
async function listReversals(service,p){
 return {rows:await service.get(service.pool,'SELECT rv.*,r.merchant_id,r.supplier_minor,r.channel_minor,r.status redemption_status FROM commerce_redemption_reversals rv JOIN commerce_redemptions r ON r.id=rv.redemption_id ORDER BY rv.id DESC LIMIT 200',[])};
}

// ── recoveries: cash recovery in / write-off (independent review) ──
const debtorAccount=rec=>rec.debtor_kind==='merchant'?'merchant_payable:'+rec.merchant_id:'channel_commission:'+rec.promoter_account_id;
async function recover(service,p,key,input){
 assert(Number.isSafeInteger(input.amount_minor)&&input.amount_minor>0,'请输入有效的追偿到账金额（分）');
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_recovery_cases WHERE id=? FOR UPDATE',[key]);assert(rows.length,'追偿单不存在',404);
  const rec=rows[0];
  assert(rec.status==='open','追偿单已关闭',409,'recovery_state');
  const rest=Number(rec.amount_minor)-Number(rec.recovered_minor);
  assert(input.amount_minor<=rest,'到账金额超过未追回余额',409,'recovery_amount');
  await c.execute('UPDATE commerce_recovery_cases SET recovered_minor=recovered_minor+? WHERE id=?',[input.amount_minor,key]);
  await post(c,{sourceType:'recovery',sourceId:rec.recovery_no,lines:[{side:'debit',account:'recovery_cash_in',amount:input.amount_minor},{side:'credit',account:debtorAccount(rec),amount:input.amount_minor}],memo:'recovery in cash '+rec.recovery_no});
  const [after]=await c.execute('SELECT amount_minor,recovered_minor FROM commerce_recovery_cases WHERE id=?',[key]);
  const done=Number(after[0].amount_minor)===Number(after[0].recovered_minor);
  if(done)await c.execute('UPDATE commerce_recovery_cases SET status=?,close_kind=?,close_reason=?,closed_by=? WHERE id=?',['closed','recovered',input.note||'追偿到账完毕',p.account.id,key]);
  await service.audit(c,p,'recovery.recover',rec.recovery_no,{amount:input.amount_minor},rec.debtor_kind==='merchant'?{merchant_id:rec.merchant_id}:{});
  return {id:Number(key),recovered_minor:Number(after[0].recovered_minor),status:done?'closed':'open'};
 });
}
async function writeOffRecovery(service,p,key,input){
 assert(typeof input.reason==='string'&&input.reason.trim().length>=5,'请填写核销依据（至少5字）');
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_recovery_cases WHERE id=? FOR UPDATE',[key]);assert(rows.length,'追偿单不存在',404);
  const rec=rows[0];
  assert(rec.status==='open','追偿单已关闭',409,'recovery_state');
  const rest=Number(rec.amount_minor)-Number(rec.recovered_minor);
  assert(rest>0,'无待核销余额',409,'recovery_amount');
  await post(c,{sourceType:'recovery',sourceId:rec.recovery_no,lines:[{side:'debit',account:'bad_debt_expense',amount:rest},{side:'credit',account:debtorAccount(rec),amount:rest}],memo:'write-off '+rec.recovery_no});
  await c.execute('UPDATE commerce_recovery_cases SET recovered_minor=?,status=?,close_kind=?,close_reason=?,closed_by=? WHERE id=?',[rec.amount_minor,'closed','written_off',input.reason.trim(),p.account.id,key]);
  await service.audit(c,p,'recovery.writeoff',rec.recovery_no,{amount:rest},rec.debtor_kind==='merchant'?{merchant_id:rec.merchant_id}:{});
  return {id:Number(key),status:'closed',close_kind:'written_off'};
 });
}
async function listRecoveries(service,p,query){
 let where='1=1',args=[];
 if(['open','closed'].includes(query.status)){where+=' AND status=?';args.push(query.status);}
 return {rows:await service.get(service.pool,`SELECT * FROM commerce_recovery_cases WHERE ${where} ORDER BY id DESC LIMIT 200`,args)};
}

// ── reconciliation: platform instruments ↔ provider bill, differences with owner/processing/closing ──
async function runReconciliation(service,p,input,key){
 assert(isPeriod(input.period_start)&&isPeriod(input.period_end)&&input.period_start<=input.period_end,'对账期间无效');
 return service.tx(c=>service.idem(c,p,'reconciliation.run',key,input,async()=>{
  const reconNo=no('RA');
  const [r]=await c.execute('INSERT INTO commerce_recon_batches(recon_no,period_start,period_end,created_by) VALUES(?,?,?,?)',[reconNo,input.period_start,input.period_end,p.account.id]);
  const reconId=r.insertId;
  const [bills]=await c.execute('SELECT * FROM commerce_provider_requests WHERE DATE(CONVERT_TZ(created_at,\'+00:00\',\'+08:00\')) BETWEEN ? AND ?',[input.period_start,input.period_end]);
  const locals=new Map();
  for(const row of (await c.execute('SELECT * FROM commerce_payout_instructions',[]))[0])locals.set(row.request_no,{type:'payout',row});
  for(const row of (await c.execute('SELECT * FROM commerce_refund_orders',[]))[0])locals.set(row.request_no,{type:'refund',row});
  const diffs=[];let matched=0;
  const addDiff=(bizType,bizId,kind,expected,actual,detail)=>diffs.push({bizType,bizId:String(bizId),kind,expected,actual,detail});
  for(const bill of bills){
   const local=locals.get(bill.request_no);
   if(!local){addDiff('provider_request',bill.request_no,'missing_local',Number(bill.amount_minor),null,'机构账单存在该请求，平台没有对应结算指令（疑似未登记或重复付款）');continue;}
   locals.delete(bill.request_no);
   const row=local.row;
   if(Number(row.amount_minor)!==Number(bill.amount_minor)){addDiff(local.type,row.id,'amount_mismatch',Number(row.amount_minor),Number(bill.amount_minor),'平台指令与机构账单金额不一致');continue;}
   const localPaid=row.status==='paid',remotePaid=bill.simulated==='paid';
   if(localPaid!==remotePaid){addDiff(local.type,row.id,'status_mismatch',localPaid?Number(row.amount_minor):0,remotePaid?Number(bill.amount_minor):0,'平台指令状态与机构账单 paid 标记不一致');continue;}
   matched++;
  }
  for(const [requestNo,rest] of locals){
   if(['submitted','paid','unknown'].includes(rest.row.status))addDiff(rest.type,rest.row.id,'missing_external',Number(rest.row.amount_minor),null,'平台指令已提交，机构账单没有该请求（疑似未送达或账单缺失）');
  }
  for(const d of diffs)await c.execute('INSERT INTO commerce_recon_diffs(recon_id,diff_no,biz_type,biz_id,kind,expected_minor,actual_minor,detail) VALUES(?,?,?,?,?,?,?,?)',[reconId,no('DF'),d.bizType,d.bizId,d.kind,d.expected,d.actual,d.detail]);
  await c.execute('UPDATE commerce_recon_batches SET total_instructions=?,matched_count=?,diff_count=?,status=\'completed\' WHERE id=?',[bills.length,matched,diffs.length,reconId]);
  await service.audit(c,p,'reconciliation.run',reconNo,{period:input.period_start+'..'+input.period_end,bills:bills.length,matched,diffs:diffs.length},{});
  return {recon_id:reconId,recon_no:reconNo,period_start:input.period_start,period_end:input.period_end,total:bills.length,matched,diff_count:diffs.length};
 }));
}
async function reconDetail(service,p,key){
 const batches=await service.get(service.pool,'SELECT * FROM commerce_recon_batches WHERE id=?',[key]);assert(batches.length,'对账批次不存在',404);
 const diffs=await service.get(service.pool,'SELECT d.*,a.display_name owner_name FROM commerce_recon_diffs d LEFT JOIN accounts a ON a.id=d.owner_id WHERE d.recon_id=? ORDER BY d.id',[key]);
 return {...batches[0],diffs};
}
async function listRecons(service,p){
 return {rows:await service.get(service.pool,'SELECT * FROM commerce_recon_batches ORDER BY id DESC LIMIT 100',[])};
}
async function diffAction(service,p,reconId,diffId,input,action){
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_recon_diffs WHERE id=? AND recon_id=? FOR UPDATE',[diffId,reconId]);assert(rows.length,'差异记录不存在',404);
  const diff=rows[0];
  if(action==='close')assert(diff.status==='resolved','差异需先完成处理记录再关闭',409,'diff_state');
  else assert(['open','processing'].includes(diff.status),'差异已关闭',409,'diff_state');
  if(action==='assign'){
   assert(Number.isSafeInteger(input.owner_id),'请指定责任人账号');
   const [accounts]=await c.execute("SELECT id FROM accounts WHERE id=? AND status='active'",[input.owner_id]);assert(accounts.length,'责任人账号不存在',404);
   await c.execute("UPDATE commerce_recon_diffs SET owner_id=?,status='processing' WHERE id=?",[input.owner_id,diffId]);
   await service.audit(c,p,'recon.assign',diff.diff_no,{owner_id:input.owner_id},{});
   return {id:diffId,status:'processing',owner_id:input.owner_id};
  }
  if(action==='resolve'){
   assert(typeof input.note==='string'&&input.note.trim().length>=2,'请填写处理记录');
   assert(diff.owner_id,'请先指定责任人',409,'owner_required');
   await c.execute("UPDATE commerce_recon_diffs SET status='resolved',resolution=? WHERE id=?",[input.note.trim(),diffId]);
   await service.audit(c,p,'recon.resolve',diff.diff_no,{note:input.note.trim()},{});
   return {id:diffId,status:'resolved'};
  }
  if(action==='close'){
   assert(typeof input.reason==='string'&&input.reason.trim().length>=5,'请填写关闭依据（至少5字）');
   assert(diff.status==='resolved','差异需先有处理记录才能关闭',409,'diff_state');
   assert(diff.owner_id&&Number(diff.owner_id)!==Number(p.account.id),'差异关闭需由非责任人的复核人执行',403,'review_separation');
   await c.execute("UPDATE commerce_recon_diffs SET status='closed',closed_by=?,closed_reason=?,closed_at=UTC_TIMESTAMP() WHERE id=?",[p.account.id,input.reason.trim(),diffId]);
   await service.audit(c,p,'recon.close',diff.diff_no,{reason:input.reason.trim()},{});
   return {id:diffId,status:'closed'};
  }
  assert(false,'差异操作无效',404);
 });
}

// ── conservation invariants (goal acceptance #8) ──
async function verifyInvariants(pool){
 const rowsOf=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 const oneRow=async(sql,args=[])=>(await pool.execute(sql,args))[0][0];
 const notDemo=`NOT (JSON_EXTRACT(cc.snapshot,'$.is_demo') <=> TRUE)`;
 const checks=[];
 const groups=await rowsOf(`SELECT group_no FROM commerce_ledger_entries GROUP BY group_no HAVING SUM(CASE WHEN side='debit' THEN amount_minor ELSE 0 END)<>SUM(CASE WHEN side='credit' THEN amount_minor ELSE 0 END)`);
 checks.push({name:'I1 每组借贷平衡',passed:!groups.length,detail:groups.map(g=>g.group_no)});
 const dangling=await rowsOf(`SELECT r.id FROM commerce_redemptions r JOIN commerce_coupons cc ON cc.id=r.coupon_id JOIN commerce_orders o ON o.id=cc.order_id
  WHERE r.status='confirmed' AND ${notDemo} AND (r.supplier_minor+r.beike_minor<>r.allocation_minor OR r.channel_minor+r.retained_minor<>r.beike_minor OR (o.source_account_id IS NULL AND r.channel_minor<>0))`);
 checks.push({name:'I5 逐券计算依据可复算（订单锁定规则快照）',passed:!dangling.length,detail:dangling.map(r=>r.id)});
 const unattributed=await rowsOf(`SELECT i.id FROM commerce_settlement_items i JOIN commerce_orders o ON o.id=i.order_id WHERE i.line_kind='promoter' AND (o.source_account_id IS NULL OR o.source_account_id<>i.promoter_account_id)`);
 checks.push({name:'I6a 无归属订单不产生渠道佣金明细',passed:!unattributed.length,detail:unattributed.map(r=>r.id)});
 const dupItems=await rowsOf('SELECT redemption_id,line_kind,COUNT(*) n FROM commerce_settlement_items GROUP BY redemption_id,line_kind HAVING n>1');
 checks.push({name:'I3 同一明细不重复入账（跨批次防重）',passed:!dupItems.length,detail:dupItems.map(r=>r.redemption_id+':'+r.line_kind)});
 const badItems=await rowsOf(`SELECT i.id FROM commerce_settlement_items i
  JOIN commerce_coupons cc ON cc.id=i.coupon_id
  LEFT JOIN commerce_redemptions r ON r.id=i.redemption_id
  WHERE cc.status<>'redeemed' AND i.status<>'reversed' AND i.payable_minor>0 AND NOT (JSON_EXTRACT(cc.snapshot,'$.is_demo') <=> TRUE)
   AND (r.status<>'reversed' OR NOT EXISTS (SELECT 1 FROM commerce_recovery_cases rc WHERE rc.redemption_id=i.redemption_id AND rc.debtor_kind=i.line_kind))`);
 checks.push({name:'I6b 仅已确认核销进入结算；撤销明细须已冲回或挂追偿',passed:!badItems.length,detail:badItems.map(r=>r.id)});
 const paidDup=await rowsOf(`SELECT source_id,source_type,COUNT(*) n FROM commerce_ledger_entries
  WHERE (account='provider_payout_out' OR account='provider_refund_out') GROUP BY source_id,source_type HAVING n>1`);
 checks.push({name:'I4a 每笔指令最多一次出金过账（重复回执不重复付款）',passed:!paidDup.length,detail:paidDup.map(r=>r.source_id)});
 const orders=await rowsOf(`SELECT id,amount_minor FROM commerce_orders WHERE status='fulfilled' AND NOT (JSON_EXTRACT(snapshot,'$.is_demo') <=> TRUE) LIMIT 500`);
 let conservation=true;const badOrders=[];
 for(const o of orders){
  const row=await oneRow(`SELECT
   (SELECT COALESCE(SUM(r.allocation_minor),0) FROM commerce_redemptions r JOIN commerce_coupons rc ON rc.id=r.coupon_id WHERE rc.order_id=? AND r.status='confirmed') confirmed,
   (SELECT COALESCE(SUM(cc.allocation_minor),0) FROM commerce_coupons cc WHERE cc.order_id=? AND cc.status IN ('available','frozen')) pool,
   (SELECT COALESCE(SUM(ro.amount_minor),0) FROM commerce_refund_orders ro WHERE ro.order_id=? AND ro.status='paid') refunded`,[o.id,o.id,o.id]);
  const confirmed=Number(row.confirmed),pool0=Number(row.pool),refunded=Number(row.refunded);
  if(confirmed+refunded+pool0!==Number(o.amount_minor)){conservation=false;badOrders.push({order:o.id,confirmed,refunded,pool:pool0,amount:Number(o.amount_minor)});}
 }
 checks.push({name:'I2 订单资金守恒（实付=已核销+已退款+未核销池）',passed:conservation,detail:badOrders});
 const paidMirror=await oneRow(`SELECT
  (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_payout_instructions WHERE status='paid') local_paid,
  (SELECT COALESCE(SUM(pr.amount_minor),0) FROM commerce_provider_requests pr JOIN commerce_payout_instructions ins ON ins.request_no=pr.request_no WHERE pr.simulated='paid' AND ins.status='paid') mirror_for_local_paid,
  (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_refund_orders WHERE status='paid') local_refund_paid,
  (SELECT COALESCE(SUM(pr.amount_minor),0) FROM commerce_provider_requests pr JOIN commerce_refund_orders ro ON ro.request_no=pr.request_no WHERE pr.simulated='paid' AND ro.status='paid') mirror_for_local_refund`);
 const mirrorOk=Number(paidMirror.local_paid)===Number(paidMirror.mirror_for_local_paid)&&Number(paidMirror.local_refund_paid)===Number(paidMirror.mirror_for_local_refund);
 checks.push({name:'I4b 本地已付指令逐笔有机构镜像（无重复付款；镜像盈余走对账差异）',passed:mirrorOk,detail:[paidMirror]});
 const closedRefunds=await rowsOf(`SELECT s.id FROM commerce_cases s JOIN commerce_coupons cc ON cc.id=s.coupon_id WHERE s.kind='refund' AND s.status='closed' AND cc.status NOT IN ('refunded') AND ${notDemo}`);
 checks.push({name:'I7 退款结单与卡券状态一致',passed:!closedRefunds.length,detail:closedRefunds.map(r=>r.id)});
 const compWithoutRecovery=await rowsOf(`SELECT cp.compensation_no FROM commerce_compensation_cases cp WHERE cp.status='paid' AND NOT EXISTS (SELECT 1 FROM commerce_recovery_cases rc WHERE rc.reason LIKE CONCAT('%',cp.compensation_no,'%') AND rc.debtor_kind='merchant' AND rc.amount_minor=cp.amount_minor)`);
 checks.push({name:'I8a 每笔先行赔付关联应收商户代偿',passed:!compWithoutRecovery.length,detail:compWithoutRecovery.map(r=>r.compensation_no)});
 const refundMarkedCompensation=await rowsOf(`SELECT cp.compensation_no FROM commerce_compensation_cases cp JOIN commerce_coupons cc ON cc.id=cp.coupon_id WHERE cc.status<>'redeemed'`);
 checks.push({name:'I8b 赔付仅对应已核销卡券（未核销退款不记赔付）',passed:!refundMarkedCompensation.length,detail:refundMarkedCompensation.map(r=>r.compensation_no)});
 return {passed:checks.every(x=>x.passed),checks};
}

// ── four-end views ──
async function overview(service){
 const one=async(sql,args=[])=>(await service.get(service.pool,sql,args))[0];
 const n=v=>Number(v)||0;
 const batches=await one("SELECT COUNT(*) total,SUM(status='draft') draft,SUM(status='submitted') submitted,SUM(status='approved') approved,SUM(status='executing') executing,SUM(status='completed') completed,SUM(status='frozen') frozen,SUM(status='closed') closed FROM commerce_settlement_batches");
 const instructions=await one("SELECT COUNT(*) total,COALESCE(SUM(amount_minor),0) amount,SUM(status='submitted') submitted,SUM(status='unknown') unknown,SUM(status='failed') failed,SUM(status='paid') paid FROM commerce_payout_instructions");
 const refunds=await one("SELECT COUNT(*) total,SUM(status='pending') pending,SUM(status='submitted') submitted,SUM(status='unknown') unknown,SUM(status='failed') failed,SUM(status='refunded') refunded FROM commerce_refund_orders");
 const redemptions=await one(`SELECT COUNT(*) total,COALESCE(SUM(r.supplier_minor),0) supplier_minor,COALESCE(SUM(r.channel_minor),0) channel_minor,SUM(r.status='reversed') reversed FROM commerce_redemptions r JOIN commerce_coupons cc ON cc.id=r.coupon_id WHERE NOT (JSON_EXTRACT(cc.snapshot,'$.is_demo') <=> TRUE)`);
 const recoveries=await one("SELECT COUNT(*) total,COALESCE(SUM(amount_minor-recovered_minor),0) open_minor FROM commerce_recovery_cases WHERE status='open'");
 const compensations=await one("SELECT COUNT(*) total,SUM(status='pending') pending,SUM(status='paid') paid,COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor END),0) paid_minor FROM commerce_compensation_cases");
 const diffs=await one("SELECT COUNT(*) total,SUM(status='open') open,SUM(status='processing') processing FROM commerce_recon_diffs");
 const reversals=await one("SELECT COUNT(*) total,SUM(status='requested') requested FROM commerce_redemption_reversals");
 return {batches:{total:n(batches.total),draft:n(batches.draft),submitted:n(batches.submitted),approved:n(batches.approved),executing:n(batches.executing),completed:n(batches.completed),frozen:n(batches.frozen),closed:n(batches.closed)},
  instructions:{total:n(instructions.total),amount_minor:n(instructions.amount),submitted:n(instructions.submitted),unknown:n(instructions.unknown),failed:n(instructions.failed),paid:n(instructions.paid)},
  refunds:{total:n(refunds.total),pending:n(refunds.pending),submitted:n(refunds.submitted),unknown:n(refunds.unknown),failed:n(refunds.failed),refunded:n(refunds.refunded)},
  redemptions:{total:n(redemptions.total),supplier_minor:n(redemptions.supplier_minor),channel_minor:n(redemptions.channel_minor),reversed:n(redemptions.reversed)},
  recoveries:{total:n(recoveries.total),open_minor:n(recoveries.open_minor)},
  compensations:{total:n(compensations.total),pending:n(compensations.pending),paid:n(compensations.paid),paid_minor:n(compensations.paid_minor)},
  diffs:{total:n(diffs.total),open:n(diffs.open),processing:n(diffs.processing)},
  reversals:{total:n(reversals.total),requested:n(reversals.requested)},
  invariants:await verifyInvariants(service.pool)};
}
async function merchantSettlement(service,p){
 const s=service.scope(p,'commerce.merchant.read');
 assert(s.vendorId,'账号未绑定商户，请联系账号管理员',403);
 const merchants=(await service.get(service.pool,'SELECT id FROM commerce_merchants WHERE vendor_id=?',[s.vendorId])).map(r=>Number(r.id));
 const inClause=merchants.length?merchants.join(','):'0';
 const agg=(await service.get(service.pool,
  `SELECT
    COALESCE(SUM(CASE WHEN i.status='pending' AND bi.status IN ('draft','submitted','approved','frozen') THEN i.payable_minor END),0) pending_minor,
    COALESCE(SUM(CASE WHEN i.status='pending' AND bi.status='executing' THEN i.payable_minor END),0) settling_minor,
    COALESCE(SUM(CASE WHEN ins.status='paid' THEN ins.amount_minor END),0) paid_minor
   FROM commerce_settlement_batches bi
   LEFT JOIN commerce_settlement_items i ON i.batch_id=bi.id AND i.line_kind='merchant' AND i.status='pending'
   LEFT JOIN commerce_payout_instructions ins ON ins.batch_id=bi.id
   WHERE bi.kind='merchant' AND bi.merchant_id IN (${inClause})`))[0];
 const [confirmed]=await service.get(service.pool,`SELECT COALESCE(SUM(r.supplier_minor),0) total FROM commerce_redemptions r JOIN commerce_merchants m ON m.id=r.merchant_id
   WHERE m.vendor_id=? AND r.status='confirmed' AND NOT EXISTS (SELECT 1 FROM commerce_settlement_items i WHERE i.redemption_id=r.id AND i.line_kind='merchant')`,[s.vendorId]);
 const [recovery]=await service.get(service.pool,`SELECT COALESCE(SUM(amount_minor-recovered_minor),0) open_minor,COUNT(*) n FROM commerce_recovery_cases WHERE debtor_kind='merchant' AND merchant_id IN (${inClause}) AND status='open'`);
 const batches=await service.get(service.pool,`SELECT id,batch_no,period_start,period_end,status,item_count,payable_minor,offset_minor,created_at FROM commerce_settlement_batches WHERE kind='merchant' AND merchant_id IN (${inClause}) ORDER BY id DESC LIMIT 50`);
 const instructions=await service.get(service.pool,`SELECT ins.id,ins.instruction_no,ins.batch_id,ins.request_no,ins.amount_minor,ins.status,ins.retry_count,ins.fail_reason,ins.submitted_at,ins.settled_at FROM commerce_payout_instructions ins JOIN commerce_settlement_batches bi ON bi.id=ins.batch_id WHERE bi.kind='merchant' AND bi.merchant_id IN (${inClause}) ORDER BY ins.id DESC LIMIT 50`);
 return {summary:{confirmed_minor:Number(confirmed.total)||0,pending_minor:Number(agg.pending_minor)||0,settling_minor:Number(agg.settling_minor)||0,paid_minor:Number(agg.paid_minor)||0,recovery_open_minor:Number(recovery.open_minor)||0,
  note:'应结金额来自逐券核销快照；结算与到账经沙箱机构执行，不代表真实资金。'},batches,instructions,recovery_open:Number(recovery.n)||0};
}
async function promoterSettlement(pool,accountId){
 const one=async(sql,args=[])=>(await pool.execute(sql,args))[0];
 // 演示核销永不进结算批次，这里必须同步排除，否则 awaiting_batch 会被演示核销永久顶高（规则 21）。
 const notDemo="AND NOT (JSON_EXTRACT(o.snapshot,'$.is_demo') <=> TRUE)";
 const [totals]=await one(`SELECT COALESCE(SUM(r.channel_minor),0) confirmed_minor,
  COALESCE(SUM(CASE WHEN i.status='pending' AND bi.status='executing' THEN i.payable_minor END),0) settling_minor
  FROM commerce_redemptions r JOIN commerce_coupons rc ON rc.id=r.coupon_id JOIN commerce_orders o ON o.id=rc.order_id
  LEFT JOIN commerce_settlement_items i ON i.redemption_id=r.id AND i.line_kind='promoter'
  LEFT JOIN commerce_settlement_batches bi ON bi.id=i.batch_id
  WHERE o.source_account_id=? AND r.status='confirmed' ${notDemo}`,[accountId]);
 const [paid]=await one(`SELECT COALESCE(SUM(amount_minor),0) paid_minor FROM commerce_payout_instructions WHERE target_kind='promoter' AND promoter_account_id=? AND status='paid'`,[accountId]);
 const [awaiting]=await one(`SELECT COUNT(*) n FROM commerce_redemptions r JOIN commerce_coupons rc ON rc.id=r.coupon_id JOIN commerce_orders o ON o.id=rc.order_id WHERE o.source_account_id=? AND r.status='confirmed' ${notDemo} AND NOT EXISTS (SELECT 1 FROM commerce_settlement_items i WHERE i.redemption_id=r.id AND i.line_kind='promoter')`,[accountId]);
 const [recovery]=await one(`SELECT COALESCE(SUM(amount_minor-recovered_minor),0) open_minor FROM commerce_recovery_cases WHERE debtor_kind='promoter' AND promoter_account_id=? AND status='open'`,[accountId]);
 return {confirmed_minor:Number(totals.confirmed_minor)||0,settling_minor:Number(totals.settling_minor)||0,paid_minor:Number(paid.paid_minor)||0,recovery_open_minor:Number(recovery.open_minor)||0,awaiting_batch:Number(awaiting.n)||0};
}
async function listBatches(service,p,query){
 let where='1=1',args=[];
 if(['merchant','promoter'].includes(query.kind)){where+=' AND kind=?';args.push(query.kind);}
 if(['draft','submitted','approved','executing','completed','frozen','closed'].includes(query.status)){where+=' AND status=?';args.push(query.status);}
 return {rows:await service.get(service.pool,`SELECT b.*,mb.name merchant_name FROM commerce_settlement_batches b LEFT JOIN commerce_merchants mb ON mb.id=b.merchant_id WHERE ${where} ORDER BY b.id DESC LIMIT 200`,args)};
}
async function listRefundOrders(service,p,query){
 let where='1=1',args=[];
 if(['pending','submitted','refunded','failed','unknown','cancelled'].includes(query.status)){where+=' AND status=?';args.push(query.status);}
 const rows=await service.get(service.pool,`SELECT ro.*,JSON_UNQUOTE(JSON_EXTRACT(cc.snapshot,'$.sku.name')) coupon_name FROM commerce_refund_orders ro LEFT JOIN commerce_coupons cc ON cc.id=ro.coupon_id WHERE ${where} ORDER BY ro.id DESC LIMIT 200`,args);
 return {rows};
}

// ── compensation (已核销服务失败先行赔付): platform-own funds, recovery from merchant ──
const COMP_STATES=['pending','paid','cancelled'];
async function createCompensation(service,p,input,key){
 assert(typeof input.case_id==='string'&&/^[0-9a-f-]{36}$/.test(input.case_id),'售后单编号无效');
 return service.tx(c=>service.idem(c,p,'compensation.create',key,input,async()=>{
  const [dupe]=await c.execute('SELECT id,compensation_no,status FROM commerce_compensation_cases WHERE case_id=?',[input.case_id]);
  if(dupe.length)return {id:dupe[0].id,compensation_no:dupe[0].compensation_no,status:dupe[0].status,existing:true};
  const [cases]=await c.execute('SELECT * FROM commerce_cases WHERE id=? FOR UPDATE',[input.case_id]);assert(cases.length,'售后单不存在',404);
  const cs=cases[0];
  assert(cs.kind==='compensation','仅服务失败工单可以建立赔付单',409,'case_kind');
  assert(cs.status==='awaiting_provider','售后单不在待赔付处理状态',409,'case_state');
  const [coupons]=await c.execute('SELECT * FROM commerce_coupons WHERE id=? FOR UPDATE',[cs.coupon_id]);assert(coupons.length,'卡券不存在',404);
  const coupon=coupons[0],snapshot=parse(coupon.snapshot);
  assert(coupon.status==='redeemed','仅已核销卡券可申请赔付（未核销走退款）',409,'coupon_state');
  assert(snapshot.is_demo!==true,'演示卡券不进入资金域赔付',409,'demo_excluded');
  const compensationNo=no('CP');
  const [r]=await c.execute(`INSERT INTO commerce_compensation_cases
   (compensation_no,case_id,coupon_id,order_id,account_id,merchant_id,city_id,amount_minor,reason,requested_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
   [compensationNo,input.case_id,coupon.id,coupon.order_id,coupon.account_id,coupon.merchant_id,coupon.city_id,coupon.allocation_minor,(input.reason||cs.reason||'').slice(0,1000),p.account.id]);
  await service.audit(c,p,'compensation.create',compensationNo,{case_id:input.case_id,amount:coupon.allocation_minor},{city_id:coupon.city_id,merchant_id:coupon.merchant_id});
  return {id:r.insertId,compensation_no:compensationNo,status:'pending'};
 }));
}
async function reviewCompensation(service,p,key,input){
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_compensation_cases WHERE id=? FOR UPDATE',[key]);assert(rows.length,'赔付单不存在',404);
  const comp=rows[0];
  assert(comp.status==='pending','该赔付单已处理',409,'compensation_state');
  assert(Number(comp.requested_by)!==Number(p.account.id),'申请人不能复核自己的赔付单',403,'review_separation');
  assert(typeof input.note==='string'&&input.note.trim().length>=2,'请填写复核意见');
  if(input.action!=='approve'){
   await c.execute("UPDATE commerce_compensation_cases SET status='cancelled',reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[p.account.id,input.note.trim(),key]);
   await c.execute("UPDATE commerce_cases SET status='rejected',resolution=? WHERE id=? AND status='awaiting_provider'",['赔付复核未通过：'+input.note.trim(),comp.case_id]);
   await service.audit(c,p,'compensation.review',comp.compensation_no,{action:'rejected'},{city_id:comp.city_id,merchant_id:comp.merchant_id});
   return {id:key,status:'cancelled'};
  }
  // 平台自有资金先行赔付（沙箱口径，无真实资金），同时挂应收商户代偿，进入追偿闭环。
  await post(c,{sourceType:'compensation',sourceId:comp.compensation_no,lines:[
   {side:'debit',account:'compensation_expense',amount:Number(comp.amount_minor)},
   {side:'credit',account:'platform_own_compensation_cash',amount:Number(comp.amount_minor)}],memo:'compensation '+comp.compensation_no});
  const recovery=await openRecovery(c,'merchant',comp.merchant_id,0,comp.coupon_id,Number(comp.amount_minor),'服务失败先行赔付 '+comp.compensation_no+'，向商户追偿');
  await c.execute(`UPDATE commerce_compensation_cases SET status='paid',reviewed_by=?,review_note=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?`,[p.account.id,input.note.trim(),key]);
  await c.execute("UPDATE commerce_cases SET status='closed',resolution=CONCAT_WS(' / ',NULLIF(resolution,''),'平台已完成先行赔付（沙箱口径），并向商户追偿') WHERE id=?",[comp.case_id]);
  await service.audit(c,p,'compensation.review',comp.compensation_no,{action:'approved',amount:comp.amount_minor,recovery:recovery.recovery_no},{city_id:comp.city_id,merchant_id:comp.merchant_id});
  return {id:key,status:'paid',recovery_no:recovery.recovery_no};
 });
}
async function listCompensations(service,p,query){
 let where='1=1',args=[];
 if(['pending','paid','cancelled'].includes(query.status)){where+=' AND status=?';args.push(query.status);}
 return {rows:await service.get(service.pool,`SELECT cc.*,JSON_UNQUOTE(JSON_EXTRACT(cpv.snapshot,'$.sku.name')) coupon_name FROM commerce_compensation_cases cc LEFT JOIN commerce_coupons cpv ON cpv.id=cc.coupon_id WHERE ${where} ORDER BY cc.id DESC LIMIT 200`,args)};
}

// ── operational alerts (M1-A4): threshold + current + runbook per rule; exercised by injected drills ──
async function operationalAlerts(service){
 const one=async(sql,args=[])=>(await service.get(service.pool,sql,args))[0];
 const n=v=>Number(v)||0;
 const now='UTC_TIMESTAMP()';
 const grantBacklog=await one("SELECT COUNT(*) n FROM commerce_orders WHERE status='reserved' AND expires_at<="+now);
 const expiryStale=await one("SELECT COUNT(*) n FROM commerce_coupons WHERE status='available' AND expires_at<="+now);
 const refundStuck=await one("SELECT COUNT(*) n, SUM(status='unknown') unk FROM commerce_refund_orders WHERE status IN ('pending','submitted') AND created_at<="+now+" - INTERVAL 24 HOUR");
 const refundUnknown=await one("SELECT COUNT(*) n FROM commerce_refund_orders WHERE status='unknown'");
 const payoutUnknown=await one("SELECT COUNT(*) n FROM commerce_payout_instructions WHERE status='unknown'");
 const payoutExhausted=await one("SELECT COUNT(*) n FROM commerce_payout_instructions WHERE status='failed' AND retry_count>=3");
 const payoutStuck=await one("SELECT COUNT(*) n FROM commerce_payout_instructions WHERE status='submitted' AND submitted_at<="+now+" - INTERVAL 24 HOUR");
 const reconOpen=await one("SELECT COUNT(*) n FROM commerce_recon_diffs WHERE status IN ('open','processing')");
 const opFailures=await one("SELECT COUNT(*) n FROM commerce_audit WHERE action='operation.failed' AND created_at>="+now+" - INTERVAL 1 HOUR");
 const compPending=await one("SELECT COUNT(*) n FROM commerce_compensation_cases WHERE status='pending' AND created_at<="+now+" - INTERVAL 24 HOUR");
 const expiringSoon=await one("SELECT COUNT(*) n FROM commerce_coupons WHERE status='available' AND expires_at<="+now+" + INTERVAL 7 DAY AND expires_at>"+now);
 const invariants=await verifyInvariants(service.pool);
 const broken=invariants.checks.filter(c=>!c.passed).map(c=>c.name);
 const rules=[
  {code:'service_unavailable',name:'服务不可用',severity:'critical',current:null,triggered:false,threshold:'healthz 探活连续失败（外部监控 30s 周期 ×3）',view:'GET /api/commerce/v1/healthz；systemctl status sy-commerce-preview',runbook:'责任：系统负责人。① systemctl status sy-commerce-preview.service 查看退出原因；② journalctl -u sy-commerce-preview -n 100 定位（DB 连接失败/迁移校验失败）；③ 修复或按 RECOVERY 手册回退上一个已验证版本；④ 恢复后 curl healthz + 运营统计页复核。'},
  {code:'grant_backlog',name:'发放/预占积压',severity:'critical',current:n(grantBacklog.n),triggered:n(grantBacklog.n)>0,threshold:'>0（过期预占未被释放）',view:'运营统计页 订单卡；SQL commerce_orders status=reserved AND expires_at<now',runbook:'责任：平台运营。① 记录滞留订单号；② 检查 expire 定时任务是否存活（服务日志 Commerce expiry failed）；③ 手动触发一次 expire（重启服务即执行）；④ 仍不释放则按事务失败排查（库存行锁）。'},
  {code:'expiry_pending',name:'到期处理滞留',severity:'warning',current:n(expiryStale.n),triggered:n(expiryStale.n)>50,threshold:'>50（30 秒周期扫描未能及时消化）',view:'运营统计页 卡券卡（available 且已过期）',runbook:'责任：平台运营。① 检查是否有损坏券数据阻塞扫描（日志 Commerce expiry failed）；② 移除/修复阻塞行后任务自动续跑；③ 到期券逐单建原路退款 case，不批量改库。'},
  {code:'refund_stuck',name:'退款滞留',severity:'warning',current:n(refundStuck.n),triggered:n(refundStuck.n)>0,threshold:'pending/submitted 超 24h >0',view:'退款执行页（状态=待执行/退款处理中）',runbook:'责任：平台运营 + 资金复核。① 查退款单 fail_reason 与重试次数；② pending 可执行/作废；③ submitted 超 24h 走查单；④ 与用户沟通到账时限。'},
  {code:'instrument_unknown',name:'结算结果未知',severity:'critical',current:n(payoutUnknown.n)+n(refundUnknown.n),triggered:n(payoutUnknown.n)+n(refundUnknown.n)>0,threshold:'>0（即时）',view:'结算账单页 指令状态=结果未知；退款执行页 查询中',runbook:'责任：资金复核。① 立即对原请求查单（只能查原指令，禁止重试或换号重付）；② 查实后按回执/查单结果推进；③ 仍未知保持 UNKNOWN 并联系机构核实。'},
  {code:'retry_exhausted',name:'重试达上限',severity:'critical',current:n(payoutExhausted.n),triggered:n(payoutExhausted.n)>0,threshold:'>0（失败且已重试 3 次）',view:'结算账单页 指令（重试=3，已失败）',runbook:'责任：资金复核（转人工）。① 与机构人工核实原请求最终状态；② 若机构已付：登记差异并进入对账处理，禁止直接改单；③ 若确认失败：修正机构侧后由人工再放行重试渠道；④ 全程留痕于对账差异/审计。'},
  {code:'payout_stuck',name:'付款指令无回执',severity:'warning',current:n(payoutStuck.n),triggered:n(payoutStuck.n)>0,threshold:'submitted 超 24h 无回执 >0',view:'结算账单页（机构处理中超 24h）',runbook:'责任：资金复核。① 对原请求查单；② 机构侧无记录则按机构账单缺失生成对账差异并跟进。'},
  {code:'recon_diff_open',name:'对账差异未闭环',severity:'warning',current:n(reconOpen.n),triggered:n(reconOpen.n)>0,threshold:'open/processing >0（账期结束前应清零）',view:'对账中心 差异明细',runbook:'责任：平台运营指派责任人 → 资金复核关闭。① 逐条核实差异类型；② 处理并记录；③ 关账前全部差异需关闭（关闭由非责任人复核）。'},
  {code:'operation_failures',name:'业务失败突增',severity:'warning',current:n(opFailures.n),triggered:n(opFailures.n)>50,threshold:'近 1 小时 operation.failed >50',view:'运营统计页 近期失败记录',runbook:'责任：系统负责人。① 聚合失败原因（接口+原因列）；② 区分用户误操作与系统性故障；③ 系统性故障按对应 runbook 处理。'},
  {code:'compensation_pending',name:'赔付复核滞留',severity:'warning',current:n(compPending.n),triggered:n(compPending.n)>0,threshold:'pending 超 24h >0',view:'对账中心 先行赔付区（待复核）',runbook:'责任：资金复核。① 24h 内完成赔付复核（同意/拒绝）；② 滞留超 SLA 上报升级。'},
  {code:'expiring_soon',name:'到期退回预告',severity:'info',current:n(expiringSoon.n),triggered:false,threshold:'未来 7 天到期券数（信息项）',view:'运营统计页 卡券卡',runbook:'责任：平台运营。关注未来一周原路退回量，提前准备客服口径；不要求处理。'},
  {code:'invariant_broken',name:'账务不变量异常',severity:'critical',current:broken.join('；')||null,triggered:broken.length>0,threshold:'I1–I8 任一不通过（即时）',view:'结算账单页 资金不变量卡',runbook:'责任：系统负责人 + 资金复核（停手排查）。① 立即停止生成新账单/执行；② 按失败不变量定位（I2 守恒/I3 重复/I4 镜像/I8 赔付联动）；③ 修复前不动任何资金指令；④ 排查结论与修复留档。'},
 ];
 const triggered=rules.filter(r=>r.triggered);
 return {checked_at:new Date().toISOString(),total:rules.length,triggered_count:triggered.length,critical:triggered.some(r=>r.severity==='critical'),rules};
}

module.exports={migrate,post,confirmLines,reverseLines,generateBatches,batchAction,batchView,listBatches,ingestReceipt,queryInstrument,retryInstrument,listInstructions,
 createRefundOrder,refundAction,requestReversal,reviewReversal,listReversals,recover,writeOffRecovery,listRecoveries,
 createCompensation,reviewCompensation,listCompensations,
 runReconciliation,reconDetail,listRecons,diffAction,verifyInvariants,overview,merchantSettlement,promoterSettlement,listRefundOrders,
 sandboxSimulate,sandboxQuery,operationalAlerts};
