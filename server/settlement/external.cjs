'use strict';

const crypto = require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const id = () => crypto.randomUUID();
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const json = x => typeof x === 'string' ? JSON.parse(x) : x;
function fail(message, status = 409, code = 'settlement_invalid') { return Object.assign(new Error(message), { status, code }); }
function check(ok, message, status, code) { if (!ok) throw fail(message, status, code); }
function text(v, label, max = 191, optional = false) {
  if (optional && (v == null || v === '')) return null;
  check(typeof v === 'string' && v.trim().length > 0 && v.length <= max, label + '无效', 422);
  return v.trim();
}
function money(v, nullable = false) {
  if (nullable && (v == null || v === '')) return null;
  check((typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0), '金额须为非负整数最小货币单位', 422);
  const n = BigInt(v); check(n <= 9223372036854775807n, '金额超出范围', 422); return n.toString();
}
function time(v, nullable = false) {
  if (nullable && !v) return null;
  // Our DATETIME columns store UTC. Legacy business timestamps are explicitly
  // converted by legacyTime and must not depend on the worker's TZ setting.
  if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(v))v=v.replace(' ','T')+'Z';
  const d = v instanceof Date ? v : new Date(v);
  check(Number.isFinite(d.getTime()), '日期无效', 422);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}
function legacyTime(v) {
  if (!v) return null;
  if (v instanceof Date) return time(v);
  try { return time(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + '+08:00'); } catch (_) { return null; }
}
async function ensureCallbackInbox(c){
  try{await c.query('SELECT id FROM commerce_external_callback_inbox LIMIT 0');}
  catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;await c.query(require('./statement-schema.cjs').callbackInboxDdl);}
}
// Internal hook only: vendor_api calls this after HMAC, merchant ownership and
// exact payment-mode checks. No credentials or customer/worker PII are retained.
async function recordVerifiedVendorCallback(c,{order,body,vendorId}){
  if(order.biz_type!=='jiazheng'||order.payment_mode!=='wechat_mini')return null;
  const value=(key,max=191)=>body[key]==null?null:String(body[key]).slice(0,max);
  const payload={order_ref:String(order.order_ref),vendor_oid:value('vendor_oid')||value('lailai_oid'),status:value('status',48),fee:value('fee',40),event_id:value('event_id'),transaction_id:value('transaction_id'),refund_id:value('refund_id'),original_transaction_id:value('original_transaction_id'),amount_minor:value('amount_minor',40),refund_amount_minor:value('refund_amount_minor',40),currency:value('currency',3),occurred_at:value('occurred_at',40)};
  const payloadHash=hash(payload),eventKey=hash([String(vendorId),payload.order_ref,payload.event_id,payloadHash]),key=id();
  await c.execute('INSERT INTO commerce_external_callback_inbox(id,vendor_id,order_ref,event_key,payload_hash,payload,received_at) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',[key,String(vendorId),payload.order_ref,eventKey,payloadHash,JSON.stringify(payload),time(new Date())]);
  return {event_key:eventKey};
}
function createExternal({ pool, authorize, now = () => Date.now(), config = {} }) {
  check(pool && typeof authorize === 'function', '对账数据库及权限检查器必须配置', 500);
  const rawPool=pool,transactions=new AsyncLocalStorage();
  pool=new Proxy(rawPool,{get(target,property){
    if(['execute','query'].includes(property))return (...args)=>(transactions.getStore()||target)[property](...args);
    const value=target[property];return typeof value==='function'?value.bind(target):value;
  }});
  const clock = () => time(new Date(now()));
  const rows = async (c, sql, args = []) => (await c.execute(sql, args))[0];
  const actor = p => { check(p?.account?.id != null, '请登录后操作', 401); return String(p.account.id); };
  async function auth(p, permission, scope) { actor(p); check(await authorize(p, permission, scope) !== false, '无权操作该主体数据', 403, 'settlement_forbidden'); }
  const externalScope = party => ({ party_id: party, biz_type: 'jiazheng', payment_mode: 'wechat_mini' });
  async function tx(fn) {
    if(transactions.getStore())return fn(transactions.getStore());
    const c = await pool.getConnection();
    try { await c.query("SET time_zone='+00:00'"); await c.beginTransaction(); const out = await transactions.run(c,()=>fn(c)); await c.commit(); return out; }
    catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  }
  async function context(c, key, party) {
    const [row] = await rows(c, 'SELECT * FROM commerce_settlement_business_contexts WHERE id=?', [key]);
    check(row && row.party_id === party && row.biz_type === 'jiazheng' && row.payment_mode === 'wechat_mini' && row.execution_scope === 'EXTERNAL_RECORD_ONLY', '外部订单归属或执行范围不符', 403);
    return row;
  }
  function normalized(input) {
    const kind = text(input.event_kind, '事实类型', 32);
    check(['PAYMENT', 'REFUND', 'FULFILLMENT', 'ORDER_STATUS', 'CHANNEL_SETTLEMENT', 'COMMISSION_RECEIPT'].includes(kind), '外部事实类型无效', 422);
    const currency = text(input.currency, '币种', 3, true);
    check(!currency || /^[A-Z]{3}$/.test(currency), '币种无效', 422);
    return {
      party_id: text(input.party_id, '主体', 64), context_id: text(input.context_id, '业务上下文', 36, true),
      channel: text(input.channel, '外部渠道', 48), environment: text(input.environment, '环境', 16),
      merchant_account: text(input.merchant_account, '渠道商户', 128), event_kind: kind,
      transaction_id: text(input.transaction_id, '外部流水', 191, true), original_event_id: text(input.original_event_id, '原交易', 36, true),
      amount_minor: money(input.amount_minor, true), currency, occurred_at: time(input.occurred_at, true),
      source_event_id: text(input.source_event_id, '来源事件号', 191, true),
      vendor_oid: text(input.vendor_oid, '商家订单号', 191, true),
      reported_status: text(input.reported_status, '报送状态', 48, true),
    };
  }
  function identity(n) {
    const prefix = [n.channel, n.environment, n.merchant_account, n.event_kind];
    if (n.transaction_id) return hash([...prefix, 'transaction', n.transaction_id]);
    check(n.context_id || n.source_event_id, '无交易号时必须有订单归属或稳定来源事件号', 422);
    // An amount is deliberately not an identity: changed amounts are corrections,
    // never a second payment inferred from the same unnumbered order report.
    return hash([...prefix, 'candidate', n.context_id || n.source_event_id]);
  }
  async function ingest(c, p, input) {
    const n = normalized(input), source = text(input.source_type || 'MERCHANT_REPORT', '证据来源', 32);
    check(['MERCHANT_REPORT', 'PROVIDER_STATEMENT', 'PROVIDER_QUERY', 'MANUAL_REVIEW', 'LEGACY_ORDER', 'MERCHANT_QUERY'].includes(source), '证据来源无效', 422);
    const evidenceRef = text(input.evidence_ref, '原始凭证引用', 500);
    if (n.context_id) await context(c, n.context_id, n.party_id);
    const key = identity(n), stamp = clock();
    let [event] = await rows(c, 'SELECT e.* FROM commerce_external_trade_aliases a JOIN commerce_external_trade_events e ON e.id=a.event_id WHERE a.alias_key=? FOR UPDATE', [key]);
    if (!event && input.alias_event_id) {
      const [candidate] = await rows(c, 'SELECT * FROM commerce_external_trade_events WHERE id=? FOR UPDATE', [input.alias_event_id]);
      check(candidate && candidate.party_id === n.party_id && candidate.channel === n.channel && candidate.environment === n.environment && candidate.merchant_account === n.merchant_account && candidate.event_kind === n.event_kind && candidate.context_id === n.context_id, '外部流水别名关联不匹配', 409);
      check(!candidate.transaction_id || candidate.transaction_id === n.transaction_id, '不能将两个支付流水归并为一个', 409);
      event = candidate;
    }
    if (!event) {
      const eventId = id();
      await c.execute(`INSERT INTO commerce_external_trade_events(id,party_id,context_id,channel,environment,merchant_account,event_kind,trade_key,transaction_id,original_event_id,amount_minor,currency,occurred_at,received_at,snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
      [eventId,n.party_id,n.context_id,n.channel,n.environment,n.merchant_account,n.event_kind,key,n.transaction_id,n.original_event_id,n.amount_minor,n.currency,n.occurred_at,stamp,JSON.stringify(n)]);
      [event] = await rows(c, 'SELECT * FROM commerce_external_trade_events WHERE trade_key=? FOR UPDATE', [key]);
    }
    check(event.party_id === n.party_id, '外部交易已归属其他主体', 403);
    await c.execute('INSERT INTO commerce_external_trade_aliases(alias_key,event_id,created_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE alias_key=alias_key', [key,event.id,stamp]);
    const [alias]=await rows(c,'SELECT event_id FROM commerce_external_trade_aliases WHERE alias_key=? FOR UPDATE',[key]);
    check(alias.event_id===event.id,'外部流水已关联其他候选事实，需先人工处理冲突',409);
    if(n.transaction_id&&!event.transaction_id)await c.execute('UPDATE commerce_external_trade_events SET transaction_id=? WHERE id=?',[n.transaction_id,event.id]);
    const payloadHash = hash({ n, source, evidenceRef }), evidenceId = id();
    const [insert] = await c.execute(`INSERT INTO commerce_external_evidence(id,event_id,party_id,source_type,source_event_id,payload_hash,evidence_ref,normalized,submitted_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [evidenceId,event.id,n.party_id,source,n.source_event_id,payloadHash,evidenceRef,JSON.stringify(n),actor(p),stamp]);
    const [evidence] = await rows(c, 'SELECT id,review_status FROM commerce_external_evidence WHERE event_id=? AND payload_hash=? FOR UPDATE', [event.id,payloadHash]);
    if (insert.affectedRows === 1 && event.accepted_evidence_id) {
      const mismatched = ['amount_minor','currency','original_event_id','context_id'].some(k => n[k]!=null&&String(event[k] ?? '') !== String(n[k]));
      if (mismatched) await c.execute("UPDATE commerce_external_evidence SET review_status='CONFLICT' WHERE id=?", [evidence.id]);
    }
    return { event_id:event.id, evidence_id:evidence.id, verification_status:event.verification_status, duplicate:insert.affectedRows !== 1 };
  }
  async function ingestEvidence(p, input) {
    await auth(p,'settlement.external.write',externalScope(input.party_id));
    return tx(c => ingest(c,p,input));
  }
  async function syncExternalOrders(p, input) {
    const party = text(input.party_id,'主体',64), vendor = String(input.vendor_id || '');
    check(/^\d+$/.test(vendor),'商户编号无效',422);
    await auth(p,'settlement.external.write',externalScope(party));
    const limit = Math.min(500,Math.max(1,Number(input.limit)||200)), after = Number(input.after_id)||0;
    return tx(async c => {
      const [binding] = await rows(c,"SELECT * FROM commerce_settlement_party_bindings WHERE source_domain='jiazheng' AND source_entity_type='vendor' AND source_entity_id=? AND party_id=? AND status='approved'",[vendor,party]);
      check(binding,'商户与主体缺少已审批映射',409,'party_binding_required');
      const orders = await rows(c,`SELECT * FROM gr_orders WHERE vendor_id=? AND biz_type='jiazheng' AND payment_mode='wechat_mini' AND id>? ORDER BY id LIMIT ${limit}`,[vendor,after]);
      const result=[];
      for (const o of orders) {
        const stamp=clock(), contextId=id(), snap={vendor_id:vendor,vendor_oid:o.vendor_oid||null,product_ref:o.sku,reported_status:o.status,source_created_at:legacyTime(o.created_at),source_paid_at:o.paid_at||null,source_completed_at:o.completed_at||null};
        await c.execute(`INSERT INTO commerce_settlement_business_contexts(id,biz_type,source_order_system,biz_order_no,payment_mode,execution_scope,party_id,currency,snapshot,created_at,updated_at)
          VALUES(?,'jiazheng','gr_orders',?,'wechat_mini','EXTERNAL_RECORD_ONLY',?,NULL,?,?,?) ON DUPLICATE KEY UPDATE id=id`,[contextId,o.order_ref,party,JSON.stringify(snap),stamp,stamp]);
        const [ctx]=await rows(c,"SELECT * FROM commerce_settlement_business_contexts WHERE biz_type='jiazheng' AND source_order_system='gr_orders' AND biz_order_no=?",[o.order_ref]);
        await context(c,ctx.id,party);
        const base={party_id:party,context_id:ctx.id,channel:'wechat_mini',environment:'external',merchant_account:vendor,source_type:'LEGACY_ORDER',evidence_ref:'gr_orders:'+o.id,reported_status:String(o.status),vendor_oid:o.vendor_oid||null,amount_minor:null,currency:null,source_event_id:'gr-order:'+o.id};
        await ingest(c,p,{...base,event_kind:'ORDER_STATUS'});
        // Local callback timestamps are receipt times, not financial occurrence times.
        if(o.paid_at && o.fee != null) await ingest(c,p,{...base,event_kind:'PAYMENT',amount_minor:money(o.fee)});
        if(o.status==='completed')await ingest(c,p,{...base,event_kind:'FULFILLMENT'});
        result.push({context_id:ctx.id,order_ref:o.order_ref,source_id:String(o.id)});
      }
      const callbacks=await rows(c,`SELECT x.*,bc.id context_id FROM commerce_external_callback_inbox x JOIN commerce_settlement_business_contexts bc ON bc.biz_type='jiazheng' AND bc.source_order_system='gr_orders' AND bc.biz_order_no=x.order_ref AND bc.payment_mode='wechat_mini' AND bc.execution_scope='EXTERNAL_RECORD_ONLY' AND bc.party_id=? WHERE x.vendor_id=? AND x.status='PENDING' ORDER BY x.received_at,x.id LIMIT 500 FOR UPDATE`,[party,vendor]);
      const consumed=[];
      for(const callback of callbacks){
        await c.query('SAVEPOINT external_callback');
        try{
          const payload=json(callback.payload),reported={account:{id:'vendor:'+vendor}},safeMoney=v=>{try{return money(v,true);}catch{return null;}},safeTime=v=>{try{return time(v,true);}catch{return null;}};
          const base={party_id:party,context_id:callback.context_id,channel:'wechat_mini',environment:'external',merchant_account:vendor,source_type:'MERCHANT_REPORT',source_event_id:'callback:'+callback.id,evidence_ref:'callback-inbox:'+callback.id,vendor_oid:payload.vendor_oid,reported_status:payload.status,currency:/^[A-Z]{3}$/.test(payload.currency||'')?payload.currency:null,occurred_at:safeTime(payload.occurred_at),amount_minor:null};
          await ingest(c,reported,{...base,event_kind:'ORDER_STATUS'});
          if(payload.status==='paid'){
            const [candidate]=await rows(c,"SELECT id FROM commerce_external_trade_events WHERE context_id=? AND event_kind='PAYMENT' AND transaction_id IS NULL ORDER BY received_at LIMIT 1",[callback.context_id]);
            await ingest(c,reported,{...base,event_kind:'PAYMENT',transaction_id:payload.transaction_id,alias_event_id:candidate?.id,amount_minor:safeMoney(payload.amount_minor??payload.fee)});
          }
          if(['completed','done'].includes(payload.status))await ingest(c,reported,{...base,event_kind:'FULFILLMENT'});
          if(['refunded','partially_refunded','refund_success'].includes(payload.status)){
            const original=payload.original_transaction_id?(await rows(c,"SELECT id FROM commerce_external_trade_events WHERE party_id=? AND merchant_account=? AND channel='wechat_mini' AND environment='external' AND event_kind='PAYMENT' AND transaction_id=?",[party,vendor,payload.original_transaction_id]))[0]:null;
            await ingest(c,reported,{...base,event_kind:'REFUND',transaction_id:payload.refund_id||payload.transaction_id,original_event_id:original?.id||null,amount_minor:safeMoney(payload.refund_amount_minor??payload.amount_minor)});
          }
          await c.execute("UPDATE commerce_external_callback_inbox SET status='CONSUMED',party_id=?,consumed_at=?,attempts=attempts+1,last_error=NULL WHERE id=?",[party,clock(),callback.id]);consumed.push(callback.id);
        }catch(e){await c.query('ROLLBACK TO SAVEPOINT external_callback');await c.execute('UPDATE commerce_external_callback_inbox SET attempts=attempts+1,last_error=? WHERE id=?',[String(e.code||'invalid_callback').slice(0,100),callback.id]);}
      }
      return {rows:result,next_after_id:orders.length?String(orders.at(-1).id):String(after),has_more:orders.length===limit,consumed_callback_ids:consumed};
    });
  }
  async function reviewEvidence(p,input) {
    actor(p); const note=text(input.note,'核验意见',1000);check(['verify','reject'].includes(input.decision),'核验动作无效',422);
    return tx(async c=>{
      const [initial]=await rows(c,'SELECT * FROM commerce_external_evidence WHERE id=?',[input.evidence_id]);check(initial,'证据不存在',404);
      await auth(p,'settlement.external.review',externalScope(initial.party_id));
      check(initial.submitted_by!==actor(p),'证据提交人不能复核本人材料',403);
      const n=json(initial.normalized);
      // Lock the original payment first. Concurrent refund verifications serialize
      // on it even when each request reviews a different refund.
      let original;
      if(n.original_event_id)[original]=await rows(c,'SELECT * FROM commerce_external_trade_events WHERE id=? FOR UPDATE',[n.original_event_id]);
      const [event]=await rows(c,'SELECT * FROM commerce_external_trade_events WHERE id=? FOR UPDATE',[initial.event_id]);
      const [e]=await rows(c,'SELECT * FROM commerce_external_evidence WHERE id=? FOR UPDATE',[input.evidence_id]);
      const [prior]=await rows(c,'SELECT * FROM commerce_external_reviews WHERE evidence_id=?',[e.id]);
      if(prior)return {event_id:event.id,status:prior.decision,version:prior.fact_version,reused:true};
      let decision=input.decision==='reject'?'REJECTED':'VERIFIED';
      if(decision==='VERIFIED'){
        if(['PAYMENT','REFUND','CHANNEL_SETTLEMENT','COMMISSION_RECEIPT'].includes(n.event_kind))check(n.amount_minor!=null&&n.currency&&n.occurred_at,'资金核验需明确金额、币种及真实发生时间',422);
        if(event.accepted_evidence_id && ['amount_minor','currency','original_event_id','context_id'].some(k=>String(event[k]??'')!==String(n[k]??'')))decision='CONFLICT';
        if(String(event.context_id||'')!==String(n.context_id||''))decision='CONFLICT';
        if(n.event_kind==='REFUND'){
          check(original && original.party_id===event.party_id && original.channel===event.channel && original.environment===event.environment && original.merchant_account===event.merchant_account && original.event_kind==='PAYMENT' && original.verification_status==='VERIFIED','退款须关联同主体同渠道已核验原交易',409);
          check(original.currency===n.currency,'退款币种与原交易不符',409);
          const refunds=await rows(c,"SELECT amount_minor FROM commerce_external_trade_events WHERE original_event_id=? AND event_kind='REFUND' AND verification_status='VERIFIED' AND id<>? FOR UPDATE",[original.id,event.id]);
          if(refunds.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n)+BigInt(n.amount_minor)>BigInt(original.amount_minor))decision='CONFLICT';
        }
      }
      const version=Number(event.version)+1,stamp=clock();
      await c.execute('INSERT INTO commerce_external_reviews(id,evidence_id,event_id,reviewer_id,decision,note,fact_version,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[id(),e.id,event.id,actor(p),decision,note,version,JSON.stringify(n),stamp]);
      await c.execute('UPDATE commerce_external_evidence SET review_status=? WHERE id=?',[decision,e.id]);
      if(decision==='VERIFIED')await c.execute("UPDATE commerce_external_trade_events SET verification_status='VERIFIED',version=?,accepted_evidence_id=?,amount_minor=?,currency=?,occurred_at=?,verified_at=?,transaction_id=COALESCE(transaction_id,?),original_event_id=?,snapshot=? WHERE id=?",[version,e.id,n.amount_minor,n.currency,n.occurred_at,stamp,n.transaction_id,n.original_event_id,JSON.stringify(n),event.id]);
      else if(!event.accepted_evidence_id)await c.execute('UPDATE commerce_external_trade_events SET verification_status=?,version=? WHERE id=?',[decision,version,event.id]);
      else await c.execute('UPDATE commerce_external_trade_events SET version=? WHERE id=?',[version,event.id]);
      return {event_id:event.id,status:decision,version};
    });
  }
  async function listExternalEvents(p,input){
    await auth(p,'settlement.external.read',externalScope(input.party_id));
    const out=await rows(pool,`SELECT e.*, (SELECT COUNT(*) FROM commerce_external_evidence x WHERE x.event_id=e.id AND x.review_status='CONFLICT') conflict_count FROM commerce_external_trade_events e WHERE party_id=? ORDER BY received_at DESC,id LIMIT 500`,[input.party_id]);
    for(const e of out)e.evidence=await rows(pool,'SELECT id,source_type,source_event_id,evidence_ref,submitted_by,review_status,created_at FROM commerce_external_evidence WHERE event_id=? ORDER BY created_at',[e.id]);
    return {rows:out.map(e=>({...e,snapshot:json(e.snapshot)}))};
  }
  async function allocateExternalTrade(p,input){
    const amount=money(input.amount_minor);check(BigInt(amount)>0n,'分配额必须大于零',422);
    check(['PAYMENT_BASIS','CONSUMER_REFUND','CHANNEL_SETTLEMENT','COMMISSION_RECEIPT'].includes(input.purpose),'分配用途无效',422);
    return tx(async c=>{
      const [e]=await rows(c,'SELECT * FROM commerce_external_trade_events WHERE id=? FOR UPDATE',[input.event_id]);check(e,'外部事实不存在',404);
      await auth(p,'settlement.external.review',externalScope(e.party_id));await context(c,input.context_id,e.party_id);
      check(e.verification_status==='VERIFIED'&&e.amount_minor!=null,'只能分配已核验资金事实');
      check(!e.context_id||e.context_id===input.context_id,'单订单已关联流水不能再次分配给其他订单');
      const expected={PAYMENT_BASIS:'PAYMENT',CONSUMER_REFUND:'REFUND',CHANNEL_SETTLEMENT:'CHANNEL_SETTLEMENT',COMMISSION_RECEIPT:'COMMISSION_RECEIPT'};
      check(e.event_kind===expected[input.purpose],'分配用途与事实类型不符');
      const key=hash([e.id,text(input.request_key,'请求标识',100)]);
      const [prior]=await rows(c,'SELECT * FROM commerce_external_trade_allocations WHERE request_key=?',[key]);
      if(prior){check(prior.context_id===input.context_id&&String(prior.amount_minor)===amount&&prior.purpose===input.purpose,'重复请求内容不一致');return {...prior,reused:true};}
      const [sum]=await rows(c,'SELECT COALESCE(SUM(amount_minor),0) total FROM commerce_external_trade_allocations WHERE event_id=?',[e.id]);
      check(BigInt(sum.total)+BigInt(amount)<=BigInt(e.amount_minor),'累计分配超过已核验金额');
      const allocationId=id();await c.execute('INSERT INTO commerce_external_trade_allocations(id,event_id,context_id,purpose,amount_minor,currency,request_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[allocationId,e.id,input.context_id,input.purpose,amount,e.currency,key,actor(p),clock()]);
      return {id:allocationId,event_id:e.id,amount_minor:amount,currency:e.currency};
    });
  }
  async function importExternalEvidence(p,input){
    await auth(p,'settlement.external.write',externalScope(input.party_id));
    const content=Buffer.from(text(input.file_base64,'导入文件',14000000),'base64');check(content.length>0&&content.length<=8*1024*1024,'文件大小须为1字节至8MB',422);
    const format=String(input.format||'json').toLowerCase();let items;
    if(format==='json')items=JSON.parse(content.toString('utf8'));
    else if(format==='xlsx'){
      const ExcelJS=require('exceljs'),wb=new ExcelJS.Workbook();await wb.xlsx.load(content);const sheet=wb.worksheets[0];check(sheet,'工作表为空',422);
      const headers=sheet.getRow(1).values.slice(1).map(String);items=[];
      sheet.eachRow((r,n)=>{if(n>1){const o={};headers.forEach((k,i)=>{const v=r.getCell(i+1).value;check(v==null||['string','number','boolean'].includes(typeof v),'导入不允许公式或富文本',422);o[k]=v;});items.push(o);}});
    }else if(format==='csv'){
      const ExcelJS=require('exceljs'),{Readable}=require('node:stream'),wb=new ExcelJS.Workbook();const sheet=await wb.csv.read(Readable.from([content]),{map:v=>v});const headers=sheet.getRow(1).values.slice(1).map(String);items=[];
      sheet.eachRow((r,n)=>{if(n>1){const o={};headers.forEach((k,i)=>{o[k]=r.getCell(i+1).value;});items.push(o);}});
    }else throw fail('导入格式须为 json/csv/xlsx',422);
    check(Array.isArray(items)&&items.length<=2000,'每批最多2000行',422);
    return tx(async c=>{
      const fileHash=hash(content),channel=text(input.channel,'渠道',48),environment=text(input.environment,'环境',16);
      const [old]=await rows(c,'SELECT * FROM commerce_external_import_batches WHERE party_id=? AND channel=? AND environment=? AND file_hash=? FOR UPDATE',[input.party_id,channel,environment,fileHash]);
      if(old)return {...old,source_blob:undefined,results:json(old.results),reused:true};
      const importId=id(),results=[];
      for(let i=0;i<items.length;i++){
        await c.query('SAVEPOINT external_import_row');
        try{const r=await ingest(c,p,{...items[i],party_id:input.party_id,channel,environment,source_type:input.source_type||'MERCHANT_REPORT',evidence_ref:'import:'+importId+':'+(i+1)});results.push({row:i+1,...r});}
        catch(e){await c.query('ROLLBACK TO SAVEPOINT external_import_row');results.push({row:i+1,error:e.code||'invalid_row',message:e.message});}
      }
      await c.execute('INSERT INTO commerce_external_import_batches(id,party_id,channel,environment,file_hash,template_version,original_name,source_blob,submitted_by,status,results,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[importId,input.party_id,channel,environment,fileHash,text(input.template_version||'v1','模板版本',32),text(input.filename||'import.'+format,'文件名',200),content,actor(p),'PENDING_REVIEW',JSON.stringify(results),clock()]);
      return {id:importId,file_hash:fileHash,status:'PENDING_REVIEW',results};
    });
  }
  async function reviewImport(p,input){return tx(async c=>{
    const [batch]=await rows(c,'SELECT * FROM commerce_external_import_batches WHERE id=? FOR UPDATE',[input.import_id]);check(batch,'导入批次不存在',404);
    await auth(p,'settlement.external.review',externalScope(batch.party_id));check(batch.submitted_by!==actor(p),'提交人不能复核自己的导入',403);
    const results=[];
    for(const row of json(batch.results)){
      if(!row.evidence_id){results.push(row);continue;}
      await c.query('SAVEPOINT external_import_review');
      try{results.push({row:row.row,...await reviewEvidence(p,{evidence_id:row.evidence_id,decision:input.decision,note:input.note})});}
      catch(e){if(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(e.code))throw e;await c.query('ROLLBACK TO SAVEPOINT external_import_review');results.push({row:row.row,evidence_id:row.evidence_id,error:e.code||'review_failed',message:e.message});}
    }
    const state=results.some(x=>x.error||x.status==='CONFLICT')?'PARTIAL':'REVIEWED';
    await c.execute('UPDATE commerce_external_import_batches SET status=? WHERE id=?',[state,batch.id]);
    return {id:batch.id,status:state,results};
  });}
  async function submitCoverage(p,input){
    await auth(p,'settlement.external.write',externalScope(input.party_id));
    const boundary=v=>time(/^\d{4}-\d{2}-\d{2}$/.test(v)?v+'T00:00:00+08:00':v);
    const currency=text(input.currency,'币种',3),start=boundary(input.period_start),end=boundary(input.period_end);
    check(/^[A-Z]{3}$/.test(currency)&&start<end,'完整性期间或币种无效',422);
    const types=[...new Set(input.fact_types||[])].sort();check(types.length>0&&types.every(x=>['PAYMENT','REFUND','FULFILLMENT','CHANNEL_SETTLEMENT','COMMISSION_RECEIPT'].includes(x)),'完整性事实范围无效',422);
    const coverageId=id();await pool.execute('INSERT INTO commerce_external_coverage_reports(id,party_id,currency,period_start,period_end,fact_types,evidence_ref,submitted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[coverageId,input.party_id,currency,start,end,JSON.stringify(types),text(input.evidence_ref,'完整性凭证',500),actor(p),clock()]);return {id:coverageId,status:'PENDING'};
  }
  async function reviewCoverage(p,input){return tx(async c=>{
    const [r]=await rows(c,'SELECT * FROM commerce_external_coverage_reports WHERE id=? FOR UPDATE',[input.coverage_id]);check(r,'完整性报告不存在',404);
    await auth(p,'settlement.external.review',externalScope(r.party_id));check(r.submitted_by!==actor(p),'完整性报告不能由本人复核',403);
    check(['approve','reject'].includes(input.decision),'复核动作无效',422);if(r.status!=='PENDING')return {id:r.id,status:r.status,reused:true};
    const status=input.decision==='approve'?'VERIFIED':'REJECTED';await c.execute('UPDATE commerce_external_coverage_reports SET status=?,reviewed_by=?,review_note=?,reviewed_at=? WHERE id=?',[status,actor(p),text(input.note,'完整性复核意见',1000),clock(),r.id]);return {id:r.id,status};
  });}
  async function recordExternalAccrual(p,input){
    const amount=money(input.amount_minor),kind=input.event_kind||'ACCRUAL';check(BigInt(amount)>0n,'应计金额必须大于零',422);
    check(['ACCRUAL','REDUCTION','SETTLEMENT'].includes(kind),'外部应计动作无效',422);
    const party=text(input.party_id,'主体',64);await auth(p,'settlement.external.write',externalScope(party));
    return tx(async c=>{
      const ctx=await context(c,input.context_id,party),profileId=text(input.profile_id,'审批方案',36);
      const [profile]=await rows(c,"SELECT * FROM commerce_settlement_profiles WHERE id=? AND party_id=? AND biz_type='jiazheng' AND payment_mode='wechat_mini' AND status='approved'",[profileId,party]);
      check(profile,'外部应计缺少已批准协议方案');const policy=json(profile.snapshot),calc={...(policy.calculation||{}),contract_ref:policy.calculation?.contract_ref||policy.contract_ref};
      check(calc.contract_ref,'方案缺少合同依据');
      const creditor=text(input.creditor_party_id,'债权人',64),debtor=text(input.debtor_party_id,'债务人',64);
      check(creditor!==debtor&&[creditor,debtor].includes(party),'债权债务主体无效',422);
      if(calc.creditor_party_id)check(calc.creditor_party_id===creditor,'债权人不符批准合同');
      if(calc.debtor_party_id)check(calc.debtor_party_id===debtor,'债务人不符批准合同');
      const currency=text(input.currency,'币种',3);check(/^[A-Z]{3}$/.test(currency),'币种无效',422);
      const component=text(input.component||'PLATFORM_COMMISSION','应计组件',48),request=hash([party,text(input.request_key,'请求标识',100)]);
      const frozen={context_id:ctx.id,profile_id:profileId,profile_version:profile.version,calculation:calc,refund_policy:policy.refund_policy||null,creditor,debtor,currency,component,amount_minor:amount,event_kind:kind,evidence_event_id:input.evidence_event_id||null,fulfillment_event_id:input.fulfillment_event_id||null};
      const requestHash=hash(frozen),[previous]=await rows(c,'SELECT * FROM commerce_external_obligation_events WHERE request_key=?',[request]);
      if(previous){check(previous.request_hash===requestHash,'请求标识对应不同应计内容');return {...previous,reused:true};}
      let obligation;
      if(input.obligation_id){[obligation]=await rows(c,'SELECT * FROM commerce_external_obligations WHERE id=? FOR UPDATE',[input.obligation_id]);check(obligation&&obligation.context_id===ctx.id&&obligation.party_id===party&&obligation.creditor_party_id===creditor&&obligation.debtor_party_id===debtor&&obligation.currency===currency,'应计归属不符');}
      else{
        check(kind==='ACCRUAL','冲回和清偿须关联原应计');
        const obligationId=id();await c.execute('INSERT INTO commerce_external_obligations(id,context_id,party_id,creditor_party_id,debtor_party_id,currency,component,agreement_ref,rule_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',[obligationId,ctx.id,party,creditor,debtor,currency,component,String(calc.contract_ref),String(profile.version),clock(),clock()]);
        [obligation]=await rows(c,'SELECT * FROM commerce_external_obligations WHERE context_id=? AND component=? AND creditor_party_id=? AND debtor_party_id=? AND agreement_ref=? FOR UPDATE',[ctx.id,component,creditor,debtor,String(calc.contract_ref)]);
      }
      const eventId=id();await c.execute('INSERT INTO commerce_external_obligation_events(id,obligation_id,party_id,event_kind,amount_minor,evidence_event_id,request_key,request_hash,agreement_evidence,reason,submitted_by,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[eventId,obligation.id,party,kind,amount,input.evidence_event_id||null,request,requestHash,text(input.evidence_ref,'合同/履约凭证',500),text(input.reason,'计费说明',1000),actor(p),JSON.stringify(frozen),clock()]);
      return {id:eventId,obligation_id:obligation.id,status:'PENDING'};
    });
  }
  async function reviewExternalAccrual(p,input){
    const note=text(input.note,'复核意见',1000);check(['approve','reject'].includes(input.decision),'复核动作无效',422);
    return tx(async c=>{
      const [first]=await rows(c,'SELECT * FROM commerce_external_obligation_events WHERE id=?',[input.event_id]);check(first,'应计申请不存在',404);
      await auth(p,'settlement.external.review',externalScope(first.party_id));check(first.submitted_by!==actor(p),'申请人不能复核自己的应计',403);
      // Global evidence lock precedes obligation lock so one receipt cannot be
      // concurrently used in full against several obligations.
      let evidence;if(first.evidence_event_id)[evidence]=await rows(c,'SELECT * FROM commerce_external_trade_events WHERE id=? FOR UPDATE',[first.evidence_event_id]);
      const [ob]=await rows(c,'SELECT * FROM commerce_external_obligations WHERE id=? FOR UPDATE',[first.obligation_id]);
      const [e]=await rows(c,'SELECT * FROM commerce_external_obligation_events WHERE id=? FOR UPDATE',[first.id]);
      if(e.status!=='PENDING')return {id:e.id,status:e.status,reused:true};
      if(input.decision==='reject'){await c.execute("UPDATE commerce_external_obligation_events SET status='REJECTED',reviewed_by=? WHERE id=?",[actor(p),e.id]);return {id:e.id,status:'REJECTED'};}
      const s=json(e.snapshot),amount=BigInt(e.amount_minor),accrued=BigInt(ob.accrued_minor),reduced=BigInt(ob.reduced_minor),settled=BigInt(ob.settled_minor);
      check(evidence&&evidence.party_id===e.party_id&&evidence.verification_status==='VERIFIED'&&evidence.currency===ob.currency,'需要同主体同币种已核验交易证据');
      const [allocated]=await rows(c,'SELECT COALESCE(SUM(amount_minor),0) total FROM commerce_external_trade_allocations WHERE event_id=? AND context_id=?',[evidence.id,ob.context_id]);
      check(evidence.context_id===ob.context_id||BigInt(allocated.total)>0n,'证据尚未关联或分配至本业务订单');
      let adjustment={},delta={};
      if(e.event_kind==='ACCRUAL'){
        check(evidence.event_kind==='PAYMENT','应计需已核验原支付');
        const [fulfillment]=await rows(c,"SELECT * FROM commerce_external_trade_events WHERE id=? AND context_id=? AND event_kind='FULFILLMENT' AND verification_status='VERIFIED'",[s.fulfillment_event_id,ob.context_id]);check(fulfillment,'应计需已核验履约确认');
        const basis=evidence.context_id===ob.context_id?BigInt(evidence.amount_minor):BigInt(allocated.total);
        const calculated=require('./primitives.cjs').calculate({...s.calculation,amount_minor:basis.toString()}),expected=BigInt(calculated.commission_minor);
        check(amount===expected&&accrued===0n,'应计须与批准合同金额一致，且同一义务只能首次确认一次');
        adjustment={accrued_minor:amount.toString()};delta={accrual_delta_minor:amount.toString(),basis_minor:basis.toString()};
      }else if(e.event_kind==='SETTLEMENT'){
        check(evidence.event_kind==='COMMISSION_RECEIPT','商户消费者收款不能替代平台佣金到账');
        const used=await rows(c,"SELECT amount_minor FROM commerce_external_obligation_events WHERE evidence_event_id=? AND event_kind='SETTLEMENT' AND status='POSTED' FOR UPDATE",[evidence.id]);
        check(used.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n)+amount<=BigInt(evidence.amount_minor),'同笔佣金到账已被认领，累计清偿超额');
        if(evidence.context_id!==ob.context_id){
          const claimed=await rows(c,"SELECT e.amount_minor FROM commerce_external_obligation_events e JOIN commerce_external_obligations o ON o.id=e.obligation_id WHERE e.evidence_event_id=? AND e.event_kind='SETTLEMENT' AND e.status='POSTED' AND o.context_id=? FOR UPDATE",[evidence.id,ob.context_id]);
          check(claimed.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n)+amount<=BigInt(allocated.total),'清偿超过本订单已核验分配额');
        }
        check(amount<=accrued-reduced-settled,'清偿超过未结应收');adjustment={settled_minor:(settled+amount).toString()};delta={settlement_delta_minor:amount.toString()};
      }else{
        check(evidence.event_kind==='REFUND','退佣需已核验外部退款及批准退佣依据');
        check(amount<=accrued-reduced-BigInt(ob.return_due_minor),'退佣超过累计应计');
        const [originalAccrual]=await rows(c,"SELECT * FROM commerce_external_obligation_events WHERE obligation_id=? AND event_kind='ACCRUAL' AND status='POSTED' ORDER BY posted_at LIMIT 1",[ob.id]);
        check(originalAccrual&&evidence.original_event_id===originalAccrual.evidence_event_id,'退款须关联本应计确认使用的原支付');
        const originalRule=json(originalAccrual.snapshot);check(s.profile_id===originalRule.profile_id&&s.profile_version===originalRule.profile_version,'退佣应使用原应计合同版本，变更合同须另行修订');
        const priorRefunds=await rows(c,"SELECT amount_minor FROM commerce_external_obligation_events WHERE evidence_event_id=? AND obligation_id=? AND event_kind='REDUCTION' AND status='POSTED' FOR UPDATE",[evidence.id,ob.id]);
        const basis=evidence.context_id===ob.context_id?BigInt(evidence.amount_minor):BigInt(allocated.total);
        let cap;
        if(s.calculation.mode==='FIXED_COST'){
          check(originalRule.refund_policy?.mode==='PROPORTIONAL_TO_PAID','固定成本退佣需批准的 PROPORTIONAL_TO_PAID 退佣协议');
          const originalBasis=BigInt(originalRule.effect?.basis_minor||0);check(originalBasis>0n,'原应计计费基数缺失');
          cap=s.calculation.rounding==='HALF_UP_BPS_V1'?(basis*accrued+originalBasis/2n)/originalBasis:basis*accrued/originalBasis;
        }else{
          const bps=BigInt(s.calculation.commission_bps??-1);check(bps>=0n&&bps<=10000n,'合同没有明确退款佣金比例');
          cap=s.calculation.rounding==='HALF_UP_BPS_V1'?(basis*bps+5000n)/10000n:basis*bps/10000n;
        }
        check(priorRefunds.reduce((sum,r)=>sum+BigInt(r.amount_minor),0n)+amount<=cap,'同笔退款累计退佣超过批准比例');
        const outstanding=accrued-reduced-settled,unpaid=amount<outstanding?amount:outstanding,returnDue=amount-unpaid;
        adjustment={reduced_minor:(reduced+unpaid).toString(),return_due_minor:(BigInt(ob.return_due_minor)+returnDue).toString()};delta={reduction_delta_minor:unpaid.toString(),return_delta_minor:returnDue.toString()};
      }
      for(const [column,value]of Object.entries(adjustment))await c.execute('UPDATE commerce_external_obligations SET '+column+'=?,updated_at=? WHERE id=?',[value,clock(),ob.id]);
      await c.execute("UPDATE commerce_external_obligation_events SET status='POSTED',reviewed_by=?,posted_at=?,snapshot=? WHERE id=?",[actor(p),clock(),JSON.stringify({...s,review_note:note,effect:{...adjustment,...delta}}),e.id]);
      return {id:e.id,obligation_id:ob.id,status:'POSTED',effect:adjustment,execution_scope:'EXTERNAL_RECORD_ONLY'};
    });
  }
  return {syncExternalOrders,ingestEvidence,reviewEvidence,listExternalEvents,allocateExternalTrade,importExternalEvidence,reviewImport,submitCoverage,reviewCoverage,recordExternalAccrual,reviewExternalAccrual,
    _internals:{tx,rows,auth,actor,clock,externalScope,context,pool}};
}
module.exports={createExternal,id,hash,json,check,fail,money,time,text,ensureCallbackInbox,recordVerifiedVendorCallback};
