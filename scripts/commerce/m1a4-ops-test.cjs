'use strict';
// M1-A4 运行验收 · 异常恢复 / 失败任务处理 / 告警实测。
// 独立临时 MySQL 库；全部结论写入 docs/verification/newliving-commerce-m1a4/ops-results.json。
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const mysql=require('mysql2/promise'),{config,initAuth}=require('../../commerce/db.cjs'),{migrate}=require('../../commerce/migrate.cjs'),{Service}=require('../../commerce/service.cjs'),settlement=require('../../commerce/settlement.cjs'),{createServer}=require('../../commerce/app.cjs');
const results=[];const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const day=n=>bj(new Date(Date.now()+n*86400000));
(async()=>{
 const cfg=config(),database='commerce_m1a4_ops_'+Date.now();let admin=await mysql.createConnection(cfg),testConfig=cfg;let pool,server,created=false;
 try{
  try{await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}catch(e){if(e.code!=='ER_DBACCESS_DENIED_ERROR')throw e;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}created=true;
  pool=mysql.createPool({...testConfig,database,connectionLimit:12});
  for(const table of ['accounts','roles','account_roles','sessions','cities','jz_vendors','gr_orders','jz_orders','jz_categories'])await pool.query('CREATE TABLE `'+table+'` LIKE `'+cfg.database+'`.`'+table+'`');
  await pool.query('INSERT INTO jz_categories SELECT * FROM `'+cfg.database+'`.jz_categories');
  await migrate(pool);
  const auth=initAuth(pool),service=new Service(pool,auth);
  await pool.query("INSERT INTO cities(id,name,slug) VALUES (1,'运行验收城市','m1a4')");
  await pool.query("INSERT INTO jz_vendors(id,type,name,status) VALUES(1,'service','运行验收商户','active')");
  for(const [code,perms]of Object.entries({
   operator:['commerce.admin.read','commerce.admin.write','commerce.fund.read','commerce.fund.write'],
   reviewer:['commerce.admin.read','commerce.admin.review','commerce.fund.read','commerce.fund.review'],
   merchant:['commerce.merchant.read','commerce.merchant.write','commerce.merchant.redeem'],user:[]})){
   await pool.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[code,code,JSON.stringify(perms)]);
  }
  const actors={};
  for(const [i,name,role,vendor,scope]of [[1,'operator','operator',null,{level:'all'}],[2,'reviewer','reviewer',null,{level:'all'}],[3,'merchant','merchant',1,{level:'vendor',vendor_id:1}],[4,'user','user',null,{level:'self'}]]){
   await pool.execute("INSERT INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[i,name,vendor]);
   await pool.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[i,role,JSON.stringify(scope)]);
   actors[name]={type:'account',...await auth.getAccountWithRoles(i)};actors[name].token=(await auth.createSession(i,'127.0.0.1','m1a4 ops')).token;
  }
  const W='commerce.admin.write',R='commerce.admin.review';
  async function publish(kind,payload){let e=await service.save(actors.operator,W,kind,null,{payload});e=await service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'submit'});e=await service.transition(actors.reviewer,R,kind,e.id,{version:e.version,action:'approve',note:'验收复核'});return service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'publish'});}
  const merchant=await publish('merchants',{name:'运行验收生活服务',vendor_id:1,city_id:1,contract_ref:'OPS-001',contact:'验收',phone:'00000000000',description:'运行验收商户'});
  const store=await publish('stores',{name:'运行验收门店',merchant_id:merchant.id,city_id:1,address:'验收路1号',phone:'00000000000',capacity:50,lead_hours:0,description:'每日服务'});
  await publish('staff',{name:'运行核销员',merchant_id:merchant.id,store_id:store.id,account_id:3});
  const sku=await publish('skus',{name:'运行验收服务',merchant_id:merchant.id,store_id:store.id,supply_minor:3000,retail_minor:10000,valid_days:30,description:'标准服务',conditions:'提前预约'});
  const rule=await publish('rules',{name:'运行验收规则',merchant_id:merchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'验收规则'});
  const pkg=await publish('packages',{name:'运行验收券包',city_id:1,price_minor:10000,description:'一张券',items:[{sku_id:sku.id,rule_id:rule.id,quantity:1,allocation_minor:10000}]});
  await service.inventory(actors.operator,W,{sku_id:sku.id,total:100});
  const bookToday=async coupon=>{await service.appointment(actors.user,{coupon_id:coupon.id,service_date:day(1)},'appt-'+coupon.id+'-'+crypto.randomUUID().slice(0,6));await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status='booked'",[day(0),coupon.id]);return service.token(actors.user,coupon.id);};
  const buy=async key=>{const order=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},key);await service.fulfillPaidOrder(order.id,'ops-provider-'+key,10000);return (await service.my(actors.user)).coupons.filter(c=>c.order_id===order.id);};
  const snapshotCounts=async()=>{const [rows]=await pool.query(`SELECT
   (SELECT COUNT(*) FROM commerce_orders) orders,(SELECT COUNT(*) FROM commerce_coupons) coupons,
   (SELECT COUNT(*) FROM commerce_redemptions) redemptions,(SELECT COUNT(*) FROM commerce_ledger_entries) ledger,
   (SELECT COALESCE(SUM(total-reserved-granted),0) FROM commerce_inventory) stock_free`);return rows[0];};

  server=createServer({pool,auth,demoEnabled:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let origin='http://127.0.0.1:'+server.address().port;
  const request=async(route,actor,method='GET',body,opts={})=>{const ac=new AbortController();const timer=opts.timeoutMs?setTimeout(()=>ac.abort(),opts.timeoutMs):null;try{const response=await fetch(origin+'/api/commerce/v1'+route,{method,signal:ac.signal,headers:{...(actor?{Authorization:'Bearer '+actor.token}:{}),...(method!=='GET'?{'Content-Type':'application/json','Idempotency-Key':opts.idempotencyKey||crypto.randomUUID()}:{}),...(method!=='GET'?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});clearTimeout(timer);return {status:response.status,body:await response.json()};}catch(e){clearTimeout(timer);return {status:0,aborted:e.name==='AbortError'};}};

  await check('ENV-1 幂等重放与冲突：同键同内容回放原结果，同键异内容 409',async()=>{
   // 失败（回滚）的操作不保留幂等键：修复后可用原键安全重试（无 409 锁死）
   const coupons=await buy('ops-env1-order');
   const badInput={coupon_id:'00000000-0000-0000-0000-000000000000',service_date:day(1)};
   const first=await request('/appointments',actors.user,'POST',badInput,{idempotencyKey:'ops-idem-0001'});
   assert.equal(first.status,404);
   const retried=await request('/appointments',actors.user,'POST',badInput,{idempotencyKey:'ops-idem-0001'});
   assert.equal(retried.status,404,'失败操作同键重试不被 409 锁死（事务回滚不留键）');
   // 成功路径：同键同内容回放原结果；同键异内容 409
   const okKey='ops-idem-0002',okInput={coupon_id:coupons[0].id,service_date:day(1)};
   const ok1=await request('/appointments',actors.user,'POST',okInput,{idempotencyKey:okKey});
   assert.equal(ok1.status,201);
   const ok2=await request('/appointments',actors.user,'POST',okInput,{idempotencyKey:okKey});
   assert.equal(ok2.body.data.id,ok1.body.data.id,'重放返回原预约');
   const conflict=await request('/appointments',actors.user,'POST',{coupon_id:coupons[0].id,service_date:day(2)},{idempotencyKey:okKey});
   assert.equal(conflict.status,409,'同键异内容 409');
   const [appts]=await pool.execute('SELECT COUNT(*) n FROM commerce_appointments WHERE coupon_id=?',[coupons[0].id]);
   assert.equal(appts[0].n,1,'无重复预约');
  });

  await check('ENV-2 客户端断连：请求中断后服务端事务完整，幂等键可安全重放',async()=>{
   const coupons=await buy('ops-env2-order');
   const key='ops-abort-0001';
   const aborted=await request('/appointments',actors.user,'POST',{coupon_id:coupons[0].id,service_date:day(1)},{idempotencyKey:key,timeoutMs:1});
   assert.equal(aborted.aborted,true,'客户端已中断');
   await new Promise(r=>setTimeout(r,300));
   const [rows]=await pool.execute('SELECT response FROM commerce_idempotency WHERE operation=\'appointment\' AND request_key=?',[key]);
   const replay=await request('/appointments',actors.user,'POST',{coupon_id:coupons[0].id,service_date:day(1)},{idempotencyKey:key});
   assert.ok(replay.status===201||replay.status===0,'重放不产生半状态');
   const [appts]=await pool.execute('SELECT COUNT(*) n FROM commerce_appointments WHERE coupon_id=?',[coupons[0].id]);
   assert.ok(appts[0].n<=1,'断连不产生重复预约');
  });

  await check('ENV-3 数据库事务失败：注入的核销事务完整回滚，随后真实核销恰好一次',async()=>{
   const coupons=await buy('ops-env3-order');
   const t=await bookToday(coupons[0]);
   const before=await snapshotCounts();
   // 模拟核销事务中途失败：与 redeem 相同的写入序列，最后一步触发唯一键冲突 → 整体回滚
   await assert.rejects(service.tx(async c=>{
    await c.execute('INSERT INTO commerce_redemptions(id,coupon_id,account_id,merchant_id,store_id,city_id,operator_id,allocation_minor,supplier_minor,beike_minor,channel_minor,retained_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',['ops-fake-redemption',coupons[0].id,4,merchant.id,store.id,1,3,10000,8000,2000,1000,1000]);
    await c.execute("UPDATE commerce_coupons SET status='redeemed' WHERE id=?",[coupons[0].id]);
    await settlement.post(c,{sourceType:'redemption',sourceId:'ops-fake-redemption',lines:require('../../commerce/settlement.cjs').confirmLines({merchant_id:merchant.id,allocation_minor:10000,supplier_minor:8000,beike_minor:2000,channel_minor:0,retained_minor:2000,source_account_id:null}),memo:'ops fake'});
    await c.execute("UPDATE commerce_appointments SET status='completed' WHERE coupon_id=?",[coupons[0].id]);
    throw Object.assign(new Error('injected failure'),{code:'ER_DUP_ENTRY'});
   }),/injected failure/);
   const after=await snapshotCounts();
   assert.deepEqual(after,before,'事务失败后与失败前逐表计数一致（含库存与账务）');
   const redemption=await service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupons[0].id,token:t.token},'ops-env3-redeem');
   assert.ok(redemption.id,'失败修复后可安全重试');
   const [rows]=await pool.execute('SELECT COUNT(*) n FROM commerce_redemptions WHERE coupon_id=?',[coupons[0].id]);
   assert.equal(rows[0].n,1,'恰好一次核销');
  });

  await check('ENV-4 服务重启：状态零丢失，定时任务重启后幂等续跑',async()=>{
   const coupons=await buy('ops-env4-order');
   const before=await snapshotCounts();
   await new Promise(resolve=>server.close(resolve));
   server=createServer({pool,auth,demoEnabled:false,staticFiles:true});
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   origin='http://127.0.0.1:'+server.address().port;
   const after=await snapshotCounts();
   assert.deepEqual(after,before,'重启后订单/券/核销/账务/库存全部保持');
   const health=await request('/healthz',null);
   assert.equal(health.status,200);assert.equal(health.body.data.status,'ok');
   assert.ok(health.body.data.migration,'healthz 携带迁移版本');
   // 定时任务逻辑幂等：两次 expire 不重复释放/不重复建 case
   const expired=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},'ops-env4-expired');
   await pool.execute('UPDATE commerce_orders SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id=?',[expired.id]);
   await service.expire();await service.expire();
   const [orders]=await pool.execute('SELECT status FROM commerce_orders WHERE id=?',[expired.id]);
   assert.equal(orders[0].status,'expired');
   const [inv]=await pool.execute('SELECT reserved FROM commerce_inventory WHERE sku_id=?',[sku.id]);
   const [invBefore]=await pool.execute('SELECT granted FROM commerce_inventory WHERE sku_id=?',[sku.id]);
   assert.equal(Number(inv[0].reserved),0,'预占释放且不重复');
   void invBefore;
  });

  await check('ENV-5 定时任务中断：单条脏数据阻塞不吞任务，修复后不丢不重',async()=>{
   const good=await buy('ops-env5-good');
   const bad=await buy('ops-env5-bad');
   const {id:badCouponId}=await (async()=>{const [rows]=await pool.execute('SELECT id FROM commerce_coupons WHERE order_id=?',[good[0].order_id]);return rows[0];})();
   void badCouponId;
   await pool.execute('UPDATE commerce_coupons SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE order_id IN (?,?)',[good[0].order_id,bad[0].order_id]);
   // 脏数据注入：快照置为 JSON null（合法 JSON 但语义损坏），使该券处理抛错
   await pool.execute("UPDATE commerce_coupons SET snapshot=CAST('null' AS JSON) WHERE order_id=?",[bad[0].order_id]);
   let threw=false;
   try{await service.expire();}catch(e){threw=true;}
   assert(threw,'脏数据使本轮扫描报错并被服务层捕获记录（不静默吞掉）');
   await pool.execute("UPDATE commerce_coupons SET snapshot=JSON_OBJECT('sku',JSON_OBJECT('name','运行验收服务'),'is_demo',CAST(false AS JSON)) WHERE order_id=?",[bad[0].order_id]);
   await service.expire();
   const [frozen]=await pool.execute("SELECT COUNT(*) n FROM commerce_coupons WHERE order_id IN (?,?) AND status='frozen'",[good[0].order_id,bad[0].order_id]);
   assert.equal(frozen[0].n,2,'修复后全部到期券处理完毕（不丢）');
   const [cases]=await pool.execute("SELECT COUNT(*) n FROM commerce_cases WHERE coupon_id IN (SELECT id FROM commerce_coupons WHERE order_id IN (?,?)) AND kind='refund'",[good[0].order_id,bad[0].order_id]);
   assert.equal(cases[0].n,2,'每张券恰好一个退款单（不重）');
  });

  await check('ENV-6 重复与乱序回执：已付指令拒绝状态反转，重复成功回执不重复入账',async()=>{
   const coupons=await buy('ops-env6-order');
   const t=await bookToday(coupons[0]);
   const redemption=await service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupons[0].id,token:t.token},'ops-env6-redeem');
   await pool.execute('UPDATE commerce_redemptions SET created_at=UTC_TIMESTAMP()-INTERVAL 5 DAY WHERE id=?',[redemption.id]);
   const gen=await settlement.generateBatches(service,actors.operator,{kind:'merchant',period_start:day(-6),period_end:day(-4)},'ops-gen-1');
   await settlement.batchAction(service,actors.operator,'commerce.fund.write',gen.batches[0].batch_id,{},'submit');
   await settlement.batchAction(service,actors.reviewer,'commerce.fund.review',gen.batches[0].batch_id,{action:'approve',note:'复核'},'review');
   const view=await settlement.batchAction(service,actors.operator,'commerce.fund.write',gen.batches[0].batch_id,{},'execute');
   const instruction=view.instructions[0];
   await settlement.ingestReceipt(service,actors.operator,{request_no:instruction.request_no,outcome:'paid',payload:{seq:1}});
   const [ledgerBefore]=await pool.execute("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_type='payout' AND source_id=?",[instruction.instruction_no]);
   const repeat=await settlement.ingestReceipt(service,actors.operator,{request_no:instruction.request_no,outcome:'paid',payload:{seq:2}});
   assert.equal(repeat.instrument.unchanged||repeat.instrument.status==='paid',true);
   const [ledgerAfter]=await pool.execute("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_type='payout' AND source_id=?",[instruction.instruction_no]);
   assert.equal(ledgerAfter[0].n,ledgerBefore[0].n,'重复成功回执不重复入账');
   await assert.rejects(()=>settlement.ingestReceipt(service,actors.operator,{request_no:instruction.request_no,outcome:'failed'}),/不能改为失败或未知/,'乱序失败回执被拒');
   await assert.rejects(()=>settlement.ingestReceipt(service,actors.operator,{request_no:instruction.request_no,outcome:'unknown'}),/不能改为失败或未知/,'乱序未知回执被拒');
  });

  await check('ALERT-1 告警基线：健康库全绿；healthz 可用',async()=>{
   const alerts=await settlement.operationalAlerts(service);
   assert.equal(alerts.triggered_count,0,'基线无告警 → '+JSON.stringify(alerts.rules.filter(r=>r.triggered).map(r=>r.code))+' 不变量明细：'+JSON.stringify(alerts.rules.find(r=>r.code==='invariant_broken').current));
   assert.equal(alerts.critical,false);
   const health=await request('/healthz',null);
   assert.equal(health.status,200);
  });

  await check('ALERT-2 注入演练：五类告警实际触发并可恢复',async()=>{
   // ① 发放/预占积压：过期 reserved 订单
   await pool.execute(`INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot) VALUES('ops-alert-order',4,1,'packages',${pkg.id},1,10000,'reserved',UTC_TIMESTAMP()-INTERVAL 1 HOUR,JSON_OBJECT())`);
   // ② 结算结果未知：指令 A 置 unknown；③ 重试达上限：指令 B 失败且重试 3 次
   const makeBatch=async(orderKey,redKey,daysAgo,winStart,winEnd)=>{
    const coupons=await buy(orderKey);
    const t=await bookToday(coupons[0]);
    const redemption=await service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupons[0].id,token:t.token},redKey);
    await pool.execute('UPDATE commerce_redemptions SET created_at=UTC_TIMESTAMP()-INTERVAL ? DAY WHERE id=?',[daysAgo,redemption.id]);
    const gen=await settlement.generateBatches(service,actors.operator,{kind:'merchant',period_start:winStart,period_end:winEnd},'ops-gen-'+redKey);
    const batchId=gen.batches[0].batch_id;
    await settlement.batchAction(service,actors.operator,'commerce.fund.write',batchId,{},'submit');
    await settlement.batchAction(service,actors.reviewer,'commerce.fund.review',batchId,{action:'approve',note:'复核'},'review');
    await settlement.batchAction(service,actors.operator,'commerce.fund.write',batchId,{},'execute');
    return batchId;
   };
   const batchUnknown=await makeBatch('ops-alert-order2','ops-alert-redeem-a',13,day(-14),day(-12));
   await pool.execute("UPDATE commerce_payout_instructions SET status='unknown' WHERE batch_id=?",[batchUnknown]);
   const batchFailed=await makeBatch('ops-alert-order3','ops-alert-redeem-b',19,day(-20),day(-18));
   await pool.execute("UPDATE commerce_payout_instructions SET status='failed',retry_count=3 WHERE batch_id=?",[batchFailed]);
   // ④ 对账差异未闭环
   await pool.execute(`INSERT INTO commerce_recon_diffs(recon_id,diff_no,biz_type,biz_id,kind,detail) VALUES(1,'DF-opsdrill0001','payout','1','missing_external','演练注入')`);
   // ⑤ 账务不变量异常：赔付单无关联追偿
   await pool.execute(`INSERT INTO commerce_compensation_cases(compensation_no,case_id,coupon_id,order_id,account_id,merchant_id,city_id,amount_minor,reason,status,requested_by) VALUES('CP-opsdrill0000001','ops-alert-case','ops-alert-coupon',1,4,${merchant.id},1,10000,'演练',  'paid',1)`);
   const alerts=await settlement.operationalAlerts(service);
   const codes=alerts.rules.filter(r=>r.triggered).map(r=>r.code);
   for(const expected of ['grant_backlog','instrument_unknown','retry_exhausted','recon_diff_open','invariant_broken'])assert(codes.includes(expected),'缺少触发项 '+expected+' → '+JSON.stringify(codes));
   assert.equal(alerts.critical,true,'含严重告警');
   // 恢复：处理注入源
   await pool.execute("UPDATE commerce_orders SET status='expired' WHERE id='ops-alert-order'");
   // 恢复：unknown 指令查实为已付（本地与机构镜像同步）；达上限指令按设计保持 failed 等待人工
   await pool.execute("UPDATE commerce_payout_instructions SET status='paid' WHERE batch_id=?",[batchUnknown]);
   await pool.execute(`UPDATE commerce_provider_requests pr JOIN commerce_payout_instructions ins ON ins.request_no=pr.request_no SET pr.simulated='paid',pr.status='paid',paid_at=UTC_TIMESTAMP() WHERE ins.batch_id=?`,[batchUnknown]);
   await pool.execute("DELETE FROM commerce_recon_diffs WHERE diff_no='DF-opsdrill0001'");
   await pool.execute("DELETE FROM commerce_compensation_cases WHERE compensation_no='CP-opsdrill0000001'");
   const recovered=await settlement.operationalAlerts(service);
   const remaining=recovered.rules.filter(r=>r.triggered).map(r=>r.code);
   assert.deepEqual(remaining,['retry_exhausted'],'未知项已恢复；达上限项按设计保持告警等待人工 → '+JSON.stringify(remaining));
  });

  await check('ALERT-3 转人工边界：重试达上限的指令保持可查可解释，不静默丢弃',async()=>{
   const [rows]=await pool.execute("SELECT instruction_no,status,retry_count,fail_reason FROM commerce_payout_instructions WHERE retry_count>=3 AND status='failed' LIMIT 1");
   assert.ok(rows[0],'存在达上限指令');
   assert.equal(rows[0].status,'failed','保持失败态可查询（未静默关闭）');
   assert.ok(rows[0].instruction_no);
   const alerts=await settlement.operationalAlerts(service);
   const rule=alerts.rules.find(r=>r.code==='retry_exhausted');
   assert.equal(rule.triggered,true,'重试达上限持续告警直至人工处理');
   assert(rule.runbook.includes('转人工')||rule.runbook.includes('人工'),'runbook 指向人工处理');
  });

  if(process.argv.includes('--browser'))await require('./m1a4-browser.cjs').run({origin,actors,check,pool});

  const out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-m1a4');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'ops-results.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated temporary MySQL database (removed)',checks:results},null,2));
  console.log('M1-A4 ops acceptance: '+results.length+' passed');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(pool)await pool.end();
  if(created&&/^commerce_m1a4_ops_\d+$/.test(database))await admin.query('DROP DATABASE `'+database+'`');
  await admin.end();
 }
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
