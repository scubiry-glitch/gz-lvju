'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const stay=require('../../stay_config.cjs');
const vendorRate=require('../../vendor_rate.cjs');
const {createBookingRouter}=require('../../server/routes/booking.cjs');

test('lodging exchange uses contracted amount, rejects stale quotes, and creates no payment guard',
  {skip:!process.env.PAYMENT_TEST_SOCKET,timeout:90000},async()=>{
  const socketPath=process.env.PAYMENT_TEST_SOCKET,cfg=require('../../commerce/db.cjs').config();
  const database='coupon_booking_test_'+crypto.randomBytes(5).toString('hex');
  const admin=await mysql.createConnection({socketPath,user:'root'});
  let pool;
  try{
    await admin.query('CREATE DATABASE '+mysql.escapeId(database)+' CHARACTER SET utf8mb4');
    pool=mysql.createPool({socketPath,user:'root',database,timezone:'Z',dateStrings:true,connectionLimit:6});
    for(const table of ['projects','units','stay_calendar','booking_orders','jz_vendors','commerce_orders','commerce_coupons','commerce_appointments','payment_order_guards'])
      await pool.query('CREATE TABLE '+mysql.escapeId(table)+' LIKE '+mysql.escapeId(cfg.database)+'.'+mysql.escapeId(table));
    const c=await pool.getConnection();try{await require('../../commerce/coupon-application.cjs').migrate(c);}finally{c.release();}
    await pool.query("INSERT INTO projects(id,city_id,channel,name,slug,price_from,status,rating_status,owner_vendor_id,ext) VALUES(301,3,'rental','测试酒店','hotel-test',160,'online','passed',1,?)",[JSON.stringify({online_booking:false,online_payment:true,min_stay_nights:1})]);
    await pool.query("INSERT INTO units(id,project_id,name,slug,total_qty,ext) VALUES(401,301,'单间','room',2,?)",[JSON.stringify({price_night:160})]);
    await pool.query("INSERT INTO jz_vendors(id,type,name,status,city_ids,commission_housing) VALUES(1,'housing','测试酒店商家','active','3',10)");
    const originalOrder=crypto.randomUUID(),coupon=crypto.randomUUID();
    await pool.execute("INSERT INTO commerce_orders(id,account_id,city_id,product_kind,product_id,product_version,amount_minor,status,expires_at,snapshot,payment_status,paid_payment_order_id) VALUES(?,101,3,'skus',1,1,12000,'fulfilled','2099-12-31',?,'paid',55)",[originalOrder,JSON.stringify({settlement_profiles:{1:{source_account_id:'source-account'}}})]);
    const sku={name:'单间一晚兑换券',use_mode:'exchange',exchange_contract_minor:12000,
      use_domains:['booking','jiazheng'],use_vendor_ids:[1],booking_project_ids:[301],life_product_ids:[201]};
    await pool.execute("INSERT INTO commerce_coupons(id,order_id,item_id,unit_no,account_id,merchant_id,store_id,city_id,status,expires_at,allocation_minor,snapshot) VALUES(?,?,1,1,101,1,1,3,'available','2099-12-31',12000,?)",[coupon,originalOrder,JSON.stringify({sku})]);
    const connect=()=>mysql.createConnection({socketPath,user:'root',database,timezone:'Z',dateStrings:true});
    const queryRows=async(sql,args=[])=>(await pool.execute(sql,args))[0];
    let prepared=0;
    const adapter={captureOrder:async(conn)=>{
      const snapshot={settlement_profile:{source_account_id:'source-account'}};
      return snapshot;
    },prepare:async()=>{prepared++;throw Error('zero-cash booking reached payment registration');}};
    const router=createBookingRouter({queryRows,jsonReply:(res,data,status=200)=>Object.assign(res,{data,status}),
      readBody:async req=>req.body,requestSession:async()=>({account:{id:101,idp_type:'beike',idp_subject:'test-ucid'}}),
      maskPhoneStd:x=>x,mysql2:mysql,getDbConfig:()=>({socketPath,user:'root',database,timezone:'Z',dateStrings:true}),crypto,
      stayCfg:stay,connExec:conn=>async(sql,args)=>(await conn.execute(sql,args))[0],stayNightPrices:stay.stayNightPrices,
      releaseStayQty:stay.releaseStayQty,stayDateList:stay.stayDateList,
      transactionCapabilitiesOf:stay.transactionCapabilitiesOf,minStayNightsOf:stay.minStayNightsOf,
      cancelPolicyOf:stay.cancelPolicyOf,cancelPolicyTextOf:stay.cancelPolicyTextOf,
      wholeHousePriceUnit:stay.wholeHousePriceUnit,
      fallbackUnitRowFor:async(fetchRows,unitId,projectId)=>(await fetchRows('SELECT id,ext,rent_monthly FROM units WHERE project_id=? ORDER BY sort_order,id LIMIT 1',[projectId]))[0]||null,
      orderCancelInfoOf:()=>({can_cancel:true,cancel_policy_text:'可取消',cancel_deadline:null}),
      settingValue:async()=>10,vendorRate,getBookingPaymentAdapter:()=>adapter,notifyVendorBooking:()=>{},getPaymentService:()=>({})});
    const input={project_id:301,unit_id:401,rooms:1,checkin:'2099-10-02',checkout:'2099-10-03',
      contact_name:'测试住客',contact_phone:'13800000000',transaction_mode:'payment',coupon_id:coupon};
    const call=async(path,body)=>{const response={};await router(path,'',{method:'POST',headers:{},body},response);return response;};
    const quote=await call('/api/juzhu/booking/coupon-quotes',input);
    assert.equal(quote.status,200,JSON.stringify(quote.data));
    assert.equal(quote.data.gross_minor,16000);
    assert.equal(quote.data.quotes[0].listed_minor,16000);
    assert.deepEqual([quote.data.quotes[0].gross_minor,quote.data.quotes[0].coupon_minor,quote.data.quotes[0].cash_minor],[12000,12000,0]);
    const stale=await call('/api/juzhu/booking',{...input,coupon_quote_gross_minor:11000});
    assert.equal(stale.status,409,JSON.stringify(stale.data));
    assert.equal(Number((await queryRows('SELECT COUNT(*) n FROM booking_orders'))[0].n),0);
    const result=await call('/api/juzhu/booking',{...input,coupon_quote_gross_minor:12000});
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.price_total,120);assert.equal(result.data.cash_due_minor,0);
    assert.equal(result.data.pay_status,'coupon_funded');assert.equal(prepared,0);
    const [order]=await queryRows('SELECT price_total,coupon_minor,cash_due_minor,pay_status FROM booking_orders WHERE order_no=?',[result.data.order_no]);
    assert.deepEqual([Number(order.price_total),Number(order.coupon_minor),Number(order.cash_due_minor),order.pay_status],[120,12000,0,'coupon_funded']);
    assert.equal(Number((await queryRows("SELECT COUNT(*) n FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=?",[result.data.order_no]))[0].n),0);
    assert.equal(Number((await queryRows('SELECT SUM(booked_qty) n FROM stay_calendar WHERE project_id=301'))[0].n),1);
  }finally{if(pool)await pool.end();await admin.query('DROP DATABASE IF EXISTS '+mysql.escapeId(database));await admin.end();}
});
