'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { createPaymentService } = require('../../payment_service.cjs');
const { createBookingRouter } = require('../routes/booking.cjs');
const { migrate } = require('../payment/migrate.cjs');

const socketPath = process.env.PAYMENT_TEST_SOCKET;
test('legacy lodging service and HTTP payment contracts remain usable', { skip: !socketPath, timeout: 120000 }, async t => {
  assert.match(socketPath, /^\/tmp\/[\w-]*cashier[\w-]*\/[^/]+\.sock$/);
  const database='cashier_booking_compat_'+process.pid+'_'+crypto.randomBytes(3).toString('hex');
  const options={socketPath,user:'root',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
  const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');
  t.after(async()=>{await admin.query('DROP DATABASE `'+database+'`');await admin.end();});
  const createConnection=()=>mysql.createConnection({...options,database});
  const db=async(sql,args=[])=>{const c=await createConnection();try{return(await c.execute(sql,args))[0];}finally{await c.end();}};
  const schema=execFileSync('git',['show','HEAD:server/schema.cjs'],{encoding:'utf8',cwd:__dirname+'/../..'});
  for(const table of ['booking_orders','stay_calendar']){
    const match=schema.match(new RegExp('`(CREATE TABLE IF NOT EXISTS '+table+'[\\s\\S]*?)`'));assert.ok(match);await db(match[1]);
  }
  await db('ALTER TABLE stay_calendar ADD COLUMN qty_base INT NULL');
  await db('ALTER TABLE booking_orders ADD COLUMN paid_payment_order_id BIGINT NULL,ADD COLUMN latest_refund_id BIGINT NULL,ADD COLUMN refund_status VARCHAR(24),ADD COLUMN refunded_at DATETIME');
  await db('CREATE TABLE accounts(id VARCHAR(64) PRIMARY KEY,idp_type VARCHAR(16),idp_subject VARCHAR(64))');
  await db("INSERT INTO accounts VALUES('owner','beike','fixture-ucid')");
  await db('CREATE TABLE jz_vendors(id INT PRIMARY KEY,pay_merchant_no VARCHAR(64))');
  await db("INSERT INTO jz_vendors VALUES(1,'fixture-merchant')");
  await db('CREATE TABLE units(id INT PRIMARY KEY,project_id INT,sort_order INT DEFAULT 0,ext TEXT)');
  const c=await createConnection();try{await migrate(c);}finally{await c.end();}
  const payments=new Map(),refunds=new Map(),calls={create:[],query:[],refundCreate:[],refundQuery:[],close:[]};
  const gateway={
    async createC2BOrder(p){calls.create.push(p);await new Promise(resolve=>setTimeout(resolve,45));payments.set(p.appOrderId,{appOrderId:p.appOrderId,appCode:p.appCode,projectCode:p.projectCode,merchantNo:p.recAndShareInfo.merchantNo,amount:p.amount,orderStatus:'10'});return{errno:0,data:{cashierUrl:'https://fixture.invalid/cashier/'+p.appOrderId}};},
    async queryOrder(p){calls.query.push(p);assert.ok(payments.has(p.appOrderId),'Only an existing mock provider payment is queried');return{errno:0,data:{...payments.get(p.appOrderId)}};},
    async closeOrder(p){calls.close.push(p);const row=payments.get(p.businessOrderNo);if(row&&row.orderStatus!=='30')row.orderStatus='40';return{errno:0,data:{accepted:true}};},
    async refundOrder(p){calls.refundCreate.push(p);refunds.set(p.appOrderId,{appOrderId:p.appOrderId,appCode:p.appCode,projectCode:p.projectCode,merchantNo:p.shareOrderInfos[0].merchantNo,refundAmount:p.refundAmount,orderStatus:'10'});return{errno:0,data:{accepted:true}};},
    async queryRefundOrder(p){calls.refundQuery.push(p);assert.ok(refunds.has(p.businessOrderNo));return{errno:0,data:{...refunds.get(p.businessOrderNo)}};},
  };
  const config={PAY_APP_CODE:'fixture-app',PAY_PROJECT_CODE:'fixture-project',PAY_SHARE_BIZ_CODE:'fixture-share',PAY_NOTIFY_URL:'https://fixture.invalid/notify',PAY_USER_TYPE:'2',PAY_COMPAT_WAIT_MS:'3000',PAY_POLL_SECONDS:'1'};
  const service=createPaymentService({createConnection,config,payCenter:gateway,logger:{warn(){}},jobHandlers:{booking_webhook:async()=>{}}});
  const account={id:'owner',idp_type:'beike',idp_subject:'fixture-ucid'};
  let serial=0;
  async function booking(channel='minsu'){
    const id=++serial,orderNo='BKG-COMPAT-'+id;
    await db(`INSERT INTO booking_orders(order_no,project_id,unit_id,channel,owner_vendor_id,user_id,contact_name,contact_phone,checkin,checkout,nights,rooms,price_total,status,pay_status,payment_expires_at,created_at,updated_at)
      VALUES(?,?,?, ?,1,'owner','测试住客','13800000000','2099-10-02','2099-10-04',2,1,246,'pending','unpaid','2040-01-01 00:00:00','2026-09-30 14:00:00','2026-09-30 14:00:00')`,[orderNo,id,id,channel]);
    await db('INSERT INTO units(id,project_id,ext) VALUES(?,?,?)',[id,id,JSON.stringify({cancel_policy:{enabled:true,days_before:1,cutoff_time:'18:00'}})]);
    for(const day of ['2099-10-02','2099-10-03'])await db("INSERT INTO stay_calendar(project_id,unit_id,stay_date,status,booked_qty,source) VALUES(?,?,?,'open',1,'booking')",[id,id,day]);
    return orderNo;
  }
  const input=orderNo=>({orderNo,contactPhone:'13800000000',account,cashierType:'2',clientIp:'127.0.0.1'});
  async function legacyAttempt(orderNo,state,cashierType='2'){
    const appId='XD_'+crypto.randomBytes(10).toString('hex');
    const inserted=await db(`INSERT INTO payment_orders(biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,share_biz_code,cashier_type,pay_status,pay_method,pay_no,callback_url,cashier_url,created_at,updated_at)
      VALUES(?,?,'246.00','fixture-ucid','2','fixture-merchant','fixture-share',?,?,'OLD_METHOD',?,'https://fixture.invalid/notify',?,'2026-09-30 14:00:00','2026-09-30 14:00:00')`,[orderNo,appId,cashierType,state,'provider-'+appId,'https://fixture.invalid/'+appId]);
    payments.set(appId,{appOrderId:appId,appCode:'fixture-app',projectCode:'fixture-project',merchantNo:'fixture-merchant',amount:'246.00',orderStatus:state==='closed'?'40':'10'});
    return {id:inserted.insertId,appId};
  }
  const router=createBookingRouter({readBody:async req=>req.body,requestSession:async req=>req.session===null?null:{role:'user',account:req.account||account},
    getPaymentService:()=>service,getBookingPaymentAdapter:()=>service.bookingAdapter,jsonReply:(res,data,status=200)=>Object.assign(res,{data,status})});
  const http=async(path,body,extra={})=>{const response={};await router(path,'',{method:'POST',headers:{},socket:{remoteAddress:'127.0.0.1'},body,...extra},response);return response;};

  await t.test('all public legacy service methods are still callable',()=>{
    for(const name of ['createOrReusePayment','queryPayment','createOrReuseRefund','requestRefund','queryRefund','closePaymentByOrder','runPaymentCompensation','handleNotify','advancePaymentState','advanceRefundState','generateAppOrderId'])assert.equal(typeof service[name],'function',name);
    assert.match(service.generateAppOrderId('XD'),/^XD_\d{14}_\d{6}$/);
  });
  await t.test('minsu and rental old HTTP clients without keys receive immediate URL and old fields',async()=>{
    for(const channel of ['minsu','rental']){
      const orderNo=await booking(channel),out=await http('/api/juzhu/booking/pay',{order_no:orderNo,contact_phone:'13800000000',cashier_type:channel==='minsu'?'1':'2'});
      assert.equal(out.status,200,JSON.stringify(out.data));assert.equal(out.data.ok,true);assert.equal(out.data.order_no,orderNo);
      assert.equal(out.data.pay_status,'paying');assert.equal(out.data.payStatus,'paying');assert.ok(out.data.cashier_url.startsWith('https://fixture.invalid/'));
      assert.equal(out.data.cashierUrl,out.data.cashier_url);assert.equal(out.data.appOrderId,out.data.app_order_id);
      assert.equal((await db('SELECT pay_status FROM booking_orders WHERE order_no=?',[orderNo]))[0].pay_status,'paying');
    }
  });
  await t.test('parallel no-key old clients get one attempt and one provider creation',async()=>{
    const orderNo=await booking(),before=calls.create.length;
    const outputs=await Promise.all(Array.from({length:6},()=>service.createOrReusePayment(input(orderNo))));
    assert.equal(new Set(outputs.map(out=>out.appOrderId)).size,1);assert.equal(calls.create.length-before,1);
    assert.ok(outputs.every(out=>out.cashierUrl&&out.payStatus==='paying'));
    assert.equal((await db('SELECT id FROM payment_orders WHERE biz_order_no=?',[orderNo])).length,1);
  });
  await t.test('parallel equal and distinct request keys converge without duplicate provider creation',async()=>{
    for(const equal of [true,false]){
      const orderNo=await booking(),before=calls.create.length;
      const outputs=await Promise.all(Array.from({length:5},(_,i)=>service.createOrReusePayment({...input(orderNo),requestKey:'explicit-request-'+orderNo+'-'+(equal?'same':i)})));
      assert.equal(new Set(outputs.map(out=>String(out.paymentId))).size,1);
      await service.core.runJobs(1,{kind:'pay_create',targetId:outputs[0].paymentId});
      assert.equal(calls.create.length-before,1);assert.equal((await db('SELECT id FROM payment_orders WHERE biz_order_no=?',[orderNo])).length,1);
    }
  });
  let paidOrder,paidOutput;
  await t.test('legacy HTTP query returns orderStatus 30 only after authoritative query and business projection',async()=>{
    paidOrder=await booking('rental');paidOutput=await service.createOrReusePayment(input(paidOrder));
    payments.get(paidOutput.appOrderId).orderStatus='30';payments.get(paidOutput.appOrderId).payMethod='WECHAT';payments.get(paidOutput.appOrderId).payNo='fixture-provider-reference';
    const out=await http('/api/juzhu/payment/query',{order_no:paidOrder,contact_phone:'13800000000',app_order_id:paidOutput.appOrderId});
    assert.equal(out.status,200,JSON.stringify(out.data));assert.equal(out.data.result.orderStatus,'30');assert.equal(out.data.result.payMethod,'WECHAT');
    assert.equal(out.data.order_pay_status,'paid');assert.equal(out.data.fulfillment_status,'fulfilled');
    const row=(await db('SELECT pay_status,paid_payment_order_id FROM booking_orders WHERE order_no=?',[paidOrder]))[0];
    assert.equal(row.pay_status,'paid');assert.equal(String(row.paid_payment_order_id),String(paidOutput.paymentId));
  });
  await t.test('legacy app_order_id lookup still checks the requested order, owner and contact phone',async()=>{
    const other=await booking(),before=calls.query.length;
    const mismatch=await http('/api/juzhu/payment/query',{order_no:other,app_order_id:paidOutput.appOrderId});assert.equal(mismatch.status,404);
    const wrongOwner=await http('/api/juzhu/payment/query',{order_no:paidOrder},{account:{...account,id:'another'}});assert.equal(wrongOwner.status,403);
    const wrongPhone=await http('/api/juzhu/booking/pay',{order_no:paidOrder,contact_phone:'13900000000',cashier_type:'2'});assert.equal(wrongPhone.status,404);
    const anonymous=await http('/api/juzhu/payment/query',{order_no:paidOrder},{session:null});assert.equal(anonymous.status,401);
    assert.equal(calls.query.length,before);
  });
  await t.test('old refund create, request, query and repeated calls retain one original RF number',async()=>{
    const first=await service.createOrReuseRefund(paidOutput.paymentId,'booking_cancel','user');
    const repeated=await service.createOrReuseRefund(paidOutput.paymentId,'booking_cancel','user');
    assert.equal(first.refund.app_order_id,repeated.refund.app_order_id);
    assert.equal(first.refund.payer_ucid,'fixture-ucid');assert.equal(first.refund.merchant_no,'fixture-merchant');
    const before=calls.refundCreate.length;
    await service.requestRefund(first.refund,first.payment);await service.requestRefund(repeated.refund,repeated.payment);
    assert.equal(calls.refundCreate.length-before,1);
    refunds.get(first.refund.app_order_id).orderStatus='30';
    const queried=await service.queryRefund(first.refund);assert.equal(queried.data.orderStatus,'30');
    assert.equal((await db('SELECT pay_status,refund_status FROM booking_orders WHERE order_no=?',[paidOrder]))[0].pay_status,'refunded');
    const final=await service.createOrReuseRefund(paidOutput.paymentId,'booking_cancel','user');assert.equal(final.refund.app_order_id,first.refund.app_order_id);
    await service.queryRefund(final.refund);assert.equal(calls.refundCreate.length-before,1);
  });
  await t.test('old callbacks recover missing guards and only authoritative queries can mark business paid',async()=>{
    const orderNo=await booking(),appId='XD_'+crypto.randomBytes(10).toString('hex');
    const inserted=await db(`INSERT INTO payment_orders(biz_order_no,app_order_id,amount,payer_ucid,payer_user_type,merchant_no,share_biz_code,cashier_type,pay_status,callback_url,cashier_url,created_at,updated_at)
      VALUES(?,?,'246.00','fixture-ucid','2','fixture-merchant','fixture-share','2','paying','https://fixture.invalid/notify','https://fixture.invalid/legacy','2026-09-30 14:00:00','2026-09-30 14:00:00')`,[orderNo,appId]);
    payments.set(appId,{appOrderId:appId,appCode:'fixture-app',projectCode:'fixture-project',merchantNo:'fixture-merchant',amount:'246.00',orderStatus:'10'});
    const forged={appOrderId:appId,appCode:'fixture-app',projectCode:'fixture-project',orderStatus:'30'};
    assert.equal(await service.handleNotify(forged),'SUCCESS');assert.equal(await service.handleNotify(forged),'SUCCESS');
    assert.equal((await db('SELECT biz_order_no FROM payment_order_guards WHERE biz_order_no=?',[orderNo])).length,1);
    const first=await service.queryPayment({orderNo,account});assert.equal(first.data.orderStatus,'10');
    assert.notEqual((await db('SELECT pay_status FROM booking_orders WHERE order_no=?',[orderNo]))[0].pay_status,'paid');
    payments.get(appId).orderStatus='30';await service.advancePaymentState({id:inserted.insertId},{data:{orderStatus:'10'}},'legacy');
    assert.equal((await db('SELECT pay_status FROM booking_orders WHERE order_no=?',[orderNo]))[0].pay_status,'paid');
    assert.equal((await db('SELECT id FROM payment_notify_log WHERE app_order_id=?',[appId])).length,1);
  });
  await t.test('old close API closes through the worker and releases inventory once',async()=>{
    const orderNo=await booking(),out=await service.createOrReusePayment(input(orderNo));
    const result=await service.closePaymentByOrder(orderNo,'booking_cancel');
    assert.equal(result.payment.app_order_id,out.appOrderId);
    await service.queryPayment({orderNo,account});await service.closePaymentByOrder(orderNo,'booking_cancel');
    const row=(await db('SELECT status,project_id FROM booking_orders WHERE order_no=?',[orderNo]))[0];assert.equal(row.status,'cancelled');
    assert.equal((await db('SELECT id FROM stay_calendar WHERE project_id=?',[row.project_id])).length,0);
  });
  await t.test('querying historical P1 returns its IDs and provider fields while status describes current P2',async()=>{
    const orderNo=await booking(),first=await legacyAttempt(orderNo,'closed','1'),second=await legacyAttempt(orderNo,'paying','2');
    const result=await service.queryPayment({orderNo,appOrderId:first.appId,account});
    assert.equal(result.data.appOrderId,first.appId);assert.equal(result.data.app_order_id,first.appId);
    assert.equal(String(result.data.payment_id),String(first.id));assert.equal(result.data.orderStatus,'40');assert.equal(result.data.pay_status,'closed');
    assert.equal(result.data.payNo,'provider-'+first.appId);assert.equal(result.data.payMethod,'OLD_METHOD');
    assert.equal(result.data.cashier_type,'1');assert.equal(result.data.cashier_url,null);
    assert.equal(result.status.app_order_id,second.appId);assert.equal(result.status.pay_status,'paying');assert.equal(result.status.order_pay_status,'unpaid');
  });
  await t.test('a newer closed attempt cannot hide an older active attempt from legacy close',async()=>{
    const orderNo=await booking(),active=await legacyAttempt(orderNo,'paying'),closed=await legacyAttempt(orderNo,'closed');
    const before=calls.close.length;
    const result=await service.closePaymentByOrder(orderNo,'booking_cancel');
    assert.equal(calls.close.length-before,1);assert.equal(calls.close.at(-1).businessOrderNo,active.appId);
    assert.equal(result.pending,false);assert.equal(result.result.data.orderStatus,'40');
    assert.ok((await db('SELECT pay_status FROM payment_orders WHERE biz_order_no=?',[orderNo])).every(row=>row.pay_status==='closed'));
    const row=(await db('SELECT status,project_id FROM booking_orders WHERE order_no=?',[orderNo]))[0];assert.equal(row.status,'cancelled');
    assert.equal((await db('SELECT id FROM stay_calendar WHERE project_id=?',[row.project_id])).length,0);
    await service.closePaymentByOrder(orderNo,'booking_cancel');assert.equal(calls.close.length-before,1);
    assert.notEqual(active.appId,closed.appId);
  });
});
