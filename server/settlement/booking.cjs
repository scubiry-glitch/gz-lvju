'use strict';

const {assert,id,parse,hash,minor,rows,sqlDate,transaction}=require('./primitives.cjs');
const business=require('./business.cjs');
const configuration=require('./configuration.cjs').createConfiguration({});
const bookingPolicy=require('./booking-policy.cjs');
const vendorRate=require('../../vendor_rate.cjs');

function decimalMinor(value,label){
 const match=String(value??'').match(/^(\d+)(?:\.(\d{1,2}))?$/);
 assert(match,label+'缺少有效的下单快照',409,'booking_snapshot_invalid');
 return minor(BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0')));
}
function dateOnly(value){
 const s=String(value||'');assert(/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s,'预订日期快照无效',409,'booking_snapshot_invalid');return s;
}
// 品类（预订/长租）取自项目 channel；projects 表不在（隔离测试库）或项目缺失时记 NULL，不阻塞结算。
async function projectChannel(c,projectId){
 if(projectId==null)return null;
 const installed=await rows(c,"SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects'");if(!installed.length)return null;
 const [project]=await rows(c,'SELECT channel FROM projects WHERE id=?',[projectId]);
 return project?.channel==null?null:String(project.channel);
}
function bookingSnapshot(order,channel){
 const amount=decimalMinor(order.price_total,'房费'),commission=decimalMinor(order.commission_fee,'佣金金额'),rate=decimalMinor(order.commission_rate,'佣金费率');
 assert(BigInt(amount)>0n&&BigInt(rate)<=10000n&&BigInt(commission)<=BigInt(amount),'预订佣金快照超出范围',409,'booking_snapshot_invalid');
 // Rule 20 makes the stored fee authoritative. Check the rate only as an
 // admission invariant; recognition never recalculates it from a live profile.
 const recordedFee=decimalMinor(vendorRate.commissionAmountOf(order.price_total,order.commission_rate).toFixed(2),'下单佣金');
 assert(recordedFee===commission,'预订佣金金额与下单费率快照不一致',409,'booking_commission_mismatch');
 const checkin=dateOnly(order.checkin),checkout=dateOnly(order.checkout);assert(checkin<checkout,'预订离店日期须晚于入住日期',409,'booking_snapshot_invalid');
 const category=bookingPolicy.categoryOf(channel);
 return {id:String(order.id),order_no:String(order.order_no),owner_vendor_id:String(order.owner_vendor_id),category,category_label:bookingPolicy.categoryLabel(category),checkin,checkout,rooms:Number(order.rooms||1),nights:Number(order.nights||Math.round((Date.parse(checkout)-Date.parse(checkin))/86400000)),price_total:String(order.price_total),commission_rate:String(order.commission_rate),commission_fee:String(order.commission_fee),amount_minor:amount,commission_minor:commission,commission_bps:Number(rate),commission_basis:'BOOKING_ORDER_COMMISSION_SNAPSHOT'};
}

// Called exactly once inside the booking creation transaction, never while
// admitting a historical payment attempt. A missing opt-in preserves legacy.
async function captureBookingSnapshot(c,order,{config=process.env,payment_mode=order.pay_status==null?'offline':'pay_center'}={}){
 assert(['pay_center','offline'].includes(payment_mode),'预订支付模式无效');
 if(payment_mode==='pay_center'&&config.SETTLEMENT_ENABLED!=='1')return null;
 const installed=await rows(c,"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('commerce_settlement_profiles','commerce_settlement_party_bindings','commerce_settlement_business_contexts')");
 if(installed.length!==3)return null;
 let approved;
 try{approved=await configuration.forOrder(c,{biz_type:'booking',entity_id:order.owner_vendor_id,payment_mode});}
 catch(e){if(e.code==='settlement_profile_missing')return null;throw e;}
 assert(approved.recognition_policy?.mode==='BOOKING_CHECKOUT_DELAY','预订合同须采用按订单离店日期结算',409,'booking_recognition_invalid');
 if(payment_mode==='pay_center'){
  assert(['CONTROLLED_COLLECTION','MERCHANT_CONTROLLED_RECEIPT'].includes(approved.funding_mode),'预订原款已自由结清，不能开通受控分账',409);
  assert(!approved.expires_at||sqlDate(approved.expires_at)>sqlDate(),'预订结算协议已过期',409);
  require('./provider.cjs').paymentCollectionContract(config,{settlement_profile:approved});
 }
 const booking=bookingSnapshot(order,await projectChannel(c,order.project_id)),calculation={...approved.calculation,mode:'FIXED_COST',fixed_cost_minor:(BigInt(booking.amount_minor)-BigInt(booking.commission_minor)).toString(),fixed_commission_minor:booking.commission_minor,booking_commission_basis:booking.commission_basis,booking_commission_rate:booking.commission_rate};
 const profile={...approved,contract_calculation:approved.calculation,calculation,rule_hash:hash(calculation),settlement_delay_hours:0};
 const snapshot={booking,settlement_profile:profile};
 if(payment_mode==='offline')await business.registerContext(c,{biz_type:'booking',source_order_system:'booking_orders',biz_order_no:order.order_no,party_id:profile.party_id,payment_mode,snapshot:{...snapshot,account_id:order.user_id==null?null:String(order.user_id),vendor_id:order.owner_vendor_id,city_id:order.city_id||null}});
 return snapshot;
}

function createBookingSettlement({pool,workflow,authorize,config=process.env,now=Date.now}){
 let cursor='0';
 async function recognizeOrder(p,orderId){return transaction(pool,async c=>{
  // The same guard -> business order -> payment -> refunds -> source order as
  // the cashier. Reading the identifier first takes no row lock.
  const [observed]=await rows(c,'SELECT order_no FROM booking_orders WHERE id=?',[orderId]);if(!observed)return {id:String(orderId),status:'SKIPPED'};
  const [guard]=await rows(c,"SELECT * FROM payment_order_guards WHERE biz_type='booking' AND biz_order_no=? FOR UPDATE",[observed.order_no]);
  const [order]=await rows(c,'SELECT * FROM booking_orders WHERE id=? FOR UPDATE',[orderId]);
  assert(order&&order.status==='confirmed'&&order.pay_status==='paid'&&!order.refund_status,'预订订单尚未确认付款或存在退款',409,'booking_not_eligible');
  const snapshot=parse(order.payment_config_snapshot),profile=snapshot.settlement_profile;
  assert(profile&&profile.recognition_policy?.mode==='BOOKING_CHECKOUT_DELAY'&&snapshot.booking,'预订订单没有下单冻结的结算协议',409,'booking_snapshot_missing');
  await authorize(p,'settlement.fund.write',{biz_type:'booking',payment_mode:'pay_center',party_id:profile.party_id});
  const frozen=snapshot.booking,current=bookingSnapshot(order,frozen.category!=null?(await projectChannel(c,order.project_id)??frozen.category):null);
  for(const key of ['order_no','owner_vendor_id','checkin','checkout','amount_minor','commission_minor','commission_bps','rooms','nights',...(frozen.category!=null?['category']:[])])assert(frozen[key]===current[key],'预订订单关键资料与下单快照不一致',409,'booking_snapshot_changed');
  const checkout=bookingPolicy.dueAt({biz_type:'booking',snapshot},{id:null,version:0,conditions:{booking_checkout_delay_days:0}});
  assert(checkout.not_before_at<=sqlDate(now()),'尚未到订单离店日期',409,'booking_checkout_not_due');
  assert(guard&&guard.lifecycle==='paid'&&guard.paid_payment_id!=null&&String(guard.paid_payment_id)===String(order.paid_payment_order_id)&&String(guard.account_id)===String(order.user_id)&&String(guard.amount_minor)===frozen.amount_minor,'预订订单接受的支付身份不一致',409,'booking_payment_mismatch');
  const guardSnapshot=parse(guard.snapshot);
  assert(hash(guardSnapshot.settlement_profile||null)===hash(profile)&&hash(guardSnapshot.booking||null)===hash(frozen),'预订支付契约不是下单冻结版本',409,'booking_payment_snapshot_mismatch');
  const [payment]=await rows(c,'SELECT * FROM payment_orders WHERE id=? FOR UPDATE',[guard.paid_payment_id]);
  assert(payment&&payment.biz_type==='booking'&&payment.biz_order_no===order.order_no&&payment.pay_status==='paid'&&String(payment.amount_minor)===frozen.amount_minor&&payment.merchant_no===guard.merchant_no,'预订原支付与订单不一致',409,'booking_payment_mismatch');
  const refunds=await rows(c,"SELECT id FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided' ORDER BY id FOR UPDATE",[payment.id]);
  assert(!refunds.length,'预订原支付存在退款，须先核验净履约金额',409,'booking_refund_requires_review');
  const source=await business.onPaymentAccepted(c,{biz_type:'booking',order,guard});
  const [rawContext]=await rows(c,"SELECT * FROM commerce_settlement_business_contexts WHERE biz_type='booking' AND source_order_system='booking_orders' AND biz_order_no=? FOR UPDATE",[order.order_no]);
  assert(source&&rawContext,'预订原款尚未登记',409,'booking_funding_missing');
  const ctx={...rawContext,snapshot:parse(rawContext.snapshot)};
  assert(hash(ctx.snapshot.settlement_profile)===hash(profile)&&hash(ctx.snapshot.booking)===hash(frozen),'预订结算上下文与订单快照不一致',409,'booking_context_mismatch');
  const [prior]=await rows(c,"SELECT * FROM commerce_settlement_fulfillment WHERE context_id=? AND event_kind='BOOKING_CHECKOUT_DATE' FOR UPDATE",[ctx.id]);
  if(prior){const [unit]=await rows(c,'SELECT id,status FROM commerce_settlement_units WHERE context_id=? AND recognition_id=? FOR UPDATE',[ctx.id,prior.id]);assert(unit,'离店认定记录缺少结算单位',409);return {id:order.order_no,status:'EXISTING',settlement_unit_id:unit.id};}
  assert(profile.calculation?.mode==='FIXED_COST'&&profile.calculation.fixed_commission_minor===frozen.commission_minor&&BigInt(profile.calculation.fixed_cost_minor)+BigInt(frozen.commission_minor)===BigInt(frozen.amount_minor),'预订结算金额与下单佣金快照不一致',409,'booking_commission_mismatch');
  const recognition=id(),evidence={source:'BOOKING_CHECKOUT_DATE',timezone:'Asia/Shanghai',checkout:frozen.checkout,checkout_boundary_at:checkout.not_before_at,order_status:order.status,accepted_payment_id:String(payment.id),commission_rate:frozen.commission_rate,commission_fee:frozen.commission_fee,observed_at:sqlDate(now())};
  await c.execute("INSERT INTO commerce_settlement_fulfillment(id,context_id,order_no,account_id,event_kind,evidence,confirmed_at) VALUES(?,?,?,?,'BOOKING_CHECKOUT_DATE',?,?)",[recognition,ctx.id,order.order_no,String(order.user_id),JSON.stringify(evidence),sqlDate(now())]);
  const unit=await business.recognize(c,{ctx,unit_key:order.order_no,recognition_id:recognition,amount_minor:frozen.amount_minor,source,profile,evidence:{...evidence,confirmation_id:recognition},city_id:order.city_id||null});
  // Initialize every actual component with the same policy selector used for
  // authorization, including Q while its commission funding lot is not ready.
  // No approval, authorization or financial transport is invoked here.
  const items=await rows(c,'SELECT * FROM commerce_settlement_items WHERE unit_id=? ORDER BY id',[unit.id]);
  for(const item of items){const policy=await workflow.selectPolicy(c,ctx,item),timing=policy?bookingPolicy.dueAt(ctx,policy):checkout;await c.execute('UPDATE commerce_settlement_items SET not_before_at=? WHERE id=?',[timing.not_before_at,item.id]);}
  await workflow.audit(c,p,'booking.checkout.recognize',order.order_no,{confirmation_id:recognition,unit_id:unit.id,evidence});
  return {id:order.order_no,status:'RECOGNIZED',settlement_unit_id:unit.id,calculation:unit.calculation};
 });}
 async function runDue(p,{limit=50,after_id}={}){
  await authorize(p,'settlement.fund.write',{});
  const size=Number(limit);assert(Number.isInteger(size)&&size>=1&&size<=500,'预订扫描数量无效');
  const exists=await rows(pool,"SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='booking_orders'");if(!exists.length)return {rows:[],count:0,has_more:false,next_after_id:'0'};
  const start=String(after_id??cursor);assert(/^\d+$/.test(start),'预订扫描游标无效');
  const today=new Date(new Date(now()).getTime()+8*3600000).toISOString().slice(0,10);
  const candidates=await rows(pool,"SELECT o.id FROM booking_orders o WHERE o.id>? AND o.status='confirmed' AND o.pay_status='paid' AND o.checkout<=? AND JSON_EXTRACT(o.payment_config_snapshot,'$.settlement_profile') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commerce_settlement_fulfillment f JOIN commerce_settlement_business_contexts x ON x.id=f.context_id WHERE x.biz_type='booking' AND x.source_order_system='booking_orders' AND x.biz_order_no COLLATE utf8mb4_general_ci=o.order_no COLLATE utf8mb4_general_ci AND f.event_kind='BOOKING_CHECKOUT_DATE') ORDER BY o.id LIMIT ?",[start,today,String(size)]);
  const out=[];for(const order of candidates){try{out.push(await recognizeOrder(p,order.id));}catch(e){if(!e.status||e.status>=500)throw e;out.push({id:String(order.id),status:'BLOCKED',code:e.code||'booking_settlement_blocked'});}}
  const next=candidates.length?String(candidates.at(-1).id):'0';if(after_id==null)cursor=candidates.length===size?next:'0';
  return {rows:out,count:out.length,has_more:candidates.length===size,next_after_id:next};
 }
 return {runDue,captureBookingSnapshot:(c,order,options={})=>captureBookingSnapshot(c,order,{...options,config})};
}
module.exports={createBookingSettlement,captureBookingSnapshot,bookingSnapshot};
