'use strict';

const {createExternal,id,hash,json,check,fail,money,time,text}=require('./external.cjs');
const {buildExport}=require('./exports.cjs');
const MODES=['pay_center','wechat_mini','offline'],BIZ=['commerce','jiazheng','booking'];
const arr=(v,allowed,label)=>{const values=v==null?allowed:[...new Set(Array.isArray(v)?v:[v])];check(values.length>0&&values.every(x=>allowed.includes(x)),label+'无效',422);return values.sort();};
function boundary(v){check(typeof v==='string'&&v.length<=40,'账期日期无效',422);return time(/^\d{4}-\d{2}-\d{2}$/.test(v)?v+'T00:00:00+08:00':v);}
function before(a,b){return String(a||'').slice(0,23)<String(b).slice(0,23);}
function inside(at,start,end){return !!at&&!before(at,start)&&before(at,end);}
function contextContract(snapshot,merchantId){const snap=json(snapshot)||{},profiles=snap.profiles;if(profiles){const one=profiles[merchantId];if(one)return one.contract_ref||one.calculation?.contract_ref||null;const refs=[...new Set(Object.values(profiles).map(p=>p.contract_ref||p.calculation?.contract_ref||null))];return refs.length===1?refs[0]:null;}const p=snap.settlement_profile;return p?.contract_ref||p?.calculation?.contract_ref||null;}

