'use strict';
const P=require('./primitives.cjs');
const {assert,id,parse,hash,minor,rows,sqlDate,calculate,postLedger,transaction}=P;
const configuration=require('./configuration.cjs').createConfiguration({});
function verifyNewProfile(profile,config){
 assert(['CONTROLLED_COLLECTION','MERCHANT_CONTROLLED_RECEIPT'].includes(profile.funding_mode),'原款已自由结清的协议不能开通新收款分账',409);
 assert(!profile.expires_at||sqlDate(profile.expires_at)>sqlDate(),'结算协议已超过机构有效期限',409);
 require('./provider.cjs').paymentCollectionContract(config,{settlement_profile:profile});
 return profile;
}
async function captureProfile(c,input,config=process.env){if(config.SETTLEMENT_ENABLED!=='1')return null;const profile=await configuration.forOrder(c,input);return input.payment_mode==='pay_center'?verifyNewProfile(profile,config):profile;}
async function captureCommerceProfiles(c,order,config=process.env){
 if(config.SETTLEMENT_ENABLED!=='1')return null;
 const items=await rows(c,'SELECT merchant_id,snapshot FROM commerce_order_items WHERE order_id=? ORDER BY id',[order.id]),profiles={};
 for(const item of items){if(profiles[item.merchant_id])continue;const profile=await configuration.forOrder(c,{biz_type:'commerce',entity_id:item.merchant_id,payment_mode:'pay_center'});const locked=parse(item.snapshot).rule;
  if(profile.calculation.mode==='PROPORTIONAL')assert(Number(profile.calculation.commission_bps)===Number(locked.beike_bps)&&Number(profile.calculation.channel_bps||0)===Number(locked.channel_bps||0),'权益商品规则与结算合同版本不一致',409);
  profiles[item.merchant_id]=verifyNewProfile(profile,config);
 }
 const list=Object.values(profiles);assert(list.length,'权益缺少履约商户');
 const base=list[0];for(const p of list)assert(p.source_account_id===base.source_account_id&&p.platform_account_id===base.platform_account_id&&p.funding_mode===base.funding_mode&&p.contract_mapping_version===base.contract_mapping_version,'多商户商品原资金路线不兼容',409);
 for(const p of list)assert(p.party_id===base.party_id,'跨结算主体组合须按主体拆单，避免合同审批及资金权限混用',409,'cross_party_package_requires_separate_orders');
 return profiles;
}
async function registerContext(c,{biz_type,source_order_system,biz_order_no,party_id,payment_mode='pay_center',currency='CNY',snapshot}) {
 const [old]=await rows(c,'SELECT * FROM commerce_settlement_business_contexts WHERE biz_type=? AND source_order_system=? AND biz_order_no=? FOR UPDATE',[biz_type,source_order_system,biz_order_no]);
 if(old){assert(old.party_id===party_id&&old.payment_mode===payment_mode,'原业务结算身份冲突',409);return {...old,snapshot:parse(old.snapshot)};}
 const key=id(),scope=payment_mode==='pay_center'?'INTERNAL_FUNDED':'EXTERNAL_RECORD_ONLY';
 await c.execute('INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot) VALUES(?,?,?,?,?,?,?,?,?)',[key,biz_type,source_order_system,biz_order_no,payment_mode,scope,party_id,currency,JSON.stringify(snapshot)]);
 return {id:key,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope:scope,party_id,currency,snapshot};
}
async function funding(c,ctx,paymentId) {
 const profile=ctx.snapshot.settlement_profile;assert(ctx.execution_scope==='INTERNAL_FUNDED'&&profile,'原款没有已锁定的结算协议',409);
 const compact=ctx.biz_type==='commerce'?ctx.biz_order_no.replace(/-/g,''):ctx.biz_order_no;
 const [guard]=await rows(c,'SELECT * FROM payment_order_guards WHERE biz_type=? AND biz_order_no=? FOR UPDATE',[ctx.biz_type,compact]);
 assert(guard&&String(guard.paid_payment_id)===String(paymentId),'未找到订单接受的有效支付',409);
 const [payment]=await rows(c,'SELECT * FROM payment_orders WHERE id=? FOR UPDATE',[paymentId]);
 assert(payment&&payment.pay_status==='paid'&&payment.biz_type===ctx.biz_type,'原支付尚未成功',409);
 const [sourceAccount]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id=? AND status='approved'",[profile.source_account_id]);
 assert(sourceAccount&&sourceAccount.merchant_no===payment.merchant_no&&sourceAccount.currency===ctx.currency,'支付与结算原款账户不一致',409);
 assert(profile.funding_evidence_ref&&profile.contract_mapping_version&&profile.funding_mode!=='MERCHANT_ALREADY_SETTLED','原款资金控制未验证或已全部结清',409);
 const [existing]=await rows(c,"SELECT * FROM commerce_funding_sources WHERE payment_id=? AND source_type='PAYMENT' FOR UPDATE",[String(paymentId)]);if(existing)return existing;
 const sourceId=id(),amount=minor(payment.amount_minor);
 const refunds=await rows(c,"SELECT amount_minor,refund_status FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided' FOR UPDATE",[paymentId]);
 assert(!refunds.length,'已有退款的历史原款须独立准入，不能全额导入',409,'funding_requires_reconciliation');
 await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,?,'PAYMENT',?,?,?,?,?,?,'AVAILABLE',?)",[sourceId,ctx.id,String(paymentId),sourceAccount.provider,sourceAccount.environment,ctx.currency,sourceAccount.id,sourceAccount.contract_no||profile.contract_no,amount,JSON.stringify({payment_id:String(paymentId),provider_ref:payment.pay_no,app_order_id:payment.app_order_id,profile_id:profile.profile_id,control_evidence:profile.funding_evidence_ref})]);
 await postLedger(c,{event_key:'funding:received:'+sourceId,context_id:ctx.id,source_type:'source_receipt',source_id:sourceId,lines:[{side:'debit',account:'settlement_cash:'+sourceId,amount_minor:amount},{side:'credit',account:ctx.biz_type==='commerce'?'provider_receivable':'service_pending_liability',amount_minor:amount}]});
 return {id:sourceId,context_id:ctx.id,received_minor:amount};
}
async function onPaymentAccepted(c,{biz_type,order,guard}) {
 const snapshot=parse(biz_type==='commerce'?order.snapshot:order.payment_config_snapshot),profiles=snapshot.settlement_profiles;
 const profile=biz_type==='commerce'?Object.values(profiles||{})[0]:snapshot.settlement_profile;if(!profile)return null;
 const ctx=await registerContext(c,{biz_type,source_order_system:biz_type==='commerce'?'commerce_orders':biz_type==='booking'?'booking_orders':'jz_orders',biz_order_no:biz_type==='booking'?order.order_no:order.id,party_id:profile.party_id,snapshot:{settlement_profile:profile,...(profiles?{profiles}:{}),...(biz_type==='booking'?{booking:snapshot.booking}:{}),account_id:String(biz_type==='booking'?order.user_id:order.account_id),vendor_id:order.owner_vendor_id||order.vendor_id||null,city_id:order.city_id||null}});
 return funding(c,ctx,guard.paid_payment_id);
}
async function onRefundSucceeded(c,{biz_type,order,payload}) {
 const snapshot=parse(biz_type==='commerce'?order.snapshot:order.payment_config_snapshot);if(!snapshot.settlement_profile&&!snapshot.settlement_profiles)return false;
 const paymentId=String(payload.paymentId??payload.payment_id),refundId=String(payload.refundId??payload.refund_id);
 const [source]=await rows(c,"SELECT s.*,x.biz_order_no,x.biz_type FROM commerce_funding_sources s JOIN commerce_settlement_business_contexts x ON x.id=s.context_id WHERE s.payment_id=? AND s.source_type='PAYMENT' FOR UPDATE",[paymentId]);if(!source)return false;
 assert(source.biz_type===biz_type&&source.biz_order_no===String(biz_type==='booking'?order.order_no:order.id),'退款与原款业务身份不符',409);
 const [refund]=await rows(c,"SELECT * FROM payment_refunds WHERE id=? AND payment_order_id=? AND refund_status='refunded'",[refundId,paymentId]);assert(refund&&String(refund.amount_minor)===minor(payload.amountMinor??payload.amount_minor),'退款机构事实与金额不符',409);
 if(payload.reference?.execution_order_id){const [plan]=await rows(c,'SELECT r.payment_refund_id FROM commerce_execution_refund_plans r JOIN commerce_execution_orders o ON o.id=r.order_id WHERE o.id=? AND o.source_id=?',[payload.reference.execution_order_id,source.id]);assert(plan&&String(plan.payment_refund_id)===refundId,'执行退款关联未确认',409);}
 await postLedger(c,{event_key:'payment:refund:'+refundId,context_id:source.context_id,source_type:'payment_refund',source_id:refundId,lines:[{side:'debit',account:biz_type==='commerce'?'unredeemed_liability':'service_pending_liability',amount_minor:String(refund.amount_minor)},{side:'credit',account:'settlement_cash:'+source.id,amount_minor:String(refund.amount_minor)}]});
 if(!payload.reference?.execution_order_id){
  const [[total]]=await c.execute("SELECT COALESCE(SUM(r.amount_minor),0) amount FROM payment_refunds r WHERE r.payment_order_id=? AND r.refund_status='refunded' AND NOT EXISTS (SELECT 1 FROM commerce_execution_refund_plans p WHERE p.request_key=r.idempotency_key)",[paymentId]);
  const delta=BigInt(total.amount)-BigInt(source.external_refunded_minor||0);assert(delta>=0n,'已核验退款事实不可减少',409);
  if(delta>0n)await c.execute('UPDATE commerce_funding_sources SET returned_minor=returned_minor+?,external_refunded_minor=? WHERE id=?',[delta.toString(),String(total.amount),source.id]);
 }
 return true;
}
async function recognize(c,{ctx,unit_key,recognition_id,amount_minor,source,profile,evidence,merchant_id=null,promoter_account_id=null,coupon_id=null,redemption_id=null,order_id=null,city_id=null,already_posted=false}) {
 const [prior]=await rows(c,'SELECT * FROM commerce_settlement_units WHERE context_id=? AND unit_key=? FOR UPDATE',[ctx.id,unit_key]);if(prior){if(prior.status==='REVERSED'){unit_key=unit_key+':'+recognition_id;const [revision]=await rows(c,'SELECT * FROM commerce_settlement_units WHERE context_id=? AND unit_key=? FOR UPDATE',[ctx.id,unit_key]);if(revision)return {...revision,calculation:parse(revision.calculation)};}else{assert(prior.recognition_id===recognition_id,'同一结算单位已由其他事实确认',409);return {...prior,calculation:parse(prior.calculation)};}}
 let promoterParty=promoter_account_id?'account:'+promoter_account_id:null;
 if(promoter_account_id){const [binding]=await rows(c,"SELECT party_id FROM commerce_settlement_party_bindings WHERE source_domain='identity' AND source_entity_type='account' AND source_entity_id=? AND status='approved'",[String(promoter_account_id)]);if(binding)promoterParty=binding.party_id;}
 const rule={...profile.calculation,promoter_party_id:promoterParty,amount_minor:minor(amount_minor)};const calc=calculate(rule),unitId=id();
 const [currentSource]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=? FOR UPDATE',[source.id]);
 const allocatedRows=await rows(c,"SELECT basis_minor FROM commerce_settlement_units WHERE source_id=? AND status='CONFIRMED' ORDER BY id FOR UPDATE",[source.id]),allocated=allocatedRows.reduce((sum,r)=>sum+BigInt(r.basis_minor),0n);
 let refunds=BigInt(currentSource?.returned_minor||0);
 if(currentSource?.payment_id){const amounts=await rows(c,"SELECT amount_minor FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided' ORDER BY id FOR UPDATE",[currentSource.payment_id]);refunds=amounts.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n);}
 assert(allocated+BigInt(amount_minor)<=BigInt(source.received_minor)-refunds,'结算单位超原款净履约分配；退款后须重新核验履约金额',409);
 await c.execute("INSERT INTO commerce_settlement_units(id,context_id,unit_key,recognition_id,status,basis_minor,source_id,rule_snapshot,calculation,evidence,confirmed_at) VALUES(?,?,?,?,'CONFIRMED',?,?,?,?,?,?)",[unitId,ctx.id,unit_key,recognition_id,String(amount_minor),source.id,JSON.stringify(rule),JSON.stringify(calc),JSON.stringify(evidence),sqlDate()]);
 const [platform]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id=? AND status='approved'",[profile.platform_account_id]);assert(platform,'平台收款账户未准入',409);
 let promoterAccount=null;if(promoterParty){[promoterAccount]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE party_id=? AND currency=? AND status='approved' ORDER BY version DESC LIMIT 1",[promoterParty,ctx.currency]);}
 const components=[['merchant',profile.party_id,profile.merchant_account_id,calc.merchant_minor],['platform_transfer',platform.party_id,platform.id,calc.commission_minor],['promoter',promoterParty,promoterAccount?.id||null,calc.promoter_minor]];
 const available=sqlDate(Date.now()+Number(profile.settlement_delay_hours||0)*3600000);
 for(const [kind,party,accountId,amount] of components){if(BigInt(amount)===0n)continue;
  await c.execute("INSERT INTO commerce_settlement_items(batch_id,line_kind,redemption_id,coupon_id,order_id,merchant_id,promoter_account_id,city_id,rule_ref,basis_minor,payable_minor,status,context_id,unit_id,component_key,beneficiary_party_id,account_id,source_id,original_payable_minor,planned_minor,not_before_at) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?)",[kind,redemption_id,coupon_id,order_id,merchant_id,promoter_account_id,city_id,hash(rule),String(amount_minor),amount,ctx.id,unitId,kind,party,accountId,source.id,amount,amount,available]);
 }
 if(!already_posted){const lines=[{side:'debit',account:ctx.biz_type==='commerce'?'unredeemed_liability':'service_pending_liability',amount_minor:(BigInt(calc.merchant_minor)+BigInt(calc.commission_minor)).toString()},{side:'credit',account:'payable:'+profile.party_id,amount_minor:calc.merchant_minor},{side:'credit',account:'platform_retained',amount_minor:calc.retained_minor}];if(BigInt(calc.promoter_minor)>0n)lines.push({side:'credit',account:'payable:'+promoterParty,amount_minor:calc.promoter_minor});await postLedger(c,{event_key:'recognition:'+ctx.id+':'+recognition_id,context_id:ctx.id,source_type:'recognition',source_id:unitId,rule_ref:hash(rule),lines});}
 return {id:unitId,calculation:calc};
}
async function onRedemption(c,{coupon,order,redemption_id,merchant_id,amounts}) {
 const snapshot=parse(order.snapshot),profiles=snapshot.settlement_profiles;if(!profiles)return false;
 assert(parse(coupon.snapshot).is_demo!==true,'演示券不能进入真实结算',409);
 const profile=profiles[merchant_id];assert(profile,'实际履约商户未在购买时锁定的结算名单中',409);
 const base=Object.values(profiles)[0],ctx=await registerContext(c,{biz_type:'commerce',source_order_system:'commerce_orders',biz_order_no:order.id,party_id:base.party_id,snapshot:{settlement_profile:base,profiles,account_id:String(order.account_id),city_id:order.city_id}});
 const source=await funding(c,ctx,order.paid_payment_order_id);
 const out=await recognize(c,{ctx,unit_key:coupon.id,recognition_id:redemption_id,amount_minor:String(coupon.allocation_minor),source,profile,evidence:{coupon_id:coupon.id,redemption_id},merchant_id,promoter_account_id:order.source_account_id,coupon_id:coupon.id,redemption_id,order_id:order.id,city_id:order.city_id});
 if(amounts)assert(out.calculation.merchant_minor===String(amounts.supplier_minor)&&out.calculation.promoter_minor===String(amounts.channel_minor),'核销与锁定分账规则不一致',409);
 return out;
}
function createBusiness({pool,configuration:cfg,workflow,authorize,config={}}){
 async function acceptService(p,input){return workflow.command(p,'service.accept',input,async c=>{
  const [g]=await rows(c,"SELECT * FROM payment_order_guards WHERE biz_type='jiazheng' AND biz_order_no=? FOR UPDATE",[input.id]);assert(g&&String(g.account_id)===String(p.account.id),'服务订单不存在或不属于本人',404);
  const [o]=await rows(c,'SELECT * FROM jz_orders WHERE id=? FOR UPDATE',[input.id]);assert(o&&String(o.account_id)===String(p.account.id)&&o.payment_mode==='pay_center','订单身份不一致',403);assert(['done','rated'].includes(o.status)&&o.pay_status==='paid','服务尚未完成或未付款',409);
  assert(!o.refund_status,'订单存在退款或售后，须先完成净履约金额核验',409,'service_refund_requires_review');
  const snapshot=parse(o.payment_config_snapshot),profile=snapshot.settlement_profile;assert(profile,'历史订单缺少已锁定的结算协议，请先核验',409);
  assert(profile.recognition_policy?.mode==='CUSTOMER_ACCEPTANCE','本合同未采用客户确认规则',409);
  const ctx=await registerContext(c,{biz_type:'jiazheng',source_order_system:'jz_orders',biz_order_no:o.id,party_id:profile.party_id,snapshot:{settlement_profile:profile,account_id:String(o.account_id),vendor_id:o.vendor_id,city_id:o.city_id}});
  const [prior]=await rows(c,"SELECT * FROM commerce_settlement_fulfillment WHERE context_id=? AND event_kind='CUSTOMER_ACCEPTANCE'",[ctx.id]);if(prior)return {id:o.id,status:'confirmed',confirmation_id:prior.id};
  const source=await funding(c,ctx,g.paid_payment_id),confirmationId=id();
  await c.execute("INSERT INTO commerce_settlement_fulfillment(id,context_id,order_no,account_id,event_kind,evidence,confirmed_at) VALUES(?,?,?,?,'CUSTOMER_ACCEPTANCE',?,?)",[confirmationId,ctx.id,o.id,String(p.account.id),JSON.stringify({order_status:o.status,account_id:String(p.account.id),note:String(input.note||'客户确认服务完成').slice(0,500)}),sqlDate()]);
  const out=await recognize(c,{ctx,unit_key:o.id,recognition_id:confirmationId,amount_minor:String(o.fee),source,profile,evidence:{confirmation_id:confirmationId},merchant_id:o.vendor_id,order_id:null,city_id:o.city_id});
  await workflow.audit(c,p,'service.accept',o.id,{confirmation_id:confirmationId,unit_id:out.id});return {id:o.id,status:'confirmed',confirmation_id:confirmationId,settlement_unit_id:out.id};
 });}
 return {acceptService,captureProfile:(c,input)=>captureProfile(c,input,config)};
}
module.exports={captureProfile,captureCommerceProfiles,registerContext,funding,recognize,onRedemption,onPaymentAccepted,onRefundSucceeded,createBusiness};
