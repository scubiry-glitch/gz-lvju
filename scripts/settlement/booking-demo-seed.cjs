'use strict';
const assert=require('node:assert/strict'),P=require('../../server/settlement/primitives.cjs');
const BASE='settlement-walkthrough-v1',KEY='booking-walkthrough-v1',PARTY='demo-stay';
const q=async(c,s,a=[])=>(await c.execute(s,a))[0],request=label=>KEY+':'+label;
async function seed(pool,{now=Date.now}={}){
 await require('../../server/settlement/index.cjs').migrate(pool);
 const [base]=await q(pool,"SELECT manifest FROM commerce_settlement_walkthrough_runs WHERE seed_key=? AND status='READY'",[BASE]);assert(base,'Initialize the base walkthrough first');
 const manifest=P.parse(base.manifest),lock=await pool.getConnection();
 try{
  const [[held]]=await lock.query("SELECT GET_LOCK(CONCAT(DATABASE(),':',?),10) held",[KEY]);assert.equal(Number(held.held),1);
   const [old]=await q(pool,"SELECT * FROM commerce_settlement_walkthrough_runs WHERE seed_key=?",[KEY]);if(old?.status==='READY')return {...await ensureBillday(pool,{now,manifest:P.parse(old.manifest)}),reused:true};
  // Add a narrow booking role; never replace existing user roles or permissions.
  const defs=require('./demo-accounts.cjs').definitions;
  await P.transaction(pool,async c=>{for(const name of ['operator','reviewer','reviewer2','merchant']){
   const role='settlement_stay_'+name,label='民宿结算走查·'+name,scope={level:'all',party_ids:[PARTY]},[existing]=await q(c,'SELECT * FROM roles WHERE role_code=? FOR UPDATE',[role]);
   if(existing){assert.equal(existing.name,label);assert.equal(Number(existing.builtin),0);assert.deepEqual(P.parse(existing.permissions),defs[name].permissions);}else await c.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[role,label,JSON.stringify(defs[name].permissions)]);
   const aid=manifest.actors[name].account_id,[membership]=await q(c,'SELECT scope FROM account_roles WHERE account_id=? AND role_code=?',[aid,role]);if(membership)assert.deepEqual(P.parse(membership.scope),scope);else await c.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[aid,role,JSON.stringify(scope)]);
  }});
  const auth=require('../../commerce/db.cjs').initAuth(pool),actor=async name=>({type:'account',...await auth.getAccountWithRoles(manifest.actors[name].account_id)}),maker=await actor('operator'),reviewer=await actor('reviewer');
  const config={JUZHU_ENV:'test',SETTLEMENT_DEMO_ENABLED:'1',SETTLEMENT_ENABLED:'0',SETTLEMENT_WORKER_ENABLED:'0'},service=require('../../server/settlement/index.cjs').createSettlement({pool,auth,config,now,payCenter:new Proxy({},{get:()=>()=>{throw Error('No real provider permitted');}})});
  const result={seed_key:KEY,base_seed_key:BASE,generated_at:new Date(now()).toISOString(),party_id:PARTY,scenarios:[],statements:[],policy_ids:[]};
  await pool.execute("INSERT INTO commerce_settlement_walkthrough_runs(seed_key,status,manifest) VALUES(?,'RUNNING',?) ON DUPLICATE KEY UPDATE status='RUNNING'",[KEY,JSON.stringify(result)]);
  async function provision(kind,label,input){const r=await service.configuration.create(maker,{kind,...input,request_key:request(label)});await service.configuration.approve(reviewer,{kind,id:r.id,request_key:request('approve:'+label)});return r.id;}
  const account=await provision('accounts','merchant-account',{party_id:PARTY,provider:'SYTEST_MOCK',environment:'SANDBOX',merchant_no:'MOCK-DEMO-STAY',contract_no:'DEMO-FUNDS-2026',currency:'CNY',capabilities:{demo_seed_key:BASE,party_name:'山海旅居民宿（演示）',account_label:'山海旅居民宿结算账户（演示）',receive:true,operations:['SPLIT','RELEASE','RETURN','PAYOUT'],evidence_ref:'演示凭证：民宿机构能力准入'}});
  const profileInput={party_name:'山海旅居民宿（演示）',demo:{seed_key:BASE},contract_ref:'演示合同-民宿预订-202610',calculation:{mode:'PROPORTIONAL',commission_bps:1000,channel_bps:2000,rounding:'FLOOR_BPS_V1'},recognition_policy:{mode:'BOOKING_CHECKOUT_DELAY'},funding_mode:'CONTROLLED_COLLECTION',source_account_id:manifest.accounts['demo-platform'],merchant_account_id:account,platform_account_id:manifest.accounts['demo-platform'],contract_no:'DEMO-FUNDS-2026',collection:{mapping_version:'sytest-mock-v1',provider:'SYTEST_MOCK',environment:'SANDBOX',contract_no:'DEMO-FUNDS-2026',source_merchant_no:'MOCK-DEMO-PLATFORM'},contract_mapping_version:'sytest-mock-v1',funding_evidence_ref:'演示凭证：民宿受控原款',settlement_delay_hours:0,expires_at:'2026-12-31T15:59:59Z'};
  const profileId=await provision('profiles','booking-profile',{party_id:PARTY,biz_type:'booking',payment_mode:'pay_center',snapshot:profileInput}),[saved]=await q(pool,'SELECT * FROM commerce_settlement_profiles WHERE id=?',[profileId]);
  const baseProfile={...P.parse(saved.snapshot),profile_id:profileId,party_id:PARTY,version:Number(saved.version)};
  for(const [name,mode,priority,conditions]of [['auto','AUTO',100,{booking_checkout_delay_days:3}],['review','REVIEW',200,{booking_checkout_delay_days:3,min_minor:'100000',line_kind:'merchant'}]]){
   const r=await service.workflow.savePolicy(maker,{party_id:PARTY,biz_type:'booking',payment_mode:'pay_center',mode,priority,conditions,nodes:[{name:'民宿离店及售后复核',mode:'ANY',approver_ids:[manifest.actors.reviewer.account_id]}],request_key:request('policy:'+name)});await service.workflow.publishPolicy(reviewer,{id:r.id,request_key:request('publish:'+name)});result.policy_ids.push(r.id);
  }
  const cases=[['paid','49800','2026-09-26','pay_center','confirmed'],['review','189800','2026-09-28','pay_center','confirmed'],['waiting','129800','2026-10-01','pay_center','confirmed'],['staying','89800','2026-10-04','pay_center','confirmed'],['offline','68800','2026-09-29','offline','confirmed'],['cancelled','59800','2026-10-02','offline','cancelled']];
  for(const [name,amount,checkout,mode,status]of cases){
   const order='DEMO-STAY-'+name.toUpperCase(),fee=(BigInt(amount)/10n).toString(),booking={order_no:order,checkin:new Date(Date.parse(checkout+'T00:00:00Z')-2*86400000).toISOString().slice(0,10),checkout,rooms:1,nights:2,price_total:(Number(amount)/100).toFixed(2),commission_rate:'10.00',commission_fee:(Number(fee)/100).toFixed(2)},profile={...baseProfile,contract_calculation:baseProfile.calculation,calculation:{mode:'FIXED_COST',fixed_cost_minor:(BigInt(amount)-BigInt(fee)).toString(),fixed_commission_minor:fee,channel_bps:2000,rounding:'FLOOR_BPS_V1',source:'BOOKING_ORDER_COMMISSION_SNAPSHOT'}};
   let ctx,source;
   await P.transaction(pool,async c=>{
    ctx=await require('../../server/settlement/business.cjs').registerContext(c,{biz_type:'booking',source_order_system:'settlement_walkthrough',biz_order_no:order,party_id:PARTY,payment_mode:mode,snapshot:{demo:{seed_key:BASE,extension:KEY,auto_settle:false,scenario:'SUCCESS'},booking,settlement_profile:mode==='pay_center'?profile:null}});
    const fact={booking,quoted_minor:amount,commission_minor:fee,order_status:status,pay_status:mode==='pay_center'?'paid':'offline',source_created_at:'2026-09-20 02:00:00',simulated:true},[prior]=await q(c,'SELECT id FROM commerce_booking_statement_facts WHERE context_id=? LIMIT 1',[ctx.id]);if(!prior)await c.execute('INSERT INTO commerce_booking_statement_facts(id,context_id,snapshot_hash,snapshot,recorded_at) VALUES(?,?,?,?,?)',[P.id(),ctx.id,P.hash(fact),JSON.stringify(fact),P.sqlDate(now())]);
    if(mode!=='pay_center')return;
    [source]=await q(c,"SELECT * FROM commerce_funding_sources WHERE context_id=? AND source_type='PAYMENT'",[ctx.id]);if(source)return;
    source={id:P.id(),received_minor:amount};await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,NULL,'PAYMENT','SYTEST_MOCK','SANDBOX','CNY',?,'DEMO-FUNDS-2026',?,'AVAILABLE',?)",[source.id,ctx.id,manifest.accounts['demo-platform'],amount,JSON.stringify({demo_seed_key:BASE,provider_ref:'MOCK-'+order,evidence_ref:'演示凭证：民宿预订原款'})]);
    await P.postLedger(c,{event_key:request('receipt:'+name),context_id:ctx.id,source_type:'walkthrough_receipt',source_id:source.id,lines:[{side:'debit',account:'settlement_cash:'+source.id,amount_minor:amount},{side:'credit',account:'service_pending_liability',amount_minor:amount}]});
   });
   if(mode==='pay_center'&&checkout<=new Date(now()+8*3600000).toISOString().slice(0,10)){
    await P.transaction(pool,c=>require('../../server/settlement/business.cjs').recognize(c,{ctx,source,profile,unit_key:order,recognition_id:request('checkout:'+name),amount_minor:amount,evidence:{source:'BOOKING_CHECKOUT_DATE',checkout,simulated:true,demo_seed_key:BASE},promoter_account_id:manifest.actors.promoter.account_id}));
    let items=await q(pool,'SELECT * FROM commerce_settlement_items WHERE context_id=? ORDER BY id',[ctx.id]);
    for(const i of items){if(i.status!=='DRAFT')continue;const policy=await service.workflow.selectPolicy(pool,ctx,i);if(policy){const timing=require('../../server/settlement/booking-policy.cjs').dueAt(ctx,policy);await pool.execute("UPDATE commerce_settlement_items SET not_before_at=? WHERE id=? AND status='DRAFT'",[timing.not_before_at,i.id]);}}
    for(const i of items.filter(i=>i.line_kind!=='promoter'))await service.workflow.authorizeItem(maker,{id:String(i.id),expected_revision:Number(i.revision),request_key:request('authorize:'+i.id)});
    if(name==='paid'){
     async function execute(ids,label){const plan=await service.execution.createPlan(maker,{item_ids:ids,request_key:request('execute:'+label)}),orders=await q(pool,'SELECT id FROM commerce_execution_orders WHERE plan_id=?',[plan.id]);await service.execution.runJobs({limit:20,order_ids:orders.map(o=>o.id)});}
     await execute(items.filter(i=>i.line_kind!=='promoter').map(i=>String(i.id)),name);
     const [promoter]=await q(pool,"SELECT * FROM commerce_settlement_items WHERE context_id=? AND line_kind='promoter'",[ctx.id]);await service.workflow.authorizeItem(maker,{id:String(promoter.id),expected_revision:Number(promoter.revision),request_key:request('channel:'+promoter.id)});await execute([String(promoter.id)],name+'-channel');
    }
   }
   result.scenarios.push({name,order_no:order,context_id:ctx.id,payment_mode:mode,checkout,booking_checkout_delay_days:3,amount_minor:amount,commission_minor:fee});
  }
  for(const [party,modes]of [[PARTY,['pay_center','offline']],['demo-promoter',['pay_center']],['demo-platform',['pay_center']]]){
   const input={party_id:party,biz_types:['booking'],payment_modes:modes,period_start:'2026-09-01',period_end:'2026-11-01',request_key:request('statement:'+party)},s=await service.statements.generateStatement(maker,input);result.statements.push({party_id:party,id:s.id,summary:s.summary});await service.statements.setStatementPolicy(maker,{party_id:party,biz_types:['booking'],payment_modes:modes,request_key:request('monthly:'+party)});
  }
  result.item_ids=(await q(pool,"SELECT i.id FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts c ON c.id=i.context_id WHERE JSON_UNQUOTE(JSON_EXTRACT(c.snapshot,'$.demo.extension'))=?",[KEY])).map(i=>String(i.id));
  result.profile_id=profileId;
  await pool.execute("UPDATE commerce_settlement_walkthrough_runs SET status='READY',manifest=? WHERE seed_key=?",[JSON.stringify(result),KEY]);
  // 账单日（T+N 账期）+ 长租品类场景：全新种子与已就绪走查共用同一段幂等扩展。
  return ensureBillday(pool,{now,manifest:await refreshed()});
  async function refreshed(){const [row]=await q(pool,'SELECT manifest FROM commerce_settlement_walkthrough_runs WHERE seed_key=?',[KEY]);return P.parse(row.manifest);}
 }finally{await lock.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':',?))",[KEY]).catch(()=>{});lock.release();}
}
// 账单日（T+N 账期）+ 长租品类扩展：给 demo-stay 增设 账单日=25 的 AUTO 规则（金额 ≥¥4000 专属，
// 不改变既有六场景的规则命中），新增已离店长租订单 DEMO-STAY-BILLDAY（已过 N=3 资格日、
// 等待账单日随账单批量结算），重出商户账单并登记出账策略——出账周期的账单日从结算规则派生。幂等可重跑。
async function ensureBillday(pool,{now=Date.now,manifest,keySuffix=''}={}){
 await require('../../server/settlement/index.cjs').migrate(pool);
 const [base]=await q(pool,"SELECT manifest FROM commerce_settlement_walkthrough_runs WHERE seed_key=? AND status='READY'",[BASE]);assert(base,'Initialize the base walkthrough first');
 const [run]=await q(pool,"SELECT manifest,status FROM commerce_settlement_walkthrough_runs WHERE seed_key=?",[KEY]);assert(run?.status==='READY','Initialize the booking walkthrough first');
 const current=manifest||P.parse(run.manifest);
 if(current.scenarios?.some(s=>s.name==='billday'))return current;
 const baseManifest=P.parse(base.manifest),actors=current.actors||baseManifest.actors,accounts=current.accounts||baseManifest.accounts;
 assert(actors&&actors.operator&&actors.reviewer&&actors.promoter,'Base walkthrough manifest lacks actors');
 const auth=require('../../commerce/db.cjs').initAuth(pool),actor=async name=>({type:'account',...await auth.getAccountWithRoles(actors[name].account_id)}),maker=await actor('operator'),reviewer=await actor('reviewer');
 const config={JUZHU_ENV:'test',SETTLEMENT_DEMO_ENABLED:'1',SETTLEMENT_ENABLED:'0',SETTLEMENT_WORKER_ENABLED:'0'},service=require('../../server/settlement/index.cjs').createSettlement({pool,auth,config,now,payCenter:new Proxy({},{get:()=>()=>{throw Error('No real provider permitted');}})});
 let billPolicyId=(await q(pool,"SELECT id FROM commerce_settlement_policies WHERE party_id=? AND biz_type='booking' AND status='approved' AND JSON_EXTRACT(conditions,'$.billing_day') IS NOT NULL ORDER BY created_at DESC LIMIT 1",[PARTY]))[0]?.id;
 if(!billPolicyId){
  const r=await service.workflow.savePolicy(maker,{party_id:PARTY,biz_type:'booking',payment_mode:'pay_center',mode:'AUTO',priority:300,conditions:{booking_checkout_delay_days:3,billing_day:25,min_minor:'400000'},nodes:[{name:'民宿离店及售后复核',mode:'ANY',approver_ids:[actors.reviewer.account_id]}],request_key:request('policy:billday')});
  await service.workflow.publishPolicy(reviewer,{id:r.id,request_key:request('publish:billday')});billPolicyId=r.id;
 }
 const order='DEMO-STAY-BILLDAY',amount='498000',fee=(BigInt(amount)/10n).toString(),checkout='2026-10-01';
 const booking={order_no:order,checkin:new Date(Date.parse(checkout+'T00:00:00Z')-2*86400000).toISOString().slice(0,10),checkout,rooms:1,nights:2,price_total:(Number(amount)/100).toFixed(2),commission_rate:'10.00',commission_fee:(Number(fee)/100).toFixed(2),category:'rental',category_label:'长租'};
 const [profileRow]=await q(pool,"SELECT id,version,snapshot FROM commerce_settlement_profiles WHERE party_id=? AND biz_type='booking' AND status='approved' ORDER BY version DESC LIMIT 1",[PARTY]);assert(profileRow,'booking profile missing');
 const baseProfile={...P.parse(profileRow.snapshot),profile_id:profileRow.id,party_id:PARTY,version:Number(profileRow.version)},profile={...baseProfile,contract_calculation:baseProfile.calculation,calculation:{mode:'FIXED_COST',fixed_cost_minor:(BigInt(amount)-BigInt(fee)).toString(),fixed_commission_minor:fee,channel_bps:2000,rounding:'FLOOR_BPS_V1',source:'BOOKING_ORDER_COMMISSION_SNAPSHOT'}};
 let ctx,source;
 await P.transaction(pool,async c=>{
  ctx=await require('../../server/settlement/business.cjs').registerContext(c,{biz_type:'booking',source_order_system:'settlement_walkthrough',biz_order_no:order,party_id:PARTY,payment_mode:'pay_center',snapshot:{demo:{seed_key:BASE,extension:KEY,auto_settle:false,scenario:'SUCCESS'},booking,settlement_profile:profile}});
  const fact={booking,quoted_minor:amount,commission_minor:fee,order_status:'confirmed',pay_status:'paid',source_created_at:'2026-09-20 02:00:00',simulated:true},[prior]=await q(c,'SELECT id FROM commerce_booking_statement_facts WHERE context_id=? LIMIT 1',[ctx.id]);if(!prior)await c.execute('INSERT INTO commerce_booking_statement_facts(id,context_id,snapshot_hash,snapshot,recorded_at) VALUES(?,?,?,?,?)',[P.id(),ctx.id,P.hash(fact),JSON.stringify(fact),P.sqlDate(now())]);
  [source]=await q(c,"SELECT * FROM commerce_funding_sources WHERE context_id=? AND source_type='PAYMENT'",[ctx.id]);
  if(!source){source={id:P.id(),received_minor:amount};await c.execute("INSERT INTO commerce_funding_sources(id,context_id,payment_id,source_type,provider,environment,currency,account_id,contract_no,received_minor,status,evidence) VALUES(?,?,NULL,'PAYMENT','SYTEST_MOCK','SANDBOX','CNY',?,'DEMO-FUNDS-2026',?,'AVAILABLE',?)",[source.id,ctx.id,baseProfile.platform_account_id||accounts['demo-platform'],amount,JSON.stringify({demo_seed_key:BASE,provider_ref:'MOCK-'+order,evidence_ref:'演示凭证：长租预订原款（账单日演示）'})]);
   await P.postLedger(c,{event_key:request('receipt:billday'),context_id:ctx.id,source_type:'walkthrough_receipt',source_id:source.id,lines:[{side:'debit',account:'settlement_cash:'+source.id,amount_minor:amount},{side:'credit',account:'service_pending_liability',amount_minor:amount}]});}
 });
 if(checkout<=new Date(now()+8*3600000).toISOString().slice(0,10)){
  await P.transaction(pool,async c=>{
   const [fulfilled]=await q(c,"SELECT id FROM commerce_settlement_fulfillment WHERE context_id=? AND event_kind='BOOKING_CHECKOUT_DATE'",[ctx.id]);if(fulfilled)return;
   const unit=await require('../../server/settlement/business.cjs').recognize(c,{ctx,source,profile,unit_key:order,recognition_id:request('checkout:billday'),amount_minor:amount,evidence:{source:'BOOKING_CHECKOUT_DATE',checkout,simulated:true,demo_seed_key:BASE,billing_day:25},promoter_account_id:actors.promoter.account_id});
   const items=await q(c,'SELECT * FROM commerce_settlement_items WHERE unit_id=? ORDER BY id',[unit.id]);
   for(const i of items){if(i.status!=='DRAFT')continue;const policy=await service.workflow.selectPolicy(pool,ctx,i);if(policy){const timing=require('../../server/settlement/booking-policy.cjs').dueAt(ctx,policy);await c.execute("UPDATE commerce_settlement_items SET not_before_at=? WHERE id=? AND status='DRAFT'",[timing.not_before_at,i.id]);}}
  });
 }
 const statement=await service.statements.generateStatement(maker,{party_id:PARTY,biz_types:['booking'],payment_modes:['pay_center','offline'],period_start:'2026-09-01',period_end:'2026-11-01',request_key:request('statement:billday'+keySuffix)});
 await service.statements.setStatementPolicy(maker,{party_id:PARTY,biz_types:['booking'],payment_modes:['pay_center','offline'],request_key:request('monthly:billday'+keySuffix)});
 const itemIds=(await q(pool,"SELECT i.id FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts c ON c.id=i.context_id WHERE c.id=?",[ctx.id])).map(i=>String(i.id));
 const updated={...current,billing_day:25,profile_id:current.profile_id||profileRow.id,
  policy_ids:[...new Set([...(current.policy_ids||[]).map(String),String(billPolicyId)])],
  item_ids:[...new Set([...(current.item_ids||[]).map(String),...itemIds])],
  scenarios:[...current.scenarios.filter(s=>s.name!=='billday'),{name:'billday',order_no:order,context_id:ctx.id,category:'rental',category_label:'长租',payment_mode:'pay_center',checkout,booking_checkout_delay_days:3,billing_day:25,amount_minor:amount,commission_minor:fee}],
  statements:[...current.statements.filter(s=>s.party_id!==PARTY),{party_id:PARTY,id:statement.id,summary:statement.summary}]};
 await pool.execute("UPDATE commerce_settlement_walkthrough_runs SET manifest=? WHERE seed_key=?",[JSON.stringify(updated),KEY]);
 return updated;
}
async function main(){assert(process.argv.includes('--target')&&process.argv[process.argv.indexOf('--target')+1]==='sytest');assert.equal(process.env.JUZHU_ENV,'test');assert.equal(process.env.COMMERCE_PUBLIC_ORIGIN,'https://sytest.meizu.life');const config=require('../../commerce/db.cjs').config();assert.equal(config.database,'juzhu');const pool=require('mysql2/promise').createPool({...config,dateStrings:true,bigNumberStrings:true,connectionLimit:10});try{console.log(JSON.stringify(await seed(pool),null,2));}finally{await pool.end();}}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});module.exports={seed,ensureBillday,KEY};