function createStatements(options){
  const {config={},now=()=>Date.now()}=options,external=createExternal(options);
  const {tx,rows,auth,actor,clock,pool}=external._internals;
  async function allowed(p,permission,scope,soft=false){
    const scopes=[];
    for(const biz of scope.biz_types)for(const mode of scope.payment_modes){
      if(mode==='wechat_mini'&&biz!=='jiazheng'||mode==='offline'&&biz!=='booking')continue;
      try{await auth(p,permission,{party_id:scope.party_id,biz_type:biz,payment_mode:mode});scopes.push({biz_type:biz,payment_mode:mode});}
      catch(e){if(!soft||![401,403].includes(e.status))throw e;}
    }
    check(scopes.length>0,'无权访问该账单范围',403);return scopes;
  }
  function scopeOf(input){return {party_id:text(input.party_id,'主体',64),biz_types:arr(input.biz_types||input.biz_type,BIZ,'业务范围'),payment_modes:arr(input.payment_modes||input.payment_mode,MODES,'支付范围'),contract_ref:text(input.contract_ref,'合同筛选',191,true)};}
  function decode(row){if(!row)return row;return {...row,scope_json:json(row.scope_json),summary:json(row.summary),snapshot:row.snapshot?json(row.snapshot):undefined};}
  async function get(c,key,p,permission='settlement.statement.read'){
    const [row]=await rows(c,'SELECT * FROM commerce_payee_statements WHERE id=?',[key]);check(row,'账单不存在',404);
    const s=decode(row);await allowed(p,permission,s.scope_json);return s;
  }
  async function existingTable(c,name){return (await rows(c,'SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',[name])).length>0;}
  async function defaultInternalSource(c,scope,asOf){
    if(!scope.payment_modes.includes('pay_center')||!await existingTable(c,'commerce_settlement_items'))return {lines:[],financial_events:[],coverage_status:'PARTIAL'};
    const items=await rows(c,`SELECT i.*,bc.biz_type,bc.biz_order_no,bc.payment_mode,bc.execution_scope,bc.currency,bc.snapshot context_snapshot
      FROM commerce_settlement_items i JOIN commerce_settlement_business_contexts bc ON bc.id=i.context_id
      WHERE i.beneficiary_party_id=? AND bc.payment_mode='pay_center' AND i.created_at<=? ORDER BY i.id`,[scope.party_id,asOf]);
    const filtered=items.filter(i=>scope.biz_types.includes(i.biz_type)&&(!scope.contract_ref||contextContract(i.context_snapshot,i.merchant_id)===scope.contract_ref)),lines=[],financial=[];
    for(const i of filtered){
      const amount=String(i.original_payable_minor??i.payable_minor),created=time(i.created_at);
      lines.push({line_key:'internal-item:'+i.id,record_type:'INTERNAL_OBLIGATION',biz_type:i.biz_type,payment_mode:i.payment_mode,execution_scope:i.execution_scope,order_ref:i.biz_order_no,context_id:i.context_id,item_id:String(i.id),event_kind:i.line_kind,amount_minor:amount,currency:i.currency,verification_status:'BUSINESS_CONFIRMED',occurred_at:created,received_at:created,obligation_direction:'PLATFORM_PAYABLE',note:i.hold_reason||''});
      financial.push({key:'item:'+i.id,kind:'ACCRUAL',amount_minor:amount,currency:i.currency,posted_at:created});
    }
    if(filtered.length&&await existingTable(c,'commerce_execution_events')){
      const ids=new Set(filtered.map(i=>String(i.id))),executed=await rows(c,`SELECT e.*,COALESCE(l.item_id,original.item_id) item_id,l.context_id,l.effect_kind FROM commerce_execution_events e JOIN commerce_execution_lines l ON l.id=e.line_id LEFT JOIN commerce_execution_lines original ON original.id=l.original_line_id WHERE e.created_at<=? AND COALESCE(l.item_id,original.item_id) IS NOT NULL ORDER BY e.created_at,e.event_key`,[asOf]);
      for(const e of executed){
        if(!ids.has(String(e.item_id)))continue;
        const i=filtered.find(v=>String(v.id)===String(e.item_id)),stamp=time(e.created_at);
        if(['TRANSFER_SUCCEEDED','MERCHANT_RELEASE_SUCCEEDED','PAYOUT_SUCCEEDED','PLATFORM_TRANSFER_SUCCEEDED'].includes(e.kind)){
          financial.push({key:e.event_key,kind:'DISCHARGE',amount_minor:String(e.amount_minor),currency:i.currency,posted_at:stamp});
          lines.push({line_key:'execution:'+e.event_key,record_type:'INTERNAL_DISCHARGE',biz_type:i.biz_type,payment_mode:'pay_center',execution_scope:i.execution_scope,order_ref:i.biz_order_no,context_id:i.context_id,event_kind:e.kind,amount_minor:String(e.amount_minor),currency:i.currency,verification_status:'PROVIDER_CONFIRMED',occurred_at:stamp,received_at:stamp,obligation_direction:'PLATFORM_PAYABLE',note:e.kind==='MERCHANT_RELEASE_SUCCEEDED'?'原款释放，不代表新增转账或银行卡到账':'机构资金结果，银行到账需另有证据'});
        }
        if(['RETURN_SUCCEEDED','RETURNED','REFUND_SUCCEEDED'].includes(e.kind))lines.push({line_key:'execution:'+e.event_key,record_type:'INTERNAL_REVERSAL',biz_type:i.biz_type,payment_mode:'pay_center',execution_scope:i.execution_scope,order_ref:i.biz_order_no,context_id:i.context_id,event_kind:e.kind,amount_minor:String(e.amount_minor),currency:i.currency,verification_status:'PROVIDER_CONFIRMED',occurred_at:stamp,received_at:stamp,obligation_direction:e.kind==='RETURNED'?'SEPARATE_REPAYMENT_REVIEW':'RECOVERY_OR_REFUND',note:'独立逆向事实保留原成功历史；追偿、退票重付或权益冲回须关联独立义务，不倒改原应付'});
      }
    }
    const explained=new Set(),explainedCancelled=new Map();
    if(filtered.length&&await existingTable(c,'commerce_settlement_adjustments')){
      const adjustments=await rows(c,"SELECT * FROM commerce_settlement_adjustments WHERE status='APPLIED' AND updated_at<=? ORDER BY updated_at,id",[asOf]);
      for(const a of adjustments){const item=filtered.find(i=>String(i.id)===String(a.item_id));if(!item)continue;
        const after=json(a.after_snapshot),beforeSnapshot=json(a.before_snapshot),delta=BigInt(after.delta_minor??(BigInt(after.payable_minor??item.original_payable_minor)-BigInt(beforeSnapshot.payable_minor??item.original_payable_minor)).toString());
        // Positive amendments create a separate supplement item in the shared
        // core and are already counted by that item's original obligation.
        if(delta<0n){const stamp=time(a.updated_at);financial.push({key:'adjustment:'+a.id,kind:'REDUCTION',amount_minor:(-delta).toString(),currency:item.currency,posted_at:stamp});lines.push({line_key:'adjustment:'+a.id,record_type:'INTERNAL_ADJUSTMENT',biz_type:item.biz_type,payment_mode:'pay_center',execution_scope:item.execution_scope,order_ref:item.biz_order_no,context_id:item.context_id,event_kind:'REDUCTION',amount_minor:(-delta).toString(),currency:item.currency,verification_status:'BUSINESS_CONFIRMED',occurred_at:stamp,received_at:stamp,obligation_direction:'PLATFORM_PAYABLE',note:a.reason});}
        explained.add(String(item.id));if(delta<0n)explainedCancelled.set(String(item.id),(explainedCancelled.get(String(item.id))||0n)-delta);
      }
    }
    if(filtered.length&&await existingTable(c,'commerce_ledger_events')){
      const itemMap=new Map(filtered.map(i=>[String(i.id),i])),contextMap=new Map(filtered.map(i=>[i.context_id,i]));
      const reversals=await rows(c,"SELECT * FROM commerce_ledger_events WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source_type'))='shared_reversal' AND posted_at<=? ORDER BY posted_at,id",[asOf]);
      const hasRecoveryEvents=await existingTable(c,'commerce_shared_recovery_events');
      for(const reversal of reversals){const body=json(reversal.payload),stamp=time(reversal.posted_at),context=contextMap.get(reversal.context_id);if(!context)continue;
        for(const cancelled of body.item_cancellations||[]){const item=itemMap.get(String(cancelled.item_id));if(!item)continue;const amount=money(cancelled.amount_minor);if(BigInt(amount)<=0n)continue;
          explainedCancelled.set(String(item.id),(explainedCancelled.get(String(item.id))||0n)+BigInt(amount));
          financial.push({key:reversal.event_key+':item:'+item.id,kind:'REDUCTION',amount_minor:amount,currency:item.currency,posted_at:stamp});
          lines.push({line_key:reversal.event_key+':item:'+item.id,record_type:'INTERNAL_ADJUSTMENT',biz_type:item.biz_type,payment_mode:'pay_center',execution_scope:item.execution_scope,order_ref:item.biz_order_no,context_id:item.context_id,item_id:String(item.id),event_kind:'REVERSAL_CANCELLATION',amount_minor:amount,currency:item.currency,verification_status:'BUSINESS_CONFIRMED',occurred_at:stamp,received_at:stamp,obligation_direction:'PLATFORM_PAYABLE',note:'核销撤销冲减尚未清偿的原应付；原付款成功历史保持不变'});
        }
        for(const recovery of body.recovery_cases||[]){if(recovery.party_id!==scope.party_id)continue;const principal=BigInt(money(recovery.principal_minor)),initial=BigInt(money(recovery.initial_recovered_minor||'0'));check(principal>=initial,'追偿初始快照金额不守恒',409,'statement_conservation_failed');
          const base={biz_type:context.biz_type,payment_mode:'pay_center',execution_scope:context.execution_scope,order_ref:context.biz_order_no,context_id:context.context_id,recovery_id:recovery.id,recovery_kind:recovery.recovery_kind,currency:context.currency,obligation_direction:'RECOVERY_PAYABLE',verification_status:'BUSINESS_CONFIRMED'};
          lines.push({...base,line_key:'recovery:'+recovery.id,record_type:'RECOVERY_OBLIGATION',event_kind:'RECOVERY_ACCRUAL',amount_minor:(principal-initial).toString(),principal_minor:principal.toString(),initial_recovered_minor:initial.toString(),posted_at:stamp,occurred_at:stamp,received_at:stamp,note:'已付部分形成独立追偿，初始扣除此前已证实回收；不视为平台实收'});
          if(hasRecoveryEvents)for(const recovered of await rows(c,'SELECT * FROM commerce_shared_recovery_events WHERE recovery_id=? AND created_at<=? ORDER BY created_at,event_key',[recovery.id,asOf])){const recoveredAt=time(recovered.created_at);lines.push({...base,line_key:'recovery-event:'+recovered.event_key,record_type:'RECOVERY_RECEIPT',event_kind:'RECOVERY_RECEIPT',amount_minor:String(recovered.amount_minor),verification_status:'PROVIDER_CONFIRMED',posted_at:recoveredAt,occurred_at:recoveredAt,received_at:recoveredAt,note:'实际回收事实：'+recovered.kind});}
        }
      }
    }
    if(await existingTable(c,'commerce_compensation_recoveries')&&await existingTable(c,'commerce_ledger_events')){
      const recoveries=await rows(c,`SELECT r.*,bc.biz_type,bc.biz_order_no,bc.payment_mode,bc.execution_scope,bc.snapshot context_snapshot FROM commerce_compensation_recoveries r JOIN commerce_settlement_business_contexts bc ON bc.id=r.context_id
        WHERE (r.debtor_party_id=? OR r.creditor_party_id=?) AND bc.payment_mode='pay_center' AND r.created_at<=? ORDER BY r.id`,[scope.party_id,scope.party_id,asOf]);
      for(const recovery of recoveries){if(!scope.biz_types.includes(recovery.biz_type)||(scope.contract_ref&&contextContract(recovery.context_snapshot)!==scope.contract_ref))continue;
        const base={biz_type:recovery.biz_type,payment_mode:'pay_center',execution_scope:recovery.execution_scope,order_ref:recovery.biz_order_no,context_id:recovery.context_id,recovery_id:recovery.id,recovery_kind:'COMPENSATION',currency:recovery.currency,debtor_party_id:recovery.debtor_party_id,creditor_party_id:recovery.creditor_party_id,obligation_direction:scope.party_id===recovery.creditor_party_id?'RECOVERY_RECEIVABLE':'RECOVERY_PAYABLE',verification_status:'BUSINESS_CONFIRMED'};
        const events=await rows(c,"SELECT * FROM commerce_ledger_events WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source_type'))='compensation_recovery' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source_id'))=? AND posted_at<=? ORDER BY posted_at,id",[recovery.id,asOf]);
        for(const event of events){const body=json(event.payload),stamp=time(event.posted_at);let delta=0n;for(const entry of body.lines||[])if(entry.account==='receivable:'+recovery.debtor_party_id)delta+=(entry.side==='debit'?1n:-1n)*BigInt(entry.amount_minor);if(delta===0n)continue;
          lines.push({...base,line_key:'compensation-recovery:'+event.id,record_type:delta>0n?'RECOVERY_OBLIGATION':'RECOVERY_REDUCTION',event_kind:delta>0n?'RECOVERY_ACCRUAL':'RECOVERY_REDUCTION',amount_minor:(delta>0n?delta:-delta).toString(),posted_at:stamp,occurred_at:stamp,received_at:stamp,note:delta>0n?'平台赔付已实际支付，形成独立追偿义务':'赔付退回使追偿基数减少；不代表商户已经还款'});
        }
        if(!events.length){const stamp=time(recovery.created_at);lines.push({...base,line_key:'compensation-recovery-pending:'+recovery.id,record_type:'PENDING_RECOVERY',event_kind:'AWAITING_COMPENSATION_PAYMENT',amount_minor:null,potential_minor:String(recovery.amount_minor),verification_status:'PENDING_EVIDENCE',received_at:stamp,note:'待平台赔付实际支付后才确认追偿，目前不计入应收或应还余额'});}
      }
    }
    // A mutable payable balance is not sufficient evidence of an adjustment.
    const unexplained=filtered.filter(i=>(!i.updated_at||!before(asOf,time(i.updated_at)))&&((BigInt(i.payable_minor)!==BigInt(i.original_payable_minor??i.payable_minor)&&!explained.has(String(i.id)))||BigInt(i.offset_minor||0)>0n||BigInt(i.cancelled_minor||0)>(explainedCancelled.get(String(i.id))||0n)));
    for(const i of unexplained)lines.push({line_key:'internal-adjustment-pending:'+i.id,record_type:'PENDING_LEDGER_RECONCILIATION',biz_type:i.biz_type,payment_mode:'pay_center',execution_scope:i.execution_scope,order_ref:i.biz_order_no,context_id:i.context_id,amount_minor:null,currency:i.currency,verification_status:'PENDING_EVIDENCE',note:'历史调整或抵扣需由不可变账务事件补齐，未依据当前余额倒算往期发生額'});
    return {lines,financial_events:financial,coverage_status:'PARTIAL'};
  }
  async function externalSource(c,scope,asOf){
    if(!scope.biz_types.includes('jiazheng')||!scope.payment_modes.includes('wechat_mini'))return {lines:[],obligation_events:[],coverage_status:'NOT_RECEIVED'};
    let contexts=await rows(c,"SELECT * FROM commerce_settlement_business_contexts WHERE party_id=? AND biz_type='jiazheng' AND source_order_system='gr_orders' AND payment_mode='wechat_mini' AND execution_scope='EXTERNAL_RECORD_ONLY' AND created_at<=? ORDER BY id",[scope.party_id,asOf]);
    if(scope.contract_ref){const associated=new Set((await rows(c,'SELECT DISTINCT context_id FROM commerce_external_obligations WHERE agreement_ref=? AND (creditor_party_id=? OR debtor_party_id=?) AND created_at<=?',[scope.contract_ref,scope.party_id,scope.party_id,asOf])).map(r=>r.context_id));contexts=contexts.filter(ctx=>associated.has(ctx.id));}
    const contextMap=new Map(contexts.map(x=>[x.id,x])),lines=[];
    for(const ctx of contexts){const snap=json(ctx.snapshot);lines.push({line_key:'order:'+ctx.id,record_type:'ORDER_COVERAGE',biz_type:'jiazheng',payment_mode:'wechat_mini',execution_scope:'EXTERNAL_RECORD_ONLY',order_ref:ctx.biz_order_no,context_id:ctx.id,vendor_oid:snap.vendor_oid||null,amount_minor:null,currency:ctx.currency,verification_status:'PENDING_EVIDENCE',occurred_at:snap.source_created_at||null,received_at:time(ctx.created_at),note:'订单状态 '+(snap.reported_status||'未知')+'；订单状态不是收款或结算事实'});}
    const events=await rows(c,'SELECT * FROM commerce_external_trade_events WHERE party_id=? AND received_at<=? ORDER BY received_at,id',[scope.party_id,asOf]);
    for(const event of events){
      const evidence=await rows(c,`SELECT e.*,r.decision,r.fact_version,r.created_at reviewed_at FROM commerce_external_evidence e LEFT JOIN commerce_external_reviews r ON r.evidence_id=e.id AND r.created_at<=? WHERE e.event_id=? AND e.created_at<=? ORDER BY e.created_at,e.id`,[asOf,event.id,asOf]);
      if(!evidence.length)continue;
      const verified=evidence.filter(x=>x.decision==='VERIFIED').sort((a,b)=>Number(b.fact_version)-Number(a.fact_version))[0],chosen=verified||evidence[0],n=json(chosen.normalized),ctx=contextMap.get(n.context_id),conflict=evidence.some(x=>{if(x.decision==='CONFLICT')return true;const report=json(x.normalized);return !!verified&&['amount_minor','currency','original_event_id','context_id'].some(k=>report[k]!=null&&String(report[k])!==String(n[k]??''));});
      if(scope.contract_ref&&n.context_id&&!ctx)continue;
      const line={line_key:'external:'+event.id,record_type:ctx?'EXTERNAL_TRADE':'UNMATCHED_EXTERNAL_TRADE',biz_type:'jiazheng',payment_mode:'wechat_mini',execution_scope:'EXTERNAL_RECORD_ONLY',context_id:n.context_id,order_ref:ctx?.biz_order_no||null,event_id:event.id,event_kind:n.event_kind,transaction_id:n.transaction_id,original_event_id:n.original_event_id,amount_minor:n.amount_minor,currency:n.currency,verification_status:verified?'VERIFIED':conflict?'CONFLICT':'PENDING_EVIDENCE',has_conflict:conflict,occurred_at:n.occurred_at,received_at:time(event.received_at),verified_at:verified?time(verified.reviewed_at):null,source_version:verified?Number(verified.fact_version):1,evidence_source:chosen.source_type,evidence_id:chosen.id,note:!ctx?'交易待匹配，不计入本项目交易总额':verified?'已核验外部事实；不产生本站资金执行':'商户或历史报送，待核验'};
      // Unmatched batch receipts become visible only through explicit bounded
      // allocations. The original full receipt is descriptive and never summed.
      const allocations=!ctx&&verified?await rows(c,'SELECT * FROM commerce_external_trade_allocations WHERE event_id=? AND created_at<=? ORDER BY id',[event.id,asOf]):[];
      let allocated=0n;
      for(const a of allocations){const target=contextMap.get(a.context_id);if(!target)continue;allocated+=BigInt(a.amount_minor);lines.push({...line,line_key:'external-allocation:'+a.id,record_type:'EXTERNAL_TRADE',context_id:a.context_id,order_ref:target.biz_order_no,amount_minor:String(a.amount_minor),allocation_id:a.id,received_at:time(a.created_at),note:'已核验外部批次按凭证分配；不产生本站资金执行'});}
      if(scope.contract_ref&&!ctx&&allocated===0n)continue;
      if(allocated>0n){line.unallocated_minor=(BigInt(n.amount_minor)-allocated).toString();line.record_type=scope.contract_ref||line.unallocated_minor==='0'?'EXTERNAL_ALLOCATION_SOURCE':'UNMATCHED_EXTERNAL_TRADE';line.note='原始外部批次总额，仅分配明细计入交易汇总';}
      lines.push(line);
    }
    const obligationEvents=await rows(c,`SELECT e.*,o.context_id,o.creditor_party_id,o.debtor_party_id,o.currency,o.component,o.agreement_ref FROM commerce_external_obligation_events e JOIN commerce_external_obligations o ON o.id=e.obligation_id WHERE (o.creditor_party_id=? OR o.debtor_party_id=?) AND e.created_at<=? ORDER BY e.created_at,e.id`,[scope.party_id,scope.party_id,asOf]);
    for(const e of obligationEvents){if(scope.contract_ref&&e.agreement_ref!==scope.contract_ref)continue;const snap=json(e.snapshot),posted=e.status==='POSTED'&&e.posted_at&&!before(asOf,time(e.posted_at));lines.push({line_key:'external-obligation:'+e.id,record_type:'EXTERNAL_OBLIGATION',biz_type:'jiazheng',payment_mode:'wechat_mini',execution_scope:'EXTERNAL_RECORD_ONLY',context_id:e.context_id,order_ref:contextMap.get(e.context_id)?.biz_order_no||null,obligation_id:e.obligation_id,event_kind:e.event_kind,amount_minor:String(e.amount_minor),currency:e.currency,verification_status:posted?'CONTRACT_CONFIRMED':'PENDING_REVIEW',occurred_at:posted?time(e.posted_at):null,received_at:time(e.created_at),posted_at:posted?time(e.posted_at):null,debtor_party_id:e.debtor_party_id,creditor_party_id:e.creditor_party_id,obligation_direction:e.creditor_party_id===scope.party_id?'EXTERNAL_COMMISSION_RECEIVABLE':'EXTERNAL_COMMISSION_PAYABLE',effect:snap.effect||null,note:e.reason,agreement_ref:e.agreement_ref});}
    return {lines,coverage_status:contexts.length||events.length?'PARTIAL':'NOT_RECEIVED'};
  }
  function summarize(allLines,financial,currency,start,end){
    const summary={order_count:0,unknown_amount_count:0,unmatched_count:0,conflict_count:0,reported_payment_minor:'0',verified_payment_minor:'0',verified_refund_minor:'0',external_net_minor:'0',opening_minor:'0',accrued_minor:'0',reduced_minor:'0',discharged_minor:'0',closing_minor:'0',external_commission_opening_minor:'0',external_commission_accrued_minor:'0',external_commission_reduced_minor:'0',external_commission_received_minor:'0',external_commission_outstanding_minor:'0',external_return_due_minor:'0'};
    const add=(key,value)=>{summary[key]=(BigInt(summary[key])+BigInt(value||0)).toString();};
    for(const direction of ['receivable','payable'])for(const metric of ['opening','accrued','reduced','settled','outstanding','return_due'])summary['external_'+direction+'_'+metric+'_minor']='0';
    for(const direction of ['receivable','payable'])for(const metric of ['opening','accrued','reduced','recovered','outstanding'])summary['recovery_'+direction+'_'+metric+'_minor']='0';
    summary.bank_returned_minor='0';summary.split_returned_minor='0';
    const orders=new Set(),unknownOrders=new Set(),knownPaymentOrders=new Set(),lines=[];
    for(const line of allLines){
      const at=line.posted_at||line.occurred_at||line.received_at,active=inside(at,start,end),unresolved=['PENDING_EVIDENCE','CONFLICT','PENDING_REVIEW'].includes(line.verification_status);
      if(!active&&!unresolved&&!['ORDER_COVERAGE','BOOKING_ORDER','INTERNAL_OBLIGATION','EXTERNAL_OBLIGATION','RECOVERY_OBLIGATION'].includes(line.record_type))continue;
      if(['ORDER_COVERAGE','BOOKING_ORDER'].includes(line.record_type)&&line.occurred_at&&!before(line.occurred_at,end))continue;
      lines.push(line);if(line.context_id)orders.add(line.context_id);
      if(line.record_type==='ORDER_COVERAGE')unknownOrders.add(line.context_id);
      if(line.record_type==='EXTERNAL_TRADE'&&line.event_kind==='PAYMENT'&&line.amount_minor!=null&&line.currency)knownPaymentOrders.add(line.context_id);
      if(line.has_conflict||line.verification_status==='CONFLICT')summary.conflict_count++;
      if(line.record_type==='UNMATCHED_EXTERNAL_TRADE'){summary.unmatched_count++;continue;}
      if(['EXTERNAL_TRADE','INTERNAL_OBLIGATION','PENDING_LEDGER_RECONCILIATION'].includes(line.record_type)&&line.event_kind!=='ORDER_STATUS'&&line.event_kind!=='FULFILLMENT'&&(line.amount_minor==null||!line.currency))unknownOrders.add(line.context_id||line.line_key);
      if(!active||line.currency!==currency||line.amount_minor==null)continue;
      if(line.record_type==='INTERNAL_REVERSAL'&&line.event_kind==='RETURNED')add('bank_returned_minor',line.amount_minor);
      if(line.record_type==='INTERNAL_REVERSAL'&&line.event_kind==='RETURN_SUCCEEDED')add('split_returned_minor',line.amount_minor);
      if(line.record_type==='EXTERNAL_TRADE'){
        if(line.event_kind==='PAYMENT')add(line.verification_status==='VERIFIED'?'verified_payment_minor':'reported_payment_minor',line.amount_minor);
        if(line.event_kind==='REFUND'&&line.verification_status==='VERIFIED')add('verified_refund_minor',line.amount_minor);
      }
    }
    for(const event of financial){
      if(event.currency!==currency||!before(event.posted_at,end))continue;
      const delta=(event.kind==='ACCRUAL'||event.kind==='RESTORE'?1n:-1n)*BigInt(event.amount_minor);
      if(before(event.posted_at,start))add('opening_minor',delta);else add(event.kind==='ACCRUAL'||event.kind==='RESTORE'?'accrued_minor':event.kind==='DISCHARGE'?'discharged_minor':'reduced_minor',event.amount_minor);
    }
    for(const l of allLines){
      if(['RECOVERY_OBLIGATION','RECOVERY_RECEIPT','RECOVERY_REDUCTION'].includes(l.record_type)&&l.currency===currency&&before(l.posted_at,end)){
        const isAccrual=l.record_type==='RECOVERY_OBLIGATION',amount=BigInt(l.amount_minor),prefix=l.obligation_direction==='RECOVERY_RECEIVABLE'?'recovery_receivable_':'recovery_payable_';
        if(before(l.posted_at,start))add(prefix+'opening_minor',isAccrual?amount:-amount);else add(prefix+(isAccrual?'accrued':l.record_type==='RECOVERY_RECEIPT'?'recovered':'reduced')+'_minor',amount);
      }
      if(l.record_type!=='EXTERNAL_OBLIGATION'||l.verification_status!=='CONTRACT_CONFIRMED'||l.currency!==currency||!before(l.posted_at,end))continue;
      const amount=BigInt(l.amount_minor),effect=l.effect||{};
      // Each posted event freezes its delta separately; current obligation totals
      // must never be used to reconstruct the balance of an earlier month.
      const delta=l.event_kind==='ACCRUAL'?amount:l.event_kind==='SETTLEMENT'?-amount:-BigInt(effect.reduction_delta_minor??l.amount_minor);
      const direction=l.obligation_direction==='EXTERNAL_COMMISSION_RECEIVABLE'?'receivable':'payable',prefix='external_'+direction+'_';
      if(before(l.posted_at,start))add(prefix+'opening_minor',delta);
      else if(l.event_kind==='ACCRUAL')add(prefix+'accrued_minor',amount);
      else if(l.event_kind==='SETTLEMENT')add(prefix+'settled_minor',amount);
      else add(prefix+'reduced_minor',effect.reduction_delta_minor??amount);
      add(prefix+'return_due_minor',effect.return_delta_minor||0);
      if(before(l.posted_at,start))add('external_commission_opening_minor',delta);
      else if(l.event_kind==='ACCRUAL')add('external_commission_accrued_minor',amount);
      else if(l.event_kind==='SETTLEMENT')add('external_commission_received_minor',amount);
      else {add('external_commission_reduced_minor',effect.reduction_delta_minor??amount);add('external_return_due_minor',effect.return_delta_minor||0);}
    }
    summary.order_count=orders.size;
    summary.unknown_amount_count=[...unknownOrders].filter(k=>!knownPaymentOrders.has(k)).length;
    summary.external_net_minor=(BigInt(summary.verified_payment_minor)-BigInt(summary.verified_refund_minor)).toString();
    summary.closing_minor=(BigInt(summary.opening_minor)+BigInt(summary.accrued_minor)-BigInt(summary.reduced_minor)-BigInt(summary.discharged_minor)).toString();
    summary.external_commission_outstanding_minor=(BigInt(summary.external_commission_opening_minor)+BigInt(summary.external_commission_accrued_minor)-BigInt(summary.external_commission_reduced_minor)-BigInt(summary.external_commission_received_minor)).toString();
    for(const direction of ['receivable','payable']){const prefix='external_'+direction+'_';summary[prefix+'outstanding_minor']=(BigInt(summary[prefix+'opening_minor'])+BigInt(summary[prefix+'accrued_minor'])-BigInt(summary[prefix+'reduced_minor'])-BigInt(summary[prefix+'settled_minor'])).toString();}
    for(const direction of ['receivable','payable']){const prefix='recovery_'+direction+'_';summary[prefix+'outstanding_minor']=(BigInt(summary[prefix+'opening_minor'])+BigInt(summary[prefix+'accrued_minor'])-BigInt(summary[prefix+'reduced_minor'])-BigInt(summary[prefix+'recovered_minor'])).toString();}
    check(BigInt(summary.closing_minor)>=0n&&BigInt(summary.external_commission_outstanding_minor)>=0n&&BigInt(summary.recovery_payable_outstanding_minor)>=0n&&BigInt(summary.recovery_receivable_outstanding_minor)>=0n,'账单余额出现负数，请核对来源事件',409,'statement_conservation_failed');
    return {summary,lines};
  }
  async function generateStatement(p,input){
    const scope=scopeOf(input);await allowed(p,'settlement.statement.generate',scope);
    const currency=text(input.currency||'CNY','币种',3);check(/^[A-Z]{3}$/.test(currency),'币种无效',422);
    const start=boundary(input.period_start),end=boundary(input.period_end),asOf=input.as_of?boundary(input.as_of):clock();
    check(before(start,end)&&!before(asOf,start)&&!before(clock(),asOf),'账期或统计截止无效',422);
    return tx(async c=>{
      const scopeHash=hash(scope),lockKey=hash([scope.party_id,currency,start,end,scopeHash]);
      await c.execute('INSERT INTO commerce_payee_statement_locks(scope_key,created_at) VALUES(?,?) ON DUPLICATE KEY UPDATE scope_key=scope_key',[lockKey,clock()]);
      await rows(c,'SELECT scope_key FROM commerce_payee_statement_locks WHERE scope_key=? FOR UPDATE',[lockKey]);
      const internal=await (config.statementSource||defaultInternalSource)(c,scope,asOf),outside=await externalSource(c,scope,asOf);
      check(Array.isArray(internal.lines)&&Array.isArray(internal.financial_events||[]),'站内账单来源协议无效',500);
      const {summary,lines}=summarize([...internal.lines,...outside.lines,...await require('./booking-reports.cjs').source(c,scope,asOf)],internal.financial_events||[],currency,start,end);
      lines.sort((a,b)=>a.line_key.localeCompare(b.line_key));
      let coverage=scope.payment_modes.includes('wechat_mini')?outside.coverage_status:internal.coverage_status||'PARTIAL';
      if(scope.payment_modes.includes('wechat_mini')){
        const reports=await rows(c,"SELECT * FROM commerce_external_coverage_reports WHERE party_id=? AND currency=? AND period_start<=? AND period_end>=? AND status='VERIFIED' AND reviewed_at<=?",[scope.party_id,currency,start,end,asOf]);
        const types=new Set(reports.flatMap(r=>json(r.fact_types)));
        if(['PAYMENT','REFUND','FULFILLMENT','CHANNEL_SETTLEMENT','COMMISSION_RECEIPT'].every(t=>types.has(t)))coverage=scope.payment_modes.includes('pay_center')&&internal.coverage_status!=='COMPLETE'?'PARTIAL':'COMPLETE';
      }
      const recon=summary.conflict_count?'DIFFERENCE':coverage==='COMPLETE'&&!lines.some(l=>['PENDING_EVIDENCE','PENDING_REVIEW'].includes(l.verification_status))?'MATCHED':'PENDING';
      const snapshot={scope,summary,lines,period_start:start,period_end:end,currency,coverage_status:coverage};
      const sourceHash=hash(snapshot),[prior]=await rows(c,'SELECT * FROM commerce_payee_statements WHERE party_id=? AND currency=? AND period_start=? AND period_end=? AND scope_hash=? AND source_hash=?',[scope.party_id,currency,start,end,scopeHash,sourceHash]);
      if(prior)return {...decode(prior),reused:true};
      const [latest]=await rows(c,'SELECT COALESCE(MAX(version),0) version FROM commerce_payee_statements WHERE party_id=? AND currency=? AND period_start=? AND period_end=? AND scope_hash=?',[scope.party_id,currency,start,end,scopeHash]);
      const version=Number(latest.version)+1,statementId=id(),statementNo='ST-'+statementId.replace(/-/g,'');
      await c.execute(`INSERT INTO commerce_payee_statements(id,statement_no,party_id,currency,period_start,period_end,as_of,scope_json,scope_hash,version,source_hash,publication_status,recon_status,coverage_status,summary,snapshot,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'ISSUED',?,?,?,?,?,?)`,[statementId,statementNo,scope.party_id,currency,start,end,asOf,JSON.stringify(scope),scopeHash,version,sourceHash,recon,coverage,JSON.stringify(summary),JSON.stringify(snapshot),actor(p),clock()]);
      return get(c,statementId,p);
    });
  }
  async function getStatement(p,input){return get(pool,input.statement_id,p);}
  async function listStatements(p,input){
    const scope=scopeOf(input);await allowed(p,'settlement.statement.read',scope,true);
    const records=await rows(pool,'SELECT * FROM commerce_payee_statements WHERE party_id=? ORDER BY period_end DESC,version DESC LIMIT 200',[scope.party_id]),out=[];
    for(const r of records){const s=decode(r);if(!s.scope_json.biz_types.every(x=>scope.biz_types.includes(x))||!s.scope_json.payment_modes.every(x=>scope.payment_modes.includes(x)))continue;
      try{await allowed(p,'settlement.statement.read',s.scope_json);out.push({...s,snapshot:undefined});}catch(e){if(![401,403].includes(e.status))throw e;}}
    return {rows:out};
  }
  async function confirmStatement(p,input){const s=await get(pool,input.statement_id,p,'settlement.statement.confirm');const note=text(input.note||'确认本版账单，不视为资金到账确认','确认意见',1000);await pool.execute('INSERT INTO commerce_payee_statement_confirmations(id,statement_id,actor_id,note,created_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',[id(),s.id,actor(p),note,clock()]);return {statement_id:s.id,version:s.version,confirmed:true};}
  async function raiseDispute(p,input){const s=await get(pool,input.statement_id,p,'settlement.statement.dispute');if(input.line_key)check(s.snapshot.lines.some(l=>l.line_key===input.line_key),'账单明细不存在',404);const disputeId=id();await pool.execute('INSERT INTO commerce_statement_disputes(id,statement_id,line_key,party_id,reason,evidence_ref,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',[disputeId,s.id,input.line_key||null,s.party_id,text(input.reason,'异议原因',1000),text(input.evidence_ref,'异议凭证',500),actor(p),clock()]);return {id:disputeId,statement_id:s.id,status:'OPEN'};}
  async function listDisputes(p,input){const s=await get(pool,input.statement_id,p);return {rows:await rows(pool,'SELECT * FROM commerce_statement_disputes WHERE statement_id=? ORDER BY created_at',[s.id])};}
  async function resolveDispute(p,input){return tx(async c=>{const [d]=await rows(c,'SELECT * FROM commerce_statement_disputes WHERE id=? FOR UPDATE',[input.dispute_id]);check(d,'异议不存在',404);await get(c,d.statement_id,p,'settlement.statement.review');check(d.created_by!==actor(p),'异议提出人不能复核自己的异议',403);if(d.status==='RESOLVED')return {...d,reused:true};await c.execute("UPDATE commerce_statement_disputes SET status='RESOLVED',resolution=?,resolution_evidence=?,resolved_by=?,resolved_at=? WHERE id=?",[text(input.resolution,'处理结论',1000),text(input.evidence_ref,'处理凭证',500),actor(p),clock(),d.id]);return {id:d.id,status:'RESOLVED',note:'金额修正须另行批准调整，不直接改已出账单'};});}
  async function requestExport(p,input){const s=await get(pool,input.statement_id,p,'settlement.statement.export'),format=String(input.format||'csv').toLowerCase();check(['csv','xlsx','pdf'].includes(format),'导出格式无效',422);const key=hash([s.id,s.version,s.as_of,format,actor(p)]),jobId=id();await pool.execute('INSERT INTO commerce_statement_export_jobs(id,statement_id,party_id,format,request_key,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',[jobId,s.id,s.party_id,format,key,actor(p),clock()]);await pool.execute("UPDATE commerce_statement_export_jobs SET status='QUEUED',attempts=0,file_blob=NULL,error_code=NULL WHERE request_key=? AND status='READY' AND expires_at<=?",[key,clock()]);const [job]=await rows(pool,'SELECT id,status,format,statement_id,error_code FROM commerce_statement_export_jobs WHERE request_key=?',[key]);return job;}
  async function getExport(p,input){const [job]=await rows(pool,'SELECT id,statement_id,party_id,format,status,filename,error_code,expires_at FROM commerce_statement_export_jobs WHERE id=?',[input.export_id]);check(job,'导出任务不存在',404);await get(pool,job.statement_id,p,'settlement.statement.export');return job;}
  async function runExports(p,input={}){
    actor(p);const limit=Math.min(20,Math.max(1,Number(input.limit)||5)),jobs=await rows(pool,`SELECT * FROM commerce_statement_export_jobs WHERE (status IN ('QUEUED','FAILED') AND attempts<3 OR status='RUNNING' AND lease_until<?) ${config.resolvePrincipal?'':'AND created_by=?'} ORDER BY created_at LIMIT ${limit}`,config.resolvePrincipal?[clock()]:[clock(),actor(p)]),result=[];
    for(const original of jobs){let token=id();
      const [claim]=await pool.execute("UPDATE commerce_statement_export_jobs SET status='RUNNING',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (status IN ('QUEUED','FAILED') AND attempts<3 OR status='RUNNING' AND lease_until<?)",[token,time(new Date(now()+120000)),original.id,clock()]);if(!claim.affectedRows)continue;
      try{const current=config.resolvePrincipal?await config.resolvePrincipal(original.created_by):p;check(current&&String(current.account.id)===original.created_by,'导出申请人权限已失效',403);const s=await get(pool,original.statement_id,current,'settlement.statement.export');const file=await buildExport(s,original.format,config);check(file.buffer.length<=64*1024*1024,'导出文件超出64MB',422);await pool.execute("UPDATE commerce_statement_export_jobs SET status='READY',file_blob=?,file_hash=?,filename=?,content_type=?,expires_at=?,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",[file.buffer,hash(file.buffer),file.filename,file.contentType,time(new Date(now()+86400000)),original.id,token]);result.push({id:original.id,status:'READY'});}
      catch(e){await pool.execute("UPDATE commerce_statement_export_jobs SET status='FAILED',error_code=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",[String(e.code||'export_failed').slice(0,100),original.id,token]);result.push({id:original.id,status:'FAILED',error:e.message});}
    }
    return {rows:result};
  }
  async function downloadExport(p,input){
    actor(p);const [job]=await rows(pool,'SELECT * FROM commerce_statement_export_jobs WHERE id=?',[input.export_id]);check(job,'导出任务不存在',404);
    let success=false;try{await get(pool,job.statement_id,p,'settlement.statement.export');check(job.status==='READY'&&job.file_blob,'导出文件尚未就绪',409);check(!before(time(job.expires_at),clock()),'导出文件已过期，请重新生成',410);success=true;return {buffer:job.file_blob,filename:job.filename,contentType:job.content_type};}
    finally{await pool.execute('INSERT INTO commerce_statement_access_audit(actor_id,party_id,statement_id,export_job_id,action,result,file_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',[actor(p),job.party_id,job.statement_id,job.id,'DOWNLOAD',success?'ALLOWED':'DENIED',job.file_hash,clock()]);}
  }
  async function retryExport(p,input){const job=await getExport(p,input);check(['FAILED','READY'].includes(job.status),'当前任务不能重建');await pool.execute("UPDATE commerce_statement_export_jobs SET status='QUEUED',attempts=0,error_code=NULL,file_blob=NULL WHERE id=?",[job.id]);return {id:job.id,status:'QUEUED'};}
  function monthly(nowMs){const beijing=new Date(nowMs+8*3600000),y=beijing.getUTCFullYear(),m=beijing.getUTCMonth();return {start:new Date(Date.UTC(y,m-1,1)-8*3600000),end:new Date(Date.UTC(y,m,1)-8*3600000),due:new Date(Date.UTC(y,m,1,8)-8*3600000),next:new Date(Date.UTC(y,m+1,1,8)-8*3600000)};}
  // 账单日（T+N 账期）出账窗口：账单日 08:00（北京）出上一账单日至今的账单。
  // 1–28 规避月尾长度差异；缺省与 1 日都按自然月，行为与历史完全一致。
  function cycleWindow(nowMs,billingDay){
    const day=Number(billingDay)||0;
    if(!(day>=2))return monthly(nowMs);
    const beijing=new Date(nowMs+8*3600000),y=beijing.getUTCFullYear(),m=beijing.getUTCMonth();
    const at=(mm,hour=0)=>new Date(Date.UTC(y,mm,day,hour)-8*3600000);
    if(nowMs>=at(m,8).getTime())return {start:at(m-1),end:at(m),due:at(m,8),next:at(m+1,8)};
    return {start:at(m-2),end:at(m-1),due:at(m-1,8),next:at(m,8)};
  }
  function windowOf(nextRunAt,billingDay){const fireAt=new Date(time(nextRunAt).replace(' ','T')+'Z').getTime();return billingDay?cycleWindow(fireAt,billingDay):monthly(fireAt);}
  // 账单日单一数据源是结算规则（booking 策略 conditions.billing_day）；出账策略只是随动镜像。
  async function bookingBillingDay(scope){
    if(!scope.biz_types.includes('booking'))return null;
    const placeholders=scope.payment_modes.map(()=>'?').join(',');
    const candidates=await rows(pool,"SELECT conditions FROM commerce_settlement_policies WHERE status='approved' AND biz_type='booking' AND payment_mode IN ("+placeholders+") AND (party_id=? OR party_id IS NULL) ORDER BY (party_id IS NULL),priority DESC,created_at DESC",[...scope.payment_modes,scope.party_id]);
    for(const row of candidates){const day=json(row.conditions)?.billing_day;if(day!=null)return day;}
    return null;
  }
  async function setStatementPolicy(p,input){
    const scope=scopeOf(input);await allowed(p,'settlement.statement.generate',scope);
    const currency=text(input.currency||'CNY','币种',3);
    const explicit=input.billing_day!==undefined,billingDay=explicit?(input.billing_day==null?null:(day=>{check(Number.isInteger(day)&&day>=1&&day<=28,'账单日须为每月 1–28 日的整数，留空则按自然月出账',422);return day;})(Number(input.billing_day))):await bookingBillingDay(scope);
    const [current]=(await rows(pool,'SELECT * FROM commerce_payee_statement_policies WHERE party_id=? AND currency=? AND scope_hash=?',[scope.party_id,currency,hash(scope)]));
    const cycleChanged=!current||Number(current.billing_day||0)!==Number(billingDay||0);
    const win=cycleWindow(now(),billingDay),next=now()>=win.due.getTime()?win.due:win.next;
    const updates=cycleChanged?"status='ACTIVE',billing_day=VALUES(billing_day),next_run_at=VALUES(next_run_at)":"status='ACTIVE',billing_day=VALUES(billing_day)";
    await pool.execute('INSERT INTO commerce_payee_statement_policies(id,party_id,currency,scope_json,scope_hash,billing_day,next_run_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE '+updates,[id(),scope.party_id,currency,JSON.stringify(scope),hash(scope),billingDay,time(next),actor(p),clock()]);
    return {party_id:scope.party_id,currency,billing_day:billingDay,next_run_at:time(next)};
  }
  async function listStatementPolicies(p){
    const all=await rows(pool,"SELECT * FROM commerce_payee_statement_policies WHERE status='ACTIVE' ORDER BY party_id,currency"),out=[];
    for(const row of all){const scope=json(row.scope_json);try{await allowed(p,'settlement.statement.read',scope,true);}catch(e){if(![401,403].includes(e.status))throw e;continue;}
      const win=windowOf(row.next_run_at,row.billing_day);
      out.push({party_id:row.party_id,currency:row.currency,biz_types:scope.biz_types,payment_modes:scope.payment_modes,billing_day:row.billing_day==null?null:Number(row.billing_day),next_run_at:time(row.next_run_at),current_period:{period_start:win.start.toISOString(),period_end:win.end.toISOString()}});
    }
    return {rows:out};
  }
  async function runScheduled(p,input={}){
    actor(p);const policies=await rows(pool,"SELECT * FROM commerce_payee_statement_policies WHERE status='ACTIVE' AND next_run_at<=? ORDER BY next_run_at LIMIT 100",[clock()]),result=[];
    for(const policy of policies){const scope=json(policy.scope_json);try{const win=windowOf(policy.next_run_at,policy.billing_day);const s=await generateStatement(p,{...scope,currency:policy.currency,period_start:win.start.toISOString(),period_end:win.end.toISOString()});await pool.execute('UPDATE commerce_payee_statement_policies SET next_run_at=? WHERE id=? AND next_run_at=?',[time(win.next),policy.id,policy.next_run_at]);result.push({policy_id:policy.id,statement_id:s.id});}catch(e){result.push({policy_id:policy.id,error:e.code||e.message});}}
    return {rows:result};
  }
  async function syncExternalOrders(p,input){return tx(async c=>{
    const out=await external.syncExternalOrders(p,input),scope=scopeOf({party_id:input.party_id,biz_types:['jiazheng'],payment_modes:['wechat_mini']}),month=monthly(now()),next=now()>=month.due.getTime()?month.due:month.next;
    // The approved vendor binding and sync authorization above establish the
    // scope. Monthly statements are automatic, not a merchant application.
    await c.execute("INSERT INTO commerce_payee_statement_policies(id,party_id,currency,scope_json,scope_hash,next_run_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id",[id(),scope.party_id,'CNY',JSON.stringify(scope),hash(scope),time(next),actor(p),clock()]);
    return {...out,statement_policy_registered:true};
  });}
  const api={...Object.fromEntries(Object.entries(external).filter(([k])=>k!=='_internals')),syncExternalOrders,generateStatement,getStatement,listStatements,listStatementPolicies,confirmStatement,raiseDispute,listDisputes,resolveDispute,requestExport,getExport,runExports,downloadExport,retryExport,setStatementPolicy,runScheduled};
  const writeNames=['syncExternalOrders','ingestEvidence','reviewEvidence','allocateExternalTrade','importExternalEvidence','reviewImport','submitCoverage','reviewCoverage','recordExternalAccrual','reviewExternalAccrual','generateStatement','confirmStatement','raiseDispute','resolveDispute','requestExport','retryExport','setStatementPolicy'];
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  async function guardWrite(p,name,input){
    if(['generateStatement','setStatementPolicy'].includes(name))return allowed(p,'settlement.statement.generate',scopeOf(input));
    const statementPermissions={confirmStatement:'confirm',raiseDispute:'dispute',requestExport:'export'};
    if(statementPermissions[name])return get(pool,input.statement_id,p,'settlement.statement.'+statementPermissions[name]);
    if(name==='retryExport')return getExport(p,input);
    if(name==='resolveDispute'){const [d]=await rows(pool,'SELECT statement_id FROM commerce_statement_disputes WHERE id=?',[input.dispute_id]);check(d,'异议不存在',404);return get(pool,d.statement_id,p,'settlement.statement.review');}
    let party=input.party_id;
    const lookup={reviewEvidence:['commerce_external_evidence',input.evidence_id],allocateExternalTrade:['commerce_external_trade_events',input.event_id],reviewImport:['commerce_external_import_batches',input.import_id],reviewCoverage:['commerce_external_coverage_reports',input.coverage_id],reviewExternalAccrual:['commerce_external_obligation_events',input.event_id]};
    if(lookup[name]){const [table,key]=lookup[name],[r]=await rows(pool,'SELECT party_id FROM '+table+' WHERE id=?',[key]);check(r,'外部对象不存在',404);party=r.party_id;}
    return auth(p,lookup[name]?'settlement.external.review':'settlement.external.write',{party_id:party,biz_type:'jiazheng',payment_mode:'wechat_mini'});
  }
  for(const name of writeNames){const original=api[name];api[name]=async(p,input)=>{
    await guardWrite(p,name,input);
    if(!input.request_key)return original(p,input); // Internal jobs use natural content/period keys.
    const key=text(input.request_key,'Idempotency-Key',128),digest=hash(canonical(input));
    return tx(async c=>{
      await c.execute('INSERT INTO commerce_statement_requests(actor_id,operation,request_key,request_hash,created_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE request_key=request_key',[actor(p),name,key,digest,clock()]);
      const [request]=await rows(c,'SELECT * FROM commerce_statement_requests WHERE actor_id=? AND operation=? AND request_key=? FOR UPDATE',[actor(p),name,key]);
      check(request.request_hash===digest,'同一请求标识对应不同内容',409,'idempotency_conflict');
      if(request.response!=null)return {...json(request.response),idempotent_replay:true};
      const result=await original(p,input);await c.execute('UPDATE commerce_statement_requests SET response=? WHERE actor_id=? AND operation=? AND request_key=?',[JSON.stringify(result),actor(p),name,key]);return result;
    });
  };}
  return api;
}
module.exports={createStatements,boundary};
