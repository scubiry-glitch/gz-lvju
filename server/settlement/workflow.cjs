'use strict';
const P=require('./primitives.cjs');
const {assert,id,parse,hash,minor,sqlDate,transaction,rows,calculate,postLedger}=P;
function createWorkflow({pool,authorize,now=Date.now,config={}}) {
 const clock=()=>sqlDate(now()), actor=p=>String(p.account.id), tx=fn=>transaction(pool,fn);
 const audit=(c,p,action,resource,payload)=>c.execute('INSERT INTO commerce_settlement_audit(actor_id,action,resource_id,payload) VALUES(?,?,?,?)',[actor(p),action,String(resource),JSON.stringify(payload)]);
 async function command(p,operation,input,fn) {
  assert(p?.account?.id&&p.account.status!=='disabled'&&p.account.status!=='suspended','账号不可用',403);
  // Replays are responses to a new authenticated request, not an authorization cache.
  let resource=input,permission=null;
  if(operation.startsWith('item.')){const row=await item(pool,input.id);resource=await context(pool,row.context_id);permission=operation==='item.adjust'?'settlement.fund.adjust':'settlement.fund.write';}
  else if(operation==='approval.action'){const [a]=await rows(pool,'SELECT item_id FROM commerce_settlement_approval_instances WHERE id=?',[input.id]);assert(a,'审批不存在',404);resource=await context(pool,(await item(pool,a.item_id)).context_id);permission='settlement.approval.act';}
  else if(['policy.publish','policy.disable'].includes(operation)){const [r]=await rows(pool,'SELECT * FROM commerce_settlement_policies WHERE id=?',[input.id]);assert(r,'策略不存在',404);resource=r;permission=operation==='policy.publish'?'settlement.policy.review':'settlement.policy.write';}
  else if(operation==='policy.create')permission='settlement.policy.write';
  else if(operation.startsWith('configuration.approve.')){const tables={accounts:'commerce_payment_accounts',profiles:'commerce_settlement_profiles',bindings:'commerce_settlement_party_bindings'},table=tables[input.kind];assert(table,'配置类型无效');const [r]=await rows(pool,`SELECT * FROM ${table} WHERE id=?`,[input.id]);assert(r,'配置不存在',404);resource=r;permission='settlement.policy.review';}
  else if(operation.startsWith('configuration.'))permission='settlement.policy.write';
  else if(operation==='service.accept'){const [o]=await rows(pool,'SELECT account_id FROM jz_orders WHERE id=?',[input.id]);assert(o&&String(o.account_id)===actor(p),'服务订单不存在',404);}
  if(permission)await authorize(p,permission,resource);
  const key=String(input.request_key||''); assert(/^[A-Za-z0-9_.:-]{8,128}$/.test(key),'请提供有效 Idempotency-Key');
  const content={...input}; delete content.request_key; const fingerprint=hash(content);
  return tx(async c=>{
   await c.execute('INSERT INTO commerce_settlement_requests(actor_id,operation,request_key,payload_hash) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE request_key=request_key',[actor(p),operation,key,fingerprint]);
   const [request]=await rows(c,'SELECT * FROM commerce_settlement_requests WHERE actor_id=? AND operation=? AND request_key=? FOR UPDATE',[actor(p),operation,key]);
   assert(request.payload_hash===fingerprint,'同一请求键内容冲突',409,'idempotency_conflict');
   if(request.result!=null)return parse(request.result);
   const result=await fn(c); await c.execute('UPDATE commerce_settlement_requests SET result=? WHERE id=?',[JSON.stringify(result),request.id]); return result;
  });
 }
 async function context(c,key,lock=false){const [r]=await rows(c,`SELECT * FROM commerce_settlement_business_contexts WHERE id=?${lock?' FOR UPDATE':''}`,[key]);assert(r,'业务上下文不存在',404);r.snapshot=parse(r.snapshot);return r;}
 async function item(c,key,lock=false){const [r]=await rows(c,`SELECT * FROM commerce_settlement_items WHERE id=? AND context_id IS NOT NULL${lock?' FOR UPDATE':''}`,[key]);assert(r,'结算明细不存在',404);return r;}
 function remaining(i){return BigInt(i.payable_minor)-BigInt(i.cancelled_minor||0)-BigInt(i.discharged_minor||0)-BigInt(i.reserved_minor||0)-BigInt(i.offset_minor||0);}
 async function permit(p,permission,ctx){return authorize(p,permission,ctx);}
 async function detail(p,input){const i=await item(pool,input.id),ctx=await context(pool,i.context_id);await permit(p,'settlement.fund.read',ctx);
  return {...i,biz_type:ctx.biz_type,payment_mode:ctx.payment_mode,remaining_minor:remaining(i).toString(),context:ctx,authorizations:await rows(pool,'SELECT * FROM commerce_settlement_authorizations WHERE item_id=? ORDER BY created_at DESC',[i.id]),adjustments:await rows(pool,'SELECT * FROM commerce_settlement_adjustments WHERE item_id=? ORDER BY created_at DESC',[i.id])};}
 async function listItems(p,input={}) {const args=[],where=['i.context_id IS NOT NULL'];for(const k of ['biz_type','payment_mode','party_id'])if(input[k]){where.push(`c.${k}=?`);args.push(input[k]);}
  const candidates=await rows(pool,`SELECT i.*,c.biz_type,c.payment_mode,c.party_id,c.execution_scope FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts c ON c.id=i.context_id WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 500`,args),out=[];
  for(const r of candidates){try{await permit(p,'settlement.fund.read',r);out.push({...r,remaining_minor:remaining(r).toString()});}catch(e){if(e.status!==403)throw e;}}
  return {rows:out};
 }
 async function invalidate(c,i) {
  assert(!['SUBMITTING','PROCESSING','UNKNOWN'].includes(i.status)&&BigInt(i.reserved_minor||0)===0n,'明细已进入资金执行，请先查原单或撤销未发送计划',409,'item_in_flight');
  await c.execute("UPDATE commerce_settlement_authorizations SET status='REVOKED' WHERE item_id=? AND status='ACTIVE'",[i.id]);
  await c.execute("UPDATE commerce_settlement_approval_instances SET status='SUPERSEDED' WHERE item_id=? AND status='PENDING'",[i.id]);
 }
 async function account(c,accountId,party,currency){const [a]=await rows(c,"SELECT * FROM commerce_payment_accounts WHERE id=? AND status='approved'",[accountId]);assert(a&&a.party_id===party&&a.currency===currency,'收款账户未准入或不属于受益主体',409,'account_unavailable');return a;}
 async function supplementCapacity(c,source,lock=false){
  const existing=await rows(c,`SELECT payable_minor,discharged_minor,reserved_minor,cancelled_minor,offset_minor FROM commerce_settlement_items WHERE source_id=? ORDER BY id${lock?' FOR UPDATE':''}`,[source.id]);
  const committed=existing.reduce((n,i)=>n+remaining(i),0n);
  return BigInt(source.received_minor)-BigInt(source.consumed_minor)-BigInt(source.reserved_minor)-BigInt(source.returned_minor)-committed;
 }
 async function ownSourcePermission(c,p,ctx,source,permission){const [payer]=await rows(c,'SELECT party_id FROM commerce_payment_accounts WHERE id=?',[source.account_id]);assert(payer,'补差资金付款主体缺失',409);await permit(p,permission,{...ctx,party_id:payer.party_id});}
 async function authSnapshot(c,i,ctx,policy) {
  const profile=ctx.snapshot.settlement_profile||{};
  const selected=i.account_id?await account(c,i.account_id,i.beneficiary_party_id,ctx.currency):null;
  return {item_id:String(i.id),item_revision:Number(i.revision),amount_minor:minor(i.planned_minor??i.payable_minor),source_id:i.source_id||null,account_id:i.account_id||null,account_version:Number(selected?.version||0),not_before_at:sqlDate(i.not_before_at),context_id:i.context_id,policy_id:policy?.id||null,policy_version:Number(policy?.version||0),rule_hash:i.rule_ref,profile_version:Number(profile.version||0),funding_mode:profile.funding_mode||null,implicit_merchant_release:Boolean(profile.implicit_merchant_release)};
 }
 async function grant(c,i,ctx,policy,mode) {
  assert(ctx.execution_scope==='INTERNAL_FUNDED','外部账单不能签发资金授权',409,'execution_scope_denied');
  const amount=BigInt(i.planned_minor??i.payable_minor);assert(amount>0n&&amount<=remaining(i),'本次金额超过剩余应付',409);
  assert(i.account_id,'尚未选择已准入收款账户',409);const snapshot=await authSnapshot(c,i,ctx,policy);
  const authHash=require('./execution.cjs').authorizationHash(snapshot),authorizationId=id();
  await c.execute("INSERT INTO commerce_settlement_authorizations(id,item_id,item_revision,mode,purpose,hash,snapshot,status,expires_at) VALUES(?,?,?,?,'FUND_EXECUTION',?,?,'ACTIVE',?)",[authorizationId,i.id,i.revision,mode,authHash,JSON.stringify(snapshot),ctx.snapshot.settlement_profile?.expires_at?sqlDate(ctx.snapshot.settlement_profile.expires_at):null]);
  await c.execute("UPDATE commerce_settlement_items SET authorization_id=?,status='AUTHORIZED',hold_reason=NULL WHERE id=?",[authorizationId,i.id]);
  return {id:String(i.id),status:'AUTHORIZED',authorization_id:authorizationId,revision:Number(i.revision)};
 }
 function normalizeNodes(nodes){assert(Array.isArray(nodes)&&nodes.length>0&&nodes.length<=10,'人工审批至少配置一个节点');return nodes.map(n=>{assert(n&&typeof n.name==='string'&&n.name.length<=80,'节点名称无效');assert(['ANY','ALL'].includes(n.mode||'ANY'),'会签方式无效');const ids=[...new Set((n.approver_ids||[]).map(String))];assert(ids.length<=30&&((n.mode||'ANY')!=='ALL'||ids.length>0),'会签必须指定审批人');return {name:n.name,mode:n.mode||'ANY',approver_ids:ids};});}
 async function selectPolicy(c,ctx,i){
  const candidates=await rows(c,"SELECT * FROM commerce_settlement_policies WHERE status='approved' AND biz_type=? AND payment_mode=? AND (party_id IS NULL OR party_id=?) ORDER BY priority DESC",[ctx.biz_type,ctx.payment_mode,ctx.party_id]);
  const amount=BigInt(i.planned_minor??i.payable_minor),matched=candidates.filter(p=>{const v=parse(p.conditions);return (v.min_minor==null||amount>=BigInt(v.min_minor))&&(v.max_minor==null||amount<=BigInt(v.max_minor))&&(!v.line_kind||v.line_kind===i.line_kind);});
  if(!matched.length)return null;
  assert(matched.length===1||Number(matched[0].priority)!==Number(matched[1].priority),'同级结算策略冲突，需处理后授权',409,'policy_conflict');return matched[0];
 }
 async function openApproval(c,p,i,ctx,policy,purpose='FUND_EXECUTION',snapshot={}) {
  const instanceId=id(),nodes=policy?normalizeNodes(parse(policy.nodes,[])):[{name:'财务独立复核',mode:'ANY',approver_ids:[]}];
  await c.execute("INSERT INTO commerce_settlement_approval_instances(id,item_id,item_revision,policy_id,purpose,status,nodes,created_by,snapshot) VALUES(?,?,?,?,?,'PENDING',?,?,?)",[instanceId,i.id,i.revision,policy?.id||null,purpose,JSON.stringify(nodes),actor(p),JSON.stringify(snapshot)]);
  await c.execute("UPDATE commerce_settlement_items SET status='IN_REVIEW' WHERE id=?",[i.id]);
  return {id:String(i.id),revision:Number(i.revision),status:'IN_REVIEW',approval_id:instanceId};
 }
 async function authorizeItem(p,input){return command(p,'item.authorize',input,async c=>{
  const i=await item(c,input.id,true),ctx=await context(c,i.context_id);await permit(p,'settlement.fund.write',ctx);assert(Number(input.expected_revision)===Number(i.revision),'明细版本已变化',409);
  assert(ctx.execution_scope==='INTERNAL_FUNDED','外部记录仅用于对账',409,'execution_scope_denied');assert(!i.hold_reason,'明细暂缓中，请先处理暂缓原因',409);
  const active=(await rows(c,"SELECT id,expires_at FROM commerce_settlement_authorizations WHERE item_id=? AND item_revision=? AND status='ACTIVE'",[i.id,i.revision]))[0];
  if(active){const used=await rows(c,"SELECT id FROM commerce_execution_lines WHERE authorization_id=? AND status='SUCCEEDED' LIMIT 1",[active.id]);if(!used.length&&(!active.expires_at||sqlDate(active.expires_at)>clock()))return {id:String(i.id),status:'AUTHORIZED',authorization_id:active.id,revision:Number(i.revision)};}
  await invalidate(c,i);
  if(i.line_kind==='promoter'){
   const [bound]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=?',[i.source_id]);
   if(!['supplement','platform_own'].includes(bound?.source_type)&&(bound?.source_type!=='PLATFORM_COMMISSION'||BigInt(bound.received_minor)-BigInt(bound.reserved_minor)-BigInt(bound.consumed_minor)-BigInt(bound.returned_minor)<BigInt(i.planned_minor))){
    const lots=await rows(c,"SELECT s.* FROM commerce_commission_funding_lots l JOIN commerce_funding_sources s ON s.id=l.source_id WHERE l.context_id=? AND l.unit_id=? AND l.status='AVAILABLE' ORDER BY l.created_at,l.id FOR UPDATE",[i.context_id,i.unit_id]);
    const lot=lots.find(s=>BigInt(s.received_minor)-BigInt(s.reserved_minor)-BigInt(s.consumed_minor)-BigInt(s.returned_minor)>=BigInt(i.planned_minor));
    assert(lot,'平台佣金尚未到账或可用批次不足',409,'commission_funding_pending');
    await c.execute('UPDATE commerce_settlement_items SET source_id=?,revision=revision+1,authorization_id=NULL WHERE id=?',[lot.id,i.id]);i.source_id=lot.id;i.revision=Number(i.revision)+1;
   }
  }
  const policy=await selectPolicy(c,ctx,i);
  if(!policy||policy.mode==='HOLD'){await c.execute("UPDATE commerce_settlement_items SET status='HOLD',hold_reason=? WHERE id=?",[policy?'策略暂缓':'无已批准的结算策略',i.id]);return {id:String(i.id),status:'HOLD'};}
  // Any material manual change always uses independent review, even for AUTO merchants.
  const changed=(await rows(c,"SELECT id FROM commerce_settlement_adjustments WHERE item_id=? AND status='APPLIED' LIMIT 1",[i.id])).length>0;
  const limits=parse(policy.conditions);
  if(limits.cumulative_minor!=null){
   const committed=await rows(c,'SELECT i.id,i.discharged_minor,i.reserved_minor,i.planned_minor,a.status authorization_status FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts x ON x.id=i.context_id LEFT JOIN commerce_settlement_authorizations a ON a.id=i.authorization_id WHERE x.party_id=? AND x.biz_type=? ORDER BY i.id FOR UPDATE',[ctx.party_id,ctx.biz_type]);
   const total=committed.reduce((n,r)=>n+BigInt(r.discharged_minor)+BigInt(r.reserved_minor)+(String(r.id)!==String(i.id)&&r.authorization_status==='ACTIVE'&&BigInt(r.reserved_minor)===0n?BigInt(r.planned_minor):0n),0n);
   if(total+BigInt(i.planned_minor)>BigInt(limits.cumulative_minor))return openApproval(c,p,i,ctx,{...policy,nodes:JSON.stringify([{name:'累计额度复核',mode:'ANY',approver_ids:[]}])});
  }
  const out=policy.mode==='AUTO'&&!changed?await grant(c,i,ctx,policy,'AUTO'):await openApproval(c,p,i,ctx,policy);
  await audit(c,p,'item.authorize',i.id,{policy_id:policy.id,result:out});return out;
 });}
 async function preview(c,p,input,lock=false){
  const i=await item(c,input.id,lock),ctx=await context(c,i.context_id);await permit(p,'settlement.fund.adjust',ctx);assert(Number(input.expected_revision)===Number(i.revision),'明细版本已变化',409);
  assert(ctx.execution_scope==='INTERNAL_FUNDED','外部应计请使用外部调整流程',409);assert(BigInt(i.reserved_minor||0)===0n&&!['SUBMITTING','PROCESSING','UNKNOWN'].includes(i.status),'在途款不可原地修改',409);
  assert(typeof input.reason==='string'&&input.reason.trim().length>=3&&input.reason.length<=1000,'请填写调整原因');
  const kind=input.kind||'PAYMENT_ARRANGEMENT';assert(['PAYMENT_ARRANGEMENT','ENTITLEMENT_ADJUSTMENT'].includes(kind),'调整类型无效');
  const after={planned_minor:minor(input.planned_minor??i.planned_minor??i.payable_minor),account_id:input.account_id??i.account_id,not_before_at:sqlDate(input.not_before_at??i.not_before_at),delta_minor:minor(input.delta_minor??0,{signed:true}),source_id:input.source_id||i.source_id,hold_reason:input.hold_reason===null?null:input.hold_reason??i.hold_reason};
  assert(kind==='ENTITLEMENT_ADJUSTMENT'||after.delta_minor==='0','付款安排不能修改应结总额');
  const delta=BigInt(after.delta_minor),available=remaining(i);assert(delta>=-available,'已清偿金额应转追偿，不得直接调减',409);
  if(delta>0n){const [source]=await rows(c,"SELECT * FROM commerce_funding_sources WHERE id=? AND status='AVAILABLE'",[after.source_id]);assert(source&&source.context_id===ctx.id&&['platform_own','supplement'].includes(source.source_type)&&source.currency===ctx.currency&&await supplementCapacity(c,source)>=delta,'补差缺少本订单已确认的独立资金来源',409);await ownSourcePermission(c,p,ctx,source,'settlement.fund.adjust');}
  else assert(BigInt(after.planned_minor)<=available+delta,'本次计划超过可付余额',409);
  if(after.account_id)await account(c,after.account_id,i.beneficiary_party_id,ctx.currency);
  const profile=ctx.snapshot.settlement_profile||{};
  if(after.account_id!==i.account_id&&profile.funding_mode==='MERCHANT_CONTROLLED_RECEIPT'&&i.line_kind==='merchant')assert(profile.directed_transfer_verified===true,'原款模式不支持改机构收款账户，请办理机构结算银行卡变更',409);
  if(after.not_before_at&&profile.expires_at)assert(after.not_before_at<=sqlDate(profile.expires_at),'计划时间超出机构资金期限',409);
  after.payable_minor=(BigInt(i.payable_minor)+delta).toString();after.remaining_minor=(available+delta).toString();
  return {i,ctx,before:{planned_minor:String(i.planned_minor??i.payable_minor),account_id:i.account_id,not_before_at:sqlDate(i.not_before_at),payable_minor:String(i.payable_minor),remaining_minor:available.toString(),revision:Number(i.revision)},after,kind,requires_review:true};
 }
 async function previewAdjustment(p,input){const c=await pool.getConnection();try{const r=await preview(c,p,input);return {before:r.before,after:r.after,requires_review:true};}finally{c.release();}}
 async function adjust(p,input){return command(p,'item.adjust',input,async c=>{
  const r=await preview(c,p,input,true),adjustmentId=id();await invalidate(c,r.i);const revision=Number(r.i.revision)+1;
  await c.execute("UPDATE commerce_settlement_items SET revision=?,authorization_id=NULL,status='IN_REVIEW' WHERE id=?",[revision,r.i.id]);
  await c.execute("INSERT INTO commerce_settlement_adjustments(id,item_id,item_revision,kind,before_snapshot,after_snapshot,reason,evidence,status,created_by) VALUES(?,?,?,?,?,?,?,?,'PENDING',?)",[adjustmentId,r.i.id,revision,r.kind,JSON.stringify(r.before),JSON.stringify(r.after),input.reason,JSON.stringify(input.evidence||{}),actor(p)]);
  const result=await openApproval(c,p,{...r.i,revision},r.ctx,null,'ADJUSTMENT',{adjustment_id:adjustmentId});await audit(c,p,'item.adjust',r.i.id,{adjustment_id:adjustmentId,before:r.before,after:r.after});return {...result,adjustment_id:adjustmentId,before:r.before,after:r.after};
 });}
 async function applyAdjustment(c,p,instance,i,ctx){const meta=parse(instance.snapshot),[a]=await rows(c,'SELECT * FROM commerce_settlement_adjustments WHERE id=? FOR UPDATE',[meta.adjustment_id]);assert(a&&a.status==='PENDING','调整单状态已变化',409);const next=parse(a.after_snapshot),delta=BigInt(next.delta_minor);
  if(delta>0n){
   const [s]=await rows(c,'SELECT * FROM commerce_funding_sources WHERE id=? FOR UPDATE',[next.source_id]);assert(s&&s.context_id===ctx.id&&s.status==='AVAILABLE'&&await supplementCapacity(c,s,true)>=delta,'补差资金已不足或不属于本订单',409);await ownSourcePermission(c,p,ctx,s,'settlement.approval.act');
   const component='supplement:'+a.id;
   await c.execute("INSERT INTO commerce_settlement_items(batch_id,line_kind,redemption_id,coupon_id,order_id,merchant_id,promoter_account_id,city_id,rule_ref,basis_minor,payable_minor,status,context_id,unit_id,component_key,beneficiary_party_id,account_id,source_id,original_payable_minor,planned_minor,not_before_at) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?)",[i.line_kind,null,i.coupon_id,i.order_id,i.merchant_id,i.promoter_account_id,i.city_id,i.rule_ref,'0',delta.toString(),i.context_id,i.unit_id,component,i.beneficiary_party_id,next.account_id,next.source_id,delta.toString(),delta.toString(),next.not_before_at]);
   await postLedger(c,{event_key:'adjustment:'+a.id,context_id:i.context_id,source_type:'adjustment',source_id:a.id,lines:[{side:'debit',account:'platform_adjustment_expense',amount_minor:delta.toString()},{side:'credit',account:'payable:'+i.beneficiary_party_id,amount_minor:delta.toString()}]});
  }else if(delta<0n){await c.execute('UPDATE commerce_settlement_items SET cancelled_minor=cancelled_minor+? WHERE id=?',[(-delta).toString(),i.id]);await postLedger(c,{event_key:'adjustment:'+a.id,context_id:i.context_id,source_type:'adjustment',source_id:a.id,lines:[{side:'debit',account:'payable:'+i.beneficiary_party_id,amount_minor:(-delta).toString()},{side:'credit',account:'settlement_adjustment_recovery',amount_minor:(-delta).toString()}]});}
  await c.execute("UPDATE commerce_settlement_items SET planned_minor=?,account_id=?,not_before_at=?,hold_reason=?,status='DRAFT' WHERE id=?",[delta>0n?i.planned_minor:next.planned_minor,next.account_id,next.not_before_at,next.hold_reason,i.id]);
  await c.execute("UPDATE commerce_settlement_adjustments SET status='APPLIED',reviewed_by=? WHERE id=?",[actor(p),a.id]);
 }
 async function approvalTasks(p){const all=await rows(pool,"SELECT a.*,c.party_id,c.biz_type,c.payment_mode FROM commerce_settlement_approval_instances a JOIN commerce_settlement_items i ON i.id=a.item_id JOIN commerce_settlement_business_contexts c ON c.id=i.context_id WHERE a.status='PENDING' ORDER BY a.created_at LIMIT 500"),out=[];for(const a of all){try{await permit(p,'settlement.approval.act',a);const n=parse(a.nodes)[a.current_node];if(actor(p)!==a.created_by&&(!n.approver_ids.length||n.approver_ids.includes(actor(p))))out.push({...a,revision:Number(a.item_revision),node_name:n.name});}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 async function approve(p,input){return command(p,'approval.action',input,async c=>{
  const [reference]=await rows(c,'SELECT * FROM commerce_settlement_approval_instances WHERE id=?',[input.id]);assert(reference,'审批不存在',404);
  const i=await item(c,reference.item_id,true),ctx=await context(c,i.context_id);const [a]=await rows(c,'SELECT * FROM commerce_settlement_approval_instances WHERE id=? FOR UPDATE',[input.id]);await permit(p,'settlement.approval.act',ctx);
  assert(a.status==='PENDING'&&Number(a.item_revision)===Number(i.revision)&&Number(input.revision)===Number(i.revision),'审批版本已失效',409);assert(actor(p)!==a.created_by,'不能审批自己申请的事项',403);
  const nodes=parse(a.nodes),node=nodes[a.current_node];assert(!node.approver_ids.length||node.approver_ids.includes(actor(p)),'不属于当前节点审批人',403);
  assert(['approve','reject'].includes(input.action),'审批动作无效');assert(typeof input.note==='string'&&input.note.trim().length>=2,'请填写审批意见');
  await c.execute('INSERT INTO commerce_settlement_approval_actions(id,instance_id,node_index,account_id,action,note) VALUES(?,?,?,?,?,?)',[id(),a.id,a.current_node,actor(p),input.action,input.note]);
  if(input.action==='reject'){await c.execute("UPDATE commerce_settlement_approval_instances SET status='REJECTED' WHERE id=?",[a.id]);await c.execute("UPDATE commerce_settlement_items SET status='HOLD',hold_reason='审批未通过' WHERE id=?",[i.id]);if(a.purpose==='ADJUSTMENT')await c.execute("UPDATE commerce_settlement_adjustments SET status='REJECTED' WHERE id=?",[parse(a.snapshot).adjustment_id]);return {status:'REJECTED'};}
  const actions=await rows(c,"SELECT account_id FROM commerce_settlement_approval_actions WHERE instance_id=? AND node_index=? AND action='approve'",[a.id,a.current_node]);
  if(node.mode==='ALL'&&!node.approver_ids.every(x=>actions.some(y=>String(y.account_id)===x)))return {status:'PENDING',node:a.current_node};
  if(Number(a.current_node)+1<nodes.length){await c.execute('UPDATE commerce_settlement_approval_instances SET current_node=current_node+1 WHERE id=?',[a.id]);return {status:'PENDING',node:Number(a.current_node)+1};}
  let result;
  if(a.purpose==='ADJUSTMENT'){await applyAdjustment(c,p,a,i,ctx);result={status:'APPLIED',id:String(i.id)};}
  else {const [policy]=await rows(c,"SELECT * FROM commerce_settlement_policies WHERE id=? AND status='approved'",[a.policy_id]);assert(policy,'策略已停用，请重新评估',409);result=await grant(c,i,ctx,policy,'WORKFLOW');}
  await c.execute("UPDATE commerce_settlement_approval_instances SET status='APPROVED' WHERE id=?",[a.id]);await audit(c,p,'approval.complete',a.id,result);return result;
 });}
 async function savePolicy(p,input){await permit(p,'settlement.policy.write',input);return command(p,'policy.create',input,async c=>{assert(['commerce','jiazheng'].includes(input.biz_type),'业务类型无效');assert(['pay_center','wechat_mini'].includes(input.payment_mode),'支付渠道无效');assert(['AUTO','REVIEW','HOLD'].includes(input.mode),'策略模式无效');const conditions=input.conditions||{};for(const key of ['min_minor','max_minor','cumulative_minor'])if(conditions[key]!=null)conditions[key]=minor(conditions[key]);const nodes=input.mode==='REVIEW'?normalizeNodes(input.nodes):input.nodes?.length?normalizeNodes(input.nodes):[{name:'财务独立复核',mode:'ANY',approver_ids:[]}];const policyId=id();await c.execute('INSERT INTO commerce_settlement_policies(id,party_id,biz_type,payment_mode,priority,mode,conditions,nodes,created_by) VALUES(?,?,?,?,?,?,?,?,?)',[policyId,input.party_id||null,input.biz_type,input.payment_mode,Number(input.priority||0),input.mode,JSON.stringify(conditions),JSON.stringify(nodes),actor(p)]);await audit(c,p,'policy.create',policyId,input);return {id:policyId,status:'draft'};});}
 async function publishPolicy(p,input){return command(p,'policy.publish',input,async c=>{
  const [policy]=await rows(c,'SELECT * FROM commerce_settlement_policies WHERE id=? FOR UPDATE',[input.id]);assert(policy,'策略不存在',404);await permit(p,'settlement.policy.review',policy);assert(policy.created_by!==actor(p),'策略发布须独立复核',403);assert(policy.status==='draft','策略版本已发布或停用',409);
  await c.execute("UPDATE commerce_settlement_policies SET status='approved',reviewed_by=? WHERE id=?",[actor(p),policy.id]);
  await c.execute("UPDATE commerce_settlement_items i JOIN commerce_settlement_business_contexts x ON x.id=i.context_id SET i.status='DRAFT',i.hold_reason=NULL,i.revision=i.revision+1 WHERE i.status='HOLD' AND i.hold_reason IN ('无已批准的结算策略','策略暂缓') AND i.reserved_minor=0 AND x.biz_type=? AND x.payment_mode=? AND (? IS NULL OR x.party_id=?)",[policy.biz_type,policy.payment_mode,policy.party_id,policy.party_id]);
  await audit(c,p,'policy.publish',policy.id,{version:policy.version});return {...policy,status:'approved'};
 });}
 async function listPolicies(p){const all=await rows(pool,'SELECT * FROM commerce_settlement_policies ORDER BY created_at DESC LIMIT 500'),out=[];for(const r of all){try{await permit(p,'settlement.fund.read',r);out.push({...r,conditions:parse(r.conditions),nodes:parse(r.nodes)});}catch(e){if(e.status!==403)throw e;}}return {rows:out};}
 async function pausePolicy(p,input){return command(p,'policy.disable',input,async c=>{
  const [policy]=await rows(c,'SELECT * FROM commerce_settlement_policies WHERE id=? FOR UPDATE',[input.id]);assert(policy,'策略不存在',404);await permit(p,'settlement.policy.write',policy);
  await c.execute("UPDATE commerce_settlement_policies SET status='disabled' WHERE id=?",[policy.id]);
  const unused=await rows(c,"SELECT i.id,a.id auth_id FROM commerce_settlement_items i JOIN commerce_settlement_authorizations a ON a.id=i.authorization_id WHERE a.status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(a.snapshot,'$.policy_id'))=? AND i.reserved_minor=0 ORDER BY i.id FOR UPDATE",[policy.id]);
  for(const row of unused){await c.execute("UPDATE commerce_settlement_authorizations SET status='REVOKED' WHERE id=?",[row.auth_id]);await c.execute("UPDATE commerce_settlement_items SET status='DRAFT',authorization_id=NULL,revision=revision+1 WHERE id=?",[row.id]);}
  const pending=await rows(c,"SELECT a.id,a.item_id FROM commerce_settlement_approval_instances a JOIN commerce_settlement_items i ON i.id=a.item_id WHERE a.policy_id=? AND a.status='PENDING' AND i.reserved_minor=0 ORDER BY i.id FOR UPDATE",[policy.id]);
  for(const a of pending){await c.execute("UPDATE commerce_settlement_approval_instances SET status='SUPERSEDED' WHERE id=?",[a.id]);await c.execute("UPDATE commerce_settlement_items SET status='DRAFT',authorization_id=NULL,revision=revision+1 WHERE id=?",[a.item_id]);}
  await audit(c,p,'policy.disable',policy.id,{revoked_authorizations:unused.length});return {id:policy.id,status:'disabled',revoked_authorizations:unused.length};
 });}
 return {command,context,item,remaining,detail,listItems,authorizeItem,previewAdjustment,adjust,approvalTasks,approve,savePolicy,publishPolicy,pausePolicy,listPolicies,account,audit,calculate,postLedger};
}
module.exports={createWorkflow};
