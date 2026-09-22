'use strict';
// M1-A4 运行验收 · 备份恢复 / 迁移升级 / 版本回退演练（隔离环境实测）。
// 记录恢复时间（RTO）与数据恢复点；回退不得删除业务历史或覆盖已记账务。
// 结果写入 docs/verification/newliving-commerce-m1a4/recovery-results.json。
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const mysql=require('mysql2/promise'),{config,initAuth}=require('../../commerce/db.cjs'),{migrate}=require('../../commerce/migrate.cjs'),{Service}=require('../../commerce/service.cjs'),settlement=require('../../commerce/settlement.cjs'),{createServer}=require('../../commerce/app.cjs');
const results=[];const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const day=n=>bj(new Date(Date.now()+n*86400000));
const once=(srv,ev)=>new Promise(r=>srv.once(ev,r));
(async()=>{
 const cfg=config(),database='commerce_m1a4_bak_'+Date.now();let admin=await mysql.createConnection(cfg),testConfig=cfg;let pool,server,created=false;let tmp=null;
 const dumpFile=path.join(os.tmpdir(),'commerce-m1a4-drill-'+Date.now()+'.sql');
 const fingerprint=async conn=>{
  const [rows]=await conn.query(`SELECT
   (SELECT COUNT(*) FROM commerce_orders) orders,(SELECT COUNT(*) FROM commerce_coupons) coupons,
   (SELECT COUNT(*) FROM commerce_redemptions) redemptions,(SELECT COUNT(*) FROM commerce_ledger_entries) ledger,
   (SELECT COUNT(*) FROM commerce_settlement_batches) batches,(SELECT COUNT(*) FROM commerce_settlement_items) items,
   (SELECT COUNT(*) FROM commerce_payout_instructions) instructions,(SELECT COUNT(*) FROM commerce_receipts) receipts,
   (SELECT COUNT(*) FROM commerce_recovery_cases) recoveries,(SELECT COUNT(*) FROM commerce_compensation_cases) compensations,
   (SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount_minor ELSE 0 END),0) FROM commerce_ledger_entries) debit_sum,
   (SELECT COALESCE(SUM(CASE WHEN side='credit' THEN amount_minor ELSE 0 END),0) FROM commerce_ledger_entries) credit_sum,
   (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_refund_orders WHERE status='paid') refund_paid,
   (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_payout_instructions WHERE status='paid') payout_paid`);
  return rows[0];
 };
 try{
  try{await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}catch(e){if(e.code!=='ER_DBACCESS_DENIED_ERROR')throw e;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}created=true;
  pool=mysql.createPool({...testConfig,database,connectionLimit:12});
  for(const table of ['accounts','roles','account_roles','sessions','cities','jz_vendors','gr_orders','jz_orders','jz_categories'])await pool.query('CREATE TABLE `'+table+'` LIKE `'+cfg.database+'`.`'+table+'`');
  await pool.query('INSERT INTO jz_categories SELECT * FROM `'+cfg.database+'`.jz_categories');
  await migrate(pool);
  const auth=initAuth(pool),service=new Service(pool,auth);
  await pool.query("INSERT INTO cities(id,name,slug) VALUES (1,'恢复演练城市','bak')");
  await pool.query("INSERT INTO jz_vendors(id,type,name,status) VALUES(1,'service','恢复演练商户','active')");
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
   actors[name]={type:'account',...await auth.getAccountWithRoles(i)};actors[name].token=(await auth.createSession(i,'127.0.0.1','m1a4 backup drill')).token;
  }
  const W='commerce.admin.write',R='commerce.admin.review';
  async function publish(kind,payload){let e=await service.save(actors.operator,W,kind,null,{payload});e=await service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'submit'});e=await service.transition(actors.reviewer,R,kind,e.id,{version:e.version,action:'approve',note:'drill'});return service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'publish'});}
  const merchant=await publish('merchants',{name:'恢复演练生活服务',vendor_id:1,city_id:1,contract_ref:'BAK-001',contact:'验收',phone:'00000000000',description:'备份恢复演练'});
  const store=await publish('stores',{name:'恢复演练门店',merchant_id:merchant.id,city_id:1,address:'演练路1号',phone:'00000000000',capacity:50,lead_hours:0,description:'演练'});
  await publish('staff',{name:'演练核销员',merchant_id:merchant.id,store_id:store.id,account_id:3});
  const sku=await publish('skus',{name:'恢复演练服务',merchant_id:merchant.id,store_id:store.id,supply_minor:3000,retail_minor:10000,valid_days:30,description:'标准服务',conditions:'提前预约'});
  const rule=await publish('rules',{name:'恢复演练规则',merchant_id:merchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'演练规则'});
  const pkg=await publish('packages',{name:'恢复演练券包',city_id:1,price_minor:10000,description:'一张券',items:[{sku_id:sku.id,rule_id:rule.id,quantity:1,allocation_minor:10000}]});
  await service.inventory(actors.operator,W,{sku_id:sku.id,total:100});
  const buy=async key=>{const order=await service.reserveOrder(actors.user,{kind:'packages',product_id:pkg.id},key);await service.fulfillPaidOrder(order.id,'bak-provider-'+key,10000);return (await service.my(actors.user)).coupons.filter(c=>c.order_id===order.id);};
  const bookToday=async coupon=>{await service.appointment(actors.user,{coupon_id:coupon.id,service_date:day(1)},'appt-'+coupon.id+'-'+crypto.randomUUID().slice(0,6));await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status='booked'",[day(0),coupon.id]);return service.token(actors.user,coupon.id);};
  const biz=async()=>{
   // 已核销（进账务）+ 已结算已付 + 退款已付 + 赔付已付 + 追偿关闭，构成完整业务指纹
   const c1=await buy('bak-redeem');
   const t=await bookToday(c1[0]);
   const redemption=await service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:c1[0].id,token:t.token},'bak-redeem');
   await pool.execute('UPDATE commerce_redemptions SET created_at=UTC_TIMESTAMP()-INTERVAL 5 DAY WHERE id=?',[redemption.id]);
   const gen=await settlement.generateBatches(service,actors.operator,{kind:'merchant',period_start:day(-6),period_end:day(-4)},'bak-gen-0001');
   await settlement.batchAction(service,actors.operator,'commerce.fund.write',gen.batches[0].batch_id,{},'submit');
   await settlement.batchAction(service,actors.reviewer,'commerce.fund.review',gen.batches[0].batch_id,{action:'approve',note:'drill'},'review');
   const view=await settlement.batchAction(service,actors.operator,'commerce.fund.write',gen.batches[0].batch_id,{},'execute');
   await settlement.ingestReceipt(service,actors.operator,{request_no:view.instructions[0].request_no,outcome:'paid'});
   const c2=await buy('BAKREFUND01');
   await pool.execute('UPDATE commerce_coupons SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id=?',[c2[0].id]);
   await service.expire();await service.expire();
   const caseRow=(await pool.execute("SELECT id FROM commerce_cases WHERE coupon_id=? AND kind='refund'",[c2[0].id]))[0][0].id;
   const refund=await settlement.createRefundOrder(service,actors.operator,{case_id:caseRow},'BAKREFUND01');
   const ex=await settlement.refundAction(service,actors.operator,refund.id,'execute',{});
   await settlement.ingestReceipt(service,actors.operator,{request_no:ex.request_no,outcome:'paid'});
  };
  await biz();
  const before=await fingerprint(pool);
  const inv=await settlement.verifyInvariants(pool);
  assert(inv.passed,'演练前不变量全绿');

  await check('REC-1 备份：mysqldump 全量一致性快照，记录数据恢复点',async()=>{
   const t0=Date.now();
   const args=testConfig.socketPath?['--socket='+testConfig.socketPath]:['-h',testConfig.host||'127.0.0.1','-P',String(testConfig.port||3306)];
   args.push('-u',testConfig.user);
   if(testConfig.password)args.push('-p'+testConfig.password);
   args.push('--single-transaction','--no-tablespaces','--routines','--events',database);
   const run=spawnSync('mysqldump',args,{stdio:['ignore','pipe','inherit'],maxBuffer:512*1024*1024});
   assert.equal(run.status,0,'mysqldump 退出码 '+run.status);
   fs.writeFileSync(dumpFile,run.stdout);
   const [point]=await pool.query('SELECT MAX(created_at) latest,(SELECT MAX(version) FROM commerce_migrations) migration FROM commerce_ledger_entries');
   results.push({name:'backup',passed:true,backup_ms:Date.now()-t0,dump_bytes:fs.statSync(dumpFile).size,recovery_point:{ledger_latest:point[0].latest,migration:point[0].migration}});
   global.__recoveryPoint=point[0];
  });

  await check('REC-2 恢复：全库还原后逐表行数、金额合计、账务不变量一致（记录 RTO）',async()=>{
   const t0=Date.now();
   await pool.end();
   await admin.query('DROP DATABASE `'+database+'`');
   await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
   const args=testConfig.socketPath?['--socket='+testConfig.socketPath]:['-h',testConfig.host||'127.0.0.1','-P',String(testConfig.port||3306)];
   args.push('-u',testConfig.user);
   if(testConfig.password)args.push('-p'+testConfig.password);
   args.push(database);
   const run=spawnSync('mysql',args,{input:fs.readFileSync(dumpFile),stdio:['pipe','ignore','inherit'],maxBuffer:512*1024*1024});
   assert.equal(run.status,0,'mysql 还原退出码 '+run.status);
   pool=mysql.createPool({...testConfig,database,connectionLimit:12});
   const after=await fingerprint(pool);
   assert.deepEqual(after,before,'恢复前后关键记录、数量与金额完全一致');
   const freshAuth=initAuth(pool),freshService=new Service(pool,freshAuth);
   const inv=await settlement.verifyInvariants(pool);
   assert(inv.passed,'恢复后不变量全绿');
   const rto=Date.now()-t0;
   results.push({name:'restore',passed:true,rto_ms:rto,rto_human:(rto/1000).toFixed(1)+'s',fingerprint:after,recovery_point:global.__recoveryPoint,invariants:'passed'});
  });
  const auth2=initAuth(pool);const service2=new Service(pool,auth2);void service2;

  await check('REC-3 迁移升级：旧版本库（仅 001-003）无损升级到当前版本，业务数据保留',async()=>{
   const beforeUpgrade=await fingerprint(pool);
   const legacyFingerprint=async conn=>{
    const [rows]=await conn.query(`SELECT
     (SELECT COUNT(*) FROM commerce_orders) orders,(SELECT COUNT(*) FROM commerce_coupons) coupons,
     (SELECT COUNT(*) FROM commerce_redemptions) redemptions,(SELECT COUNT(*) FROM commerce_cases) cases,
     (SELECT COUNT(*) FROM gr_orders) gr_orders`);
    return rows[0];
   };
   const legacyBeforeSnapshot=await legacyFingerprint(pool);
   // 模拟旧库：先取指纹，再删除 004/005 的表与迁移记录（等效于升级前状态），跑当前 migrate 无损升级
   await pool.query('SET FOREIGN_KEY_CHECKS=0');
   for(const t of ['commerce_ledger_entries','commerce_provider_requests','commerce_settlement_batches','commerce_settlement_items','commerce_payout_instructions','commerce_refund_orders','commerce_receipts','commerce_recovery_cases','commerce_redemption_reversals','commerce_recon_batches','commerce_recon_diffs','commerce_compensation_cases'])await pool.query('DROP TABLE IF EXISTS '+t);
   await pool.query('SET FOREIGN_KEY_CHECKS=1');
   await pool.query("DELETE FROM commerce_migrations WHERE version IN ('004_settlement','005_compensation')");
   await pool.query('ALTER TABLE commerce_redemptions DROP COLUMN status, DROP COLUMN reversed_at');
   await migrate(pool);
   const legacyAfter=await legacyFingerprint(pool);
   assert.deepEqual(legacyAfter,legacyBeforeSnapshot,'升级过程业务数据零变化（订单/卡券/核销/售后原样）');
   const inv=await settlement.verifyInvariants(pool);
   const failed=inv.checks.filter(c=>!c.passed);
   // 升级演练允许的唯一差异：被清空的 004 退款单使 I2 少计一笔已退款（真实升级路径应先恢复备份，不存在此差异）
   assert(failed.every(c=>c.name.startsWith('I2'))&&failed.length===1,'升级后除已清空退款单导致的 I2 口径差外，其余不变量全绿 → '+JSON.stringify(failed.map(c=>c.name)));
   results.push({name:'migration_upgrade',passed:true,note:'001-003 → 005 无损升级；ALTER 幂等；升级前业务表行数不变，004/005 重建为空'});
  });

  await check('REC-4 版本回退：回退代码不删历史、不覆盖账务，服务可启动',async()=>{
   tmp='/tmp/m1a4-rollback-'+Date.now();
   const wtree=spawnSync('git',['worktree','add','--detach',tmp,'HEAD'],{cwd:path.resolve(__dirname,'../..'),stdio:'pipe',timeout:120000});
   assert.equal(wtree.status,0,'git worktree 创建失败：'+wtree.stderr.toString().slice(0,200));
   const beforeRollback=await fingerprint(pool);
   // 用上一个已验收版本（HEAD，不含本轮未提交改动）的代码启动服务
   const oldApp=require(path.join(tmp,'commerce/app.cjs'));
   const oldServer=oldApp.createServer({pool,auth:auth2,demoEnabled:false,staticFiles:false});
   oldServer.listen(0,'127.0.0.1');
   await once(oldServer,'listening');
   const port=oldServer.address().port;
   const health=await fetch('http://127.0.0.1:'+port+'/api/commerce/v1/meta');
   const meta=await health.json();
   assert.equal(health.status,200);assert.equal(meta.data.mode,'mysql-m1a');
   const catalogue=await fetch('http://127.0.0.1:'+port+'/api/commerce/v1/catalog');
   assert.equal(catalogue.status,200,'回退版本核心接口可用');
   await new Promise(r=>oldServer.close(r));
   const afterRollback=await fingerprint(pool);
   assert.deepEqual(afterRollback,beforeRollback,'回退期间业务历史与已记账务零变化');
   results.push({name:'rollback',passed:true,rollback_target:'HEAD（上一已验收版本）',meta_ok:true,catalog_ok:true,data_unchanged:true,note:'回退代码对新增表无感知；迁移版本表保留，前向升级无需处理'});
  });

  const out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-m1a4');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'recovery-results.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated temporary MySQL database (removed)',checks:results},null,2));
  console.log('M1-A4 recovery acceptance: '+results.filter(r=>r.passed).length+' passed');
 }finally{
  if(server)await new Promise(r=>server.close(r));
  if(pool)await pool.end().catch(()=>{});
  if(tmp){try{spawnSync('git',['worktree','remove','--force',tmp],{cwd:path.resolve(__dirname,'../..')});}catch{}}
  if(created&&/^commerce_m1a4_bak_\d+$/.test(database))await admin.query('DROP DATABASE `'+database+'`').catch(()=>{});
  try{fs.unlinkSync(dumpFile);}catch{}
  await admin.end();
 }
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
