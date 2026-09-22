'use strict';
// 结算闭环专项验收（目标第8条）：部分核销 / 部分退款 / 跨账期 / 重复回执 / 超时未知 / 失败重试 / 已结算后退款冲回。
// 独立临时 MySQL 库；机构为沙箱镜像（commerce_provider_requests），金额单位分，全程断言金额守恒。
// 场景各自使用独立账期窗口并回拨核销时间，模拟真实的账期滞后与跨期处理。
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const mysql=require('mysql2/promise'),{config,initAuth}=require('../../commerce/db.cjs'),{migrate}=require('../../commerce/migrate.cjs'),{Service}=require('../../commerce/service.cjs'),settlement=require('../../commerce/settlement.cjs'),{createServer}=require('../../commerce/app.cjs');
const results=[];const check=async(name,fn)=>{await fn();results.push({name,passed:true});console.log('PASS '+name);};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const bj=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
const day=n=>bj(new Date(Date.now()+n*86400000));
(async()=>{
 const cfg=config(),database='commerce_settle_test_'+Date.now();let admin=await mysql.createConnection(cfg),testConfig=cfg;let pool,server,created=false;
 try{
  try{await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}catch(e){if(e.code!=='ER_DBACCESS_DENIED_ERROR')throw e;await admin.end();testConfig={...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'};admin=await mysql.createConnection(testConfig);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');}created=true;
  pool=mysql.createPool({...testConfig,database,connectionLimit:12});
  for(const table of ['accounts','roles','account_roles','sessions','cities','jz_vendors','gr_orders','jz_orders','jz_categories'])await pool.query('CREATE TABLE `'+table+'` LIKE `'+cfg.database+'`.`'+table+'`');
  await pool.query('INSERT INTO jz_categories SELECT * FROM `'+cfg.database+'`.jz_categories');
  await migrate(pool);await migrate(pool);
  const auth=initAuth(pool),service=new Service(pool,auth);
  await pool.query("INSERT INTO cities(id,name,slug) VALUES (1,'结算验收城市','settle')");
  await pool.query("INSERT INTO jz_vendors(id,type,name,status) VALUES(1,'service','结算验收商户','active')");
  for(const [code,perms]of Object.entries({
   operator:['commerce.admin.read','commerce.admin.write','commerce.fund.read','commerce.fund.write'],
   reviewer:['commerce.admin.read','commerce.admin.review','commerce.fund.read','commerce.fund.review'],
   manager:['commerce.fund.read','commerce.fund.write','commerce.fund.review'],
   merchant:['commerce.merchant.read','commerce.merchant.write','commerce.merchant.redeem'],
   user:[]})){
   await pool.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[code,code,JSON.stringify(perms)]);
  }
  const actors={};
  for(const [i,name,role,vendor,scope]of [[1,'operator','operator',null,{level:'all'}],[2,'reviewer','reviewer',null,{level:'all'}],[6,'manager','manager',null,{level:'all'}],[3,'merchant','merchant',1,{level:'vendor',vendor_id:1}],[4,'user','user',null,{level:'self'}],[5,'promoter','user',null,{level:'self'}]]){
   await pool.execute("INSERT INTO accounts(id,display_name,principal_type,status,vendor_id) VALUES(?,?,'user','active',?)",[i,name,vendor]);
   await pool.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[i,role,JSON.stringify(scope)]);
   actors[name]={type:'account',...await auth.getAccountWithRoles(i)};actors[name].token=(await auth.createSession(i,'127.0.0.1','settlement acceptance')).token;
  }
  const W='commerce.admin.write',R='commerce.admin.review',FW='commerce.fund.write',FR='commerce.fund.review';
  async function publish(kind,payload){let e=await service.save(actors.operator,W,kind,null,{payload});e=await service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'submit'});e=await service.transition(actors.reviewer,R,kind,e.id,{version:e.version,action:'approve',note:'验收复核'});return service.transition(actors.operator,W,kind,e.id,{version:e.version,action:'publish'});}
  const merchant=await publish('merchants',{name:'结算验收生活服务',vendor_id:1,city_id:1,contract_ref:'SETTLE-001',contact:'验收',phone:'00000000000',description:'结算域验收商户'});
  const store=await publish('stores',{name:'结算验收门店',merchant_id:merchant.id,city_id:1,address:'验收路1号',phone:'00000000000',capacity:20,lead_hours:0,description:'每日服务'});
  await publish('staff',{name:'结算核销员',merchant_id:merchant.id,store_id:store.id,account_id:3});
  const sku=await publish('skus',{name:'结算验收服务',merchant_id:merchant.id,store_id:store.id,supply_minor:3000,retail_minor:10000,valid_days:30,description:'标准服务一次',conditions:'提前预约'});
  const rule=await publish('rules',{name:'结算验收规则',merchant_id:merchant.id,beike_bps:2000,channel_bps:5000,floor_bps:1000,description:'验收分配规则 v1'});
  const single=await publish('packages',{name:'单券验收包',city_id:1,price_minor:10000,description:'一张券',items:[{sku_id:sku.id,rule_id:rule.id,quantity:1,allocation_minor:10000}]});
  const twin=await publish('packages',{name:'双券验收包',city_id:1,price_minor:10000,description:'两张券',items:[{sku_id:sku.id,rule_id:rule.id,quantity:2,allocation_minor:5000}]});
  await service.inventory(actors.operator,W,{sku_id:sku.id,total:50});
  const referralToken=product=>{const payload=Buffer.from(JSON.stringify({aid:5,kind:'packages',id:product.id,v:product.version,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');const secret=process.env.JUZHU_API_KEY||process.env.JUZHU_ADMIN_PASSWORD;assert(secret,'缺少分享签名密钥');return payload+'.'+crypto.createHmac('sha256',secret).update('commerce-share:'+payload).digest('base64url');};
  const buy=async(pkg,key,attributed)=>{const input={kind:'packages',product_id:pkg.id,...(attributed?{referral:referralToken(pkg)}:{})};const order=await service.reserveOrder(actors.user,input,key);await service.fulfillPaidOrder(order.id,'settle-provider-'+key,10000);const coupons=(await service.my(actors.user)).coupons.filter(c=>c.order_id===order.id);return {order,coupons};};
  const bookToday=async coupon=>{await service.appointment(actors.user,{coupon_id:coupon.id,service_date:day(1)},'appt-'+coupon.id+'-'+crypto.randomUUID().slice(0,6));await pool.execute("UPDATE commerce_appointments SET service_date=? WHERE coupon_id=? AND status='booked'",[day(0),coupon.id]);return service.token(actors.user,coupon.id);};
  const redeem=async(coupon,key)=>{const t=await bookToday(coupon);return service.redeem(actors.merchant,'commerce.merchant.redeem',{coupon_id:coupon.id,token:t.token},key);};
  const backdate=async(redemptionId,daysAgo)=>pool.execute('UPDATE commerce_redemptions SET created_at=UTC_TIMESTAMP()-INTERVAL ? DAY WHERE id=?',[daysAgo,redemptionId]);
  const generate=async(kind,start,end)=>settlement.generateBatches(service,actors.operator,{kind,period_start:start,period_end:end},'gen-'+kind+'-'+start+'-'+end+'-'+crypto.randomUUID().slice(0,8));
  const batchRow=async batchId=>(await pool.execute('SELECT * FROM commerce_settlement_batches WHERE id=?',[batchId]))[0][0];
  const simulate=(requestNo,result)=>service.tx(c=>settlement.sandboxSimulate(c,requestNo,result));
  const pay=async batchId=>{const view=await service.tx(c=>settlement.batchView(c,batchId));for(const ins of view.instructions)await settlement.ingestReceipt(service,actors.operator,{request_no:ins.request_no,outcome:'paid',payload:{scenario:'settle'}});return view;};
  const approveAndExecute=async batchId=>{await settlement.batchAction(service,actors.operator,FW,batchId,{},'submit');await settlement.batchAction(service,actors.reviewer,FR,batchId,{action:'approve',note:'账单复核通过'},'review');return settlement.batchAction(service,actors.operator,FW,batchId,{},'execute');};
  const conservation=async()=>{const inv=await settlement.verifyInvariants(pool);const c=inv.checks.find(x=>x.name.startsWith('I2'));assert(c.passed,'I2 订单资金守恒 → '+JSON.stringify(c.detail));return inv;};

  await check('SC1 部分核销：双券包只核销一张，仅核销部分确认应结与佣金，重复生成不重复入账',async()=>{
   const {coupons}=await buy(twin,'order-sc1',true);
   const redemption=await redeem(coupons[0],'redeem-sc1');
   await backdate(redemption.id,5);
   const gen=await generate('both',day(-6),day(-4));
   assert.equal(gen.items_added,2,'商户明细 + 渠道明细各一条');
   const mb=gen.batches.find(b=>b.kind==='merchant'),pb=gen.batches.find(b=>b.kind==='promoter');
   assert.equal(mb.items_added,1);assert.equal(pb.items_added,1,'未核销的第二张券不产生任何结算明细');
   assert.equal(mb.payable_minor,4000,'商户应结=5000−贝壳佣金1000（规则20%）');
   assert.equal(pb.payable_minor,500,'渠道佣金=贝壳佣金1000×50%（有推广归属）');
   assert.equal(mb.batch_no.startsWith('SB-'),true);
   await conservation();
   const again=await generate('both',day(-6),day(-4));
   assert.equal(again.items_added,0,'uk_settle_once：同明细重复生成不重复入账');
   assert.equal(again.batches.length,2,'返回既有批次而非新建');
  });

  const W2=[day(-9),day(-7)];
  let sc2Batch,sc2View;
  await check('SC2 复核与执行：申请审批分离、异常冻结阻断执行、明细可追溯规则版本',async()=>{
   const {coupons}=await buy(single,'order-sc2');
   const redemption=await redeem(coupons[0],'redeem-sc2');
   await backdate(redemption.id,8);
   const gen=await generate('merchant',W2[0],W2[1]);
   sc2Batch=gen.batches[0].batch_id;
   await settlement.batchAction(service,actors.manager,FW,sc2Batch,{},'submit');
   await assert.rejects(()=>settlement.batchAction(service,actors.manager,FR,sc2Batch,{action:'approve',note:'自审'},'review'),/申请人不能复核/,'持有复核权限的提交人仍不能自审');
   await assert.rejects(()=>settlement.batchAction(service,actors.operator,FR,sc2Batch,{action:'approve',note:'越权'},'review'),/没有该操作权限/,'无复核权限者被权限闸拒绝');
   await settlement.batchAction(service,actors.operator,FW,sc2Batch,{reason:'口径待确认，先冻结'},'freeze');
   assert.equal((await batchRow(sc2Batch)).status,'frozen');
   await assert.rejects(()=>settlement.batchAction(service,actors.operator,FW,sc2Batch,{},'execute'),/当前状态不能执行/,'冻结阻断执行');
   await settlement.batchAction(service,actors.operator,FW,sc2Batch,{reason:'口径确认完毕'},'unfreeze');
   assert.equal((await batchRow(sc2Batch)).status,'submitted','解冻回到提审态');
   sc2View=await service.tx(c=>settlement.batchView(c,sc2Batch));
   assert.equal(sc2View.payable_minor,8000,'单券应结=10000−2000');
   assert.equal(sc2View.items[0].rule_ref,'rule:'+rule.id+'.v'+rule.version,'明细携带订单锁定的规则版本');
   assert.equal(sc2View.items[0].basis_minor,10000);
  });

  let sc2Instruction;
  await check('SC3 回执幂等：重复回执不重复入账，paid 后 failed 冲突被拒，批次自动完成',async()=>{
   await settlement.batchAction(service,actors.reviewer,FR,sc2Batch,{action:'approve',note:'独立复核通过'},'review');
   sc2View=await settlement.batchAction(service,actors.operator,FW,sc2Batch,{},'execute');
   sc2Instruction=sc2View.instructions[0];
   assert.equal(sc2Instruction.status,'submitted');
   const first=await settlement.ingestReceipt(service,actors.operator,{request_no:sc2Instruction.request_no,outcome:'paid',payload:{channel:'sandbox'}});
   assert.equal(first.instrument.status,'paid');
   const dupe=await settlement.ingestReceipt(service,actors.operator,{request_no:sc2Instruction.request_no,outcome:'paid',payload:{channel:'sandbox'}});
   assert.equal(dupe.deduplicated,true,'重复回执幂等去重');
   const [ledger]=await pool.execute("SELECT COUNT(*) n FROM commerce_ledger_entries WHERE source_type='payout' AND source_id=?",[sc2Instruction.instruction_no]);
   assert.equal(ledger[0].n,2,'付款只过一次账（借贷各一行）');
   await assert.rejects(()=>settlement.ingestReceipt(service,actors.operator,{request_no:sc2Instruction.request_no,outcome:'failed'}),/不能改为失败或未知/,'已回执成功后失败回执冲突');
   assert.equal((await batchRow(sc2Batch)).status,'completed','全部指令已付 → 批次完成');
   await assert.rejects(()=>settlement.ingestReceipt(service,actors.operator,{request_no:'PR-ffffffffffffffff',outcome:'paid'}),e=>e.code==='unknown_request','未知请求号回执被拒');
  });

  await check('SC4 失败重试：明确失败可控重试（沿用原指令号），达上限后拒绝',async()=>{
   const {coupons}=await buy(single,'order-sc4');
   const redemption=await redeem(coupons[0],'redeem-sc4');
   await backdate(redemption.id,10);
   const gen=await generate('merchant',day(-11),day(-9));
   const view=await approveAndExecute(gen.batches[0].batch_id);
   const instruction=view.instructions[0];
   await simulate(instruction.request_no,'failed');
   const failReceipt=await settlement.ingestReceipt(service,actors.operator,{request_no:instruction.request_no,outcome:'failed',note:'机构返回失败'});
   assert.equal(failReceipt.instrument.status,'failed');
   const retry1=await settlement.retryInstrument(service,actors.operator,'payout',instruction.id);
   assert.equal(retry1.instrument.status,'failed','沙箱仍为失败 → 重试后依旧失败');
   assert.equal(retry1.request_no,instruction.request_no,'重试沿用原请求号，不换号重付');
   await simulate(instruction.request_no,'paid');
   const retry2=await settlement.retryInstrument(service,actors.operator,'payout',instruction.id);
   assert.equal(retry2.instrument.status,'paid','重试后到账');
   assert.equal((await batchRow(gen.batches[0].batch_id)).status,'completed');
   // 重试上限：另一批次失败后连试 3 次拒绝
   const {coupons:c2}=await buy(single,'order-sc4b');
   const redemption2=await redeem(c2[0],'redeem-sc4b');
   await backdate(redemption2.id,8);
   const gen2=await generate('merchant',day(-8),day(-7));
   const v2=await approveAndExecute(gen2.batches[0].batch_id);
   await simulate(v2.instructions[0].request_no,'failed');
   await settlement.ingestReceipt(service,actors.operator,{request_no:v2.instructions[0].request_no,outcome:'failed'});
   for(let i=0;i<3;i++)await settlement.retryInstrument(service,actors.operator,'payout',v2.instructions[0].id);
   await assert.rejects(()=>settlement.retryInstrument(service,actors.operator,'payout',v2.instructions[0].id),/重试已达上限/,'3 次后拒绝继续重试');
  });

  await check('SC5 超时未知：UNKNOWN 只能查原指令，查实成功后无重复付款',async()=>{
   const {coupons}=await buy(single,'order-sc5',true);
   const redemption=await redeem(coupons[0],'redeem-sc5');
   await backdate(redemption.id,12);
   const gen=await generate('merchant',day(-13),day(-11));
   const view=await approveAndExecute(gen.batches[0].batch_id);
   const instruction=view.instructions[0];
   await simulate(instruction.request_no,'unknown');
   await assert.rejects(()=>settlement.retryInstrument(service,actors.operator,'payout',instruction.id),/只有明确失败的指令可以重试/,'UNKNOWN 禁止重试');
   const q1=await settlement.queryInstrument(service,actors.operator,'payout',instruction.id);
   assert.equal(q1.remote_status,'processing');assert.equal(q1.instrument.status,'unknown','查单未返回 → 保持 UNKNOWN');
   await simulate(instruction.request_no,'paid');
   const q2=await settlement.queryInstrument(service,actors.operator,'payout',instruction.id);
   assert.equal(q2.instrument.status,'paid','查原指令获知成功');
   const [requests]=await pool.execute('SELECT COUNT(*) n FROM commerce_provider_requests WHERE target_id=?',[instruction.instruction_no]);
   assert.equal(requests[0].n,1,'同一指令只有一条机构请求（防重复付款）');
   assert.equal((await batchRow(gen.batches[0].batch_id)).status,'completed');
   // UNKNOWN 期间不能对同批明细再次生成执行
   await assert.rejects(()=>generate('merchant',day(-13),day(-11)).then(g=>approveAndExecute(g.batches[0].batch_id)),/已执行或关账|当前状态/,'同批不能跨批次重复结算');
  });

  await check('SC6 部分退款：未核销券原路退回，与核销互斥，订单仍守恒',async()=>{
   const {coupons}=await buy(twin,'order-sc6');
   const refundCase=await service.openCase(actors.user,{coupon_id:coupons[0].id,kind:'refund',reason:'SC6 部分退款验收'},'case-sc6');
   await service.resolveCase(actors.operator,W,refundCase.id,{action:'accept',resolution:'受理，进入退款通道'});
   assert.equal((await pool.execute('SELECT status FROM commerce_cases WHERE id=?',[refundCase.id]))[0][0].status,'awaiting_provider');
   await assert.rejects(()=>redeem(coupons[0],'redeem-sc6-blocked'),/不可预约/,'退款冻结与核销互斥（预约闸先行，核销闸同效）');
   const refund=await settlement.createRefundOrder(service,actors.operator,{case_id:refundCase.id},'refund-sc6');
   const dupe=await settlement.createRefundOrder(service,actors.operator,{case_id:refundCase.id},'refund-sc6-dup');
   assert.equal(dupe.refund_no,refund.refund_no,'重复建单幂等返回原退款单');
   const ex=await settlement.refundAction(service,actors.operator,refund.id,'execute',{});
   assert.equal(ex.instrument.status,'submitted');
   const receipt=await settlement.ingestReceipt(service,actors.operator,{request_no:ex.request_no,outcome:'paid',payload:{kind:'refund'}});
   assert.equal(receipt.instrument.status,'paid');
   assert.equal((await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[coupons[0].id]))[0][0].status,'refunded');
   assert.equal((await pool.execute('SELECT status FROM commerce_cases WHERE id=?',[refundCase.id]))[0][0].status,'closed');
   await conservation();
  });

  await check('SC7 到期退款：到期自动进入退款通道并执行原路退回',async()=>{
   const {coupons}=await buy(single,'order-sc7');
   await pool.execute('UPDATE commerce_coupons SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id=?',[coupons[0].id]);
   await service.expire();await service.expire();
   const [rows]=await pool.execute("SELECT s.id,s.status,c.status coupon_status FROM commerce_cases s JOIN commerce_coupons c ON c.id=s.coupon_id WHERE s.coupon_id=? AND s.kind='refund'",[coupons[0].id]);
   assert.equal(rows.length,1);assert.equal(rows[0].status,'awaiting_provider');assert.equal(rows[0].coupon_status,'frozen');
   const refund=await settlement.createRefundOrder(service,actors.operator,{case_id:rows[0].id},'refund-sc7');
   assert.equal(refund.refund_no.startsWith('RF-'),true);
   const ex=await settlement.refundAction(service,actors.operator,refund.id,'execute',{});
   await settlement.ingestReceipt(service,actors.operator,{request_no:ex.request_no,outcome:'paid'});
   assert.equal((await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[coupons[0].id]))[0][0].status,'refunded','到期券退款完成');
   await conservation();
  });

  await check('SC8 跨账期 + 已结算后冲回：撤销已结算核销产生追偿，下期抵扣/人工追回，同券可重新履约',async()=>{
   const {coupons}=await buy(twin,'order-sc8',true);
   const first=await redeem(coupons[0],'redeem-sc8-first');
   await backdate(first.id,20);
   const p1=await generate('both',day(-25),day(-15));
   const mb=p1.batches.find(b=>b.kind==='merchant'),pb=p1.batches.find(b=>b.kind==='promoter');
   await approveAndExecute(mb.batch_id);await approveAndExecute(pb.batch_id);
   await pay(mb.batch_id);await pay(pb.batch_id);
   assert.equal((await batchRow(mb.batch_id)).status,'completed');
   // 误核销撤销：申请 + 独立复核
   const reversal=await settlement.requestReversal(service,actors.manager,{redemption_id:first.id,reason:'SC8 误核销撤销验收：服务未实际履约'},'reversal-sc8-01');
   await assert.rejects(()=>settlement.reviewReversal(service,actors.manager,reversal.id,{action:'approve',note:'自审'}),/申请人不能复核/,'持有复核权限的申请人仍不能自审');
   await assert.rejects(()=>settlement.reviewReversal(service,actors.reviewer,reversal.id,{action:'approve',note:''}),/复核意见/);
   const approved=await settlement.reviewReversal(service,actors.reviewer,reversal.id,{action:'approve',note:'确认误核销，同意撤销'});
   assert.equal(approved.status,'approved');
   assert.equal((await pool.execute('SELECT status FROM commerce_redemptions WHERE id=?',[first.id]))[0][0].status,'reversed','原核销保留并标记撤销（保留历史）');
   const [recoveries]=await pool.execute("SELECT debtor_kind,amount_minor,status FROM commerce_recovery_cases WHERE redemption_id=? ORDER BY id",[first.id]);
   assert.equal(recoveries.length,2,'商户与渠道各一笔追偿');
   const merchantRec=recoveries.find(r=>r.debtor_kind==='merchant'),promoterRec=recoveries.find(r=>r.debtor_kind==='promoter');
   assert.equal(merchantRec.amount_minor,4000);assert.equal(promoterRec.amount_minor,500);
   const couponId=(await pool.execute('SELECT coupon_id FROM commerce_redemptions WHERE id=?',[first.id]))[0][0].coupon_id;
   assert.equal((await pool.execute('SELECT status FROM commerce_coupons WHERE id=?',[couponId]))[0][0].status,'available','撤销后卡券恢复可用');
   const second=await redeem({id:couponId},'redeem-sc8-second');
   assert.ok(second.id,'同券重新预约并核销成功');
   // 账期二：商户批单开启追偿抵扣 → 应结 4000 全额抵扣，无付款指令
   const p2=await generate('merchant',day(-2),day(0));
   assert.equal(p2.items_added,1);
   const mb2=p2.batches[0];
   assert.equal(mb2.payable_minor,4000);
   await settlement.batchAction(service,actors.operator,FW,mb2.batch_id,{},'submit');
   await settlement.batchAction(service,actors.reviewer,FR,mb2.batch_id,{action:'approve',note:'复核'},'review');
   await settlement.batchAction(service,actors.operator,FW,mb2.batch_id,{offset_recovery:true},'execute');
   const b2=await batchRow(mb2.batch_id);
   assert.equal(b2.status,'completed');assert.equal(Number(b2.offset_minor),4000,'应结被追偿全额抵扣');
   assert.equal(Number((await pool.execute("SELECT recovered_minor FROM commerce_recovery_cases WHERE debtor_kind='merchant' AND redemption_id=?",[first.id]))[0][0].recovered_minor),4000);
   // 渠道追偿走人工到账关闭；本期渠道佣金正常结算
   await settlement.recover(service,actors.operator,(await pool.execute("SELECT id FROM commerce_recovery_cases WHERE debtor_kind='promoter' AND redemption_id=?",[first.id]))[0][0].id,{amount_minor:500,note:'渠道退回佣金'});
   assert.equal((await pool.execute("SELECT status FROM commerce_recovery_cases WHERE debtor_kind='promoter' AND redemption_id=?",[first.id]))[0][0].status,'closed');
   const p2p=await generate('promoter',day(-2),day(0));
   assert.equal(p2p.items_added,1,'重新核销的渠道佣金进入新账期');
   const pb2=p2p.batches[0];
   await approveAndExecute(pb2.batch_id);await pay(pb2.batch_id);
   const inv=await conservation();
   assert(inv.checks.find(c=>c.name.startsWith('I1')).passed,'账务分组全部平衡');
  });

  await check('SC12 会员续购顺延：有效期内续费从原到期日叠加，无会员从当下起算',async()=>{
   const plan=await publish('plans',{name:'结算验收会员',city_id:1,package_id:single.id,price_minor:10000,valid_days:30,description:'会员验收'});
   const first=await service.reserveOrder(actors.user,{kind:'plans',product_id:plan.id},'order-plan-1');
   await service.fulfillPaidOrder(first.id,'settle-plan-1',10000);
   const mine1=(await service.my(actors.user)).memberships.find(m=>m.order_id===first.id);
   assert(mine1,'首购会员到账');
   const days1=Math.round((new Date(mine1.expires_at)-Date.now())/86400000);
   assert(days1>=29&&days1<=30,'首购有效期≈30天，实际 '+days1);
   const second=await service.reserveOrder(actors.user,{kind:'plans',product_id:plan.id},'order-plan-2');
   await service.fulfillPaidOrder(second.id,'settle-plan-2',10000);
   const mine2=(await service.my(actors.user)).memberships.find(m=>m.order_id===second.id);
   const gap=Math.round((new Date(mine2.expires_at)-new Date(mine1.expires_at))/86400000);
   assert(gap===30,'续费自原到期日顺延30天，实际 '+gap+' 天');
   const extend=parse((await pool.execute('SELECT snapshot FROM commerce_memberships WHERE order_id=?',[second.id]))[0][0].snapshot).extends_from;
   assert(extend,'顺延来源可追溯（extends_from 落快照）');
  });

  await check('SC13 先行赔付闭环：已核销服务失败→受理→建单→独立复核→过账并挂应收代偿',async()=>{
   const {coupons}=await buy(single,'order-sc13');
   await redeem(coupons[0],'redeem-sc13');
   const compCase=await service.openCase(actors.user,{coupon_id:coupons[0].id,kind:'compensation',reason:'SC13 服务未履约申请赔付验收'},'case-sc13');
   assert.equal((await pool.execute('SELECT kind FROM commerce_cases WHERE id=?',[compCase.id]))[0][0].kind,'compensation');
   await service.resolveCase(actors.operator,W,compCase.id,{action:'accept',resolution:'核实服务失败，进入赔付处理'});
   assert.equal((await pool.execute('SELECT status FROM commerce_cases WHERE id=?',[compCase.id]))[0][0].status,'awaiting_provider');
   const comp=await settlement.createCompensation(service,actors.manager,{case_id:compCase.id},'compensation-sc13');
   assert.equal(comp.status,'pending');
   await assert.rejects(()=>settlement.reviewCompensation(service,actors.manager,comp.id,{action:'approve',note:'自审'}),/申请人不能复核/);
   const approved=await settlement.reviewCompensation(service,actors.reviewer,comp.id,{action:'approve',note:'核实属实，同意先行赔付'});
   assert.equal(approved.status,'paid');
   assert.ok(approved.recovery_no.startsWith('RC-'),'赔付联动应收商户代偿');
   const [ledger]=await pool.execute("SELECT side,amount_minor,account FROM commerce_ledger_entries WHERE source_type='compensation' ORDER BY id");
   assert.equal(ledger.length,2);
   assert.equal(Number(ledger.find(l=>l.side==='debit').amount_minor),10000,'赔付支出过账（沙箱口径）');
   assert.equal((await pool.execute('SELECT status FROM commerce_cases WHERE id=?',[compCase.id]))[0][0].status,'closed','赔付完成后售后结单');
   // 追偿闭环：到账登记关闭
   const [rec]=(await pool.execute("SELECT id,amount_minor FROM commerce_recovery_cases WHERE redemption_id=? AND debtor_kind='merchant'",[coupons[0].id]))[0];
   await settlement.recover(service,actors.operator,rec.id,{amount_minor:Number(rec.amount_minor),note:'商户代偿到账'});
   assert.equal((await pool.execute('SELECT status FROM commerce_recovery_cases WHERE id=?',[rec.id]))[0][0].status,'closed');
   await conservation();
   // 用户可见赔付状态
   const mine=await service.my(actors.user);
   assert(mine.compensations.some(c=>c.compensation_no),'/my 随发赔付状态');
   const dup=await settlement.createCompensation(service,actors.manager,{case_id:compCase.id},'compensation-sc13-dup');
   assert.equal(dup.existing,true,'同工单重复建赔付单幂等返回原单');
  });

  await check('SC9 对账闭环：平台指令与机构账单逐笔核对，差异有责任人/处理记录/关闭依据',async()=>{
   const recon=await settlement.runReconciliation(service,actors.operator,{period_start:day(-40),period_end:day(0)},'reconciliation-run-1');
   assert.ok(recon.total>=6,'覆盖全部机构请求');
   assert.equal(recon.diff_count,0,'一致状态全部对平');
   // 注入账差：①本地 failed 但沙箱 paid（状态不一致）②机构多出的请求（missing_local）③本地已提交但机构无记录（missing_external）
   const failedInstr=(await pool.execute("SELECT request_no FROM commerce_payout_instructions WHERE status='failed' ORDER BY id DESC LIMIT 1"))[0][0];
   if(failedInstr)await simulate(failedInstr.request_no,'paid');
   await pool.execute("INSERT INTO commerce_provider_requests(request_no,target_type,target_id,amount_minor,simulated,status,paid_at) VALUES('PR-deadbeefdeadbeef','payout','ghost-instruction',99900,'paid','paid',UTC_TIMESTAMP())");
   const submitted=(await pool.execute("SELECT request_no FROM commerce_payout_instructions WHERE status='submitted' ORDER BY id DESC LIMIT 1"))[0][0];
   if(submitted)await pool.execute('DELETE FROM commerce_provider_requests WHERE request_no=?',[submitted.request_no]);
   const recon2=await settlement.runReconciliation(service,actors.operator,{period_start:day(-40),period_end:day(0)},'reconciliation-run-2');
   assert.ok(recon2.diff_count>=2,'差异被识别');
   const detail=await settlement.reconDetail(service,actors.reviewer,recon2.recon_id);
   const kinds=detail.diffs.map(d=>d.kind);
   assert(kinds.includes('status_mismatch'));assert(kinds.includes('missing_local'));
   const diff=detail.diffs.find(d=>d.status==='open');
   await assert.rejects(()=>settlement.diffAction(service,actors.operator,recon2.recon_id,diff.id,{note:'处理'},'resolve'),/先指定责任人/,'未指定责任人不能处理');
   await settlement.diffAction(service,actors.operator,recon2.recon_id,diff.id,{owner_id:1},'assign');
   await settlement.diffAction(service,actors.operator,recon2.recon_id,diff.id,{note:'核实为沙箱模拟差异，已确认无资金影响'},'resolve');
   await assert.rejects(()=>settlement.diffAction(service,actors.operator,recon2.recon_id,diff.id,{reason:'责任人与关闭人相同'},'close'),/非责任人/,'关闭须由非责任人执行');
   const closed=await settlement.diffAction(service,actors.reviewer,recon2.recon_id,diff.id,{reason:'差异已核实并计入当期调整，关闭依据充分'},'close');
   assert.equal(closed.status,'closed','差异有处理记录和关闭依据后关闭');
  });

  await check('SC10 金额守恒不变量全绿（I1–I7）',async()=>{
   const inv=await settlement.verifyInvariants(pool);
   for(const c of inv.checks)assert(c.passed,c.name+' → '+JSON.stringify(c.detail).slice(0,200));
  });

  // ── HTTP 层：权限闸与四端视角 ──
  server=createServer({pool,auth,demoEnabled:false,staticFiles:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const request=async(route,actor,method='GET',body)=>{const response=await fetch(origin+'/api/commerce/v1'+route,{method,headers:{...(actor?{Authorization:'Bearer '+actor.token}:{}),...(method!=='GET'?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
  await check('SC11 结算接口权限闸与四端可查',async()=>{
   assert.equal((await request('/admin/settlement/overview')).status,401,'匿名拒绝');
   assert.equal((await request('/admin/settlement/overview',actors.user)).status,403,'无权限角色拒绝');
   assert.equal((await request('/admin/settlement/batches',actors.user,'POST',{kind:'merchant',period_start:day(-30),period_end:day(-1)})).status,403,'无 fund.write 不能生成账单');
   const overview=await request('/admin/settlement/overview',actors.reviewer);
   assert.equal(overview.status,200);assert(overview.body.data.invariants.passed,'运营可读总览与不变量状态');
   assert.equal((await request('/admin/settlement/batches/'+sc2Batch,actors.reviewer)).status,200);
   assert.equal((await request('/admin/settlement/batches/'+sc2Batch+'/review',actors.operator,'POST',{action:'approve',note:'x'})).status,403,'operator 无 fund.review 权限');
   assert.equal((await request('/admin/settlement/instructions?status=paid',actors.reviewer)).status,200);
   assert.equal((await request('/admin/settlement/refunds',actors.reviewer)).status,200);
   assert.equal((await request('/admin/settlement/reversals',actors.reviewer)).status,200);
   assert.equal((await request('/admin/settlement/recoveries',actors.reviewer)).status,200);
   assert.equal((await request('/admin/settlement/reconciliation',actors.reviewer)).status,200);
   const mset=await request('/merchant/settlement',actors.merchant);
   assert.equal(mset.status,200);
   assert.equal(typeof mset.body.data.summary.confirmed_minor,'number');
   assert(mset.body.data.summary.note.includes('不代表真实资金'),'商户可见应结与到账且明确沙箱口径');
   assert(Array.isArray(mset.body.data.batches));
   assert.equal((await request('/merchant/settlement',actors.user)).status,403,'未绑定商户账号拒绝');
   const promo=await request('/promotion',actors.promoter);
   assert.equal(promo.status,200);assert(promo.body.data.settlement,'推广员可见佣金与结算进度');
   assert.equal(typeof promo.body.data.settlement.paid_minor,'number');
   const mine=await request('/my',actors.user);
   assert.equal(mine.status,200);assert(Array.isArray(mine.body.data.refunds)&&mine.body.data.refunds.length>=2,'用户可见退款进度');
   assert(mine.body.data.refunds.every(r=>r.refund_no&&r.status));
   assert(mine.body.data.refunds.some(r=>r.status==='refunded'));
  });

  if(process.argv.includes('--browser'))await require('./settlement-browser.cjs').run({origin,actors,check});

  const out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-settlement');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated temporary MySQL database (removed)',scenarios:results},null,2));
  console.log('Settlement acceptance: '+results.length+' passed');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(pool)await pool.end();
  if(created&&/^commerce_settle_test_\d+$/.test(database))await admin.query('DROP DATABASE `'+database+'`');
  await admin.end();
 }
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
