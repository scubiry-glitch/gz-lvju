'use strict';
const crypto = require('node:crypto');
function fault(message, status = 400, code = 'settlement_invalid') { return Object.assign(new Error(message), { status, statusCode: status, code }); }
function assert(condition, message, status = 400, code) { if (!condition) throw fault(message, status, code); }
const id = () => crypto.randomUUID();
function parse(value, fallback = {}) { if (value == null) return fallback; return typeof value === 'string' ? JSON.parse(value) : value; }
function canonical(value) {
  if (value === undefined) throw fault('快照字段不可为 undefined');
  if (value === null || typeof value !== 'object') return JSON.stringify(typeof value === 'bigint' ? value.toString() : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function minor(value, { signed = false, nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value === 'number') assert(Number.isSafeInteger(value), '金额必须为安全整数分');
  const str = String(value);
  assert((signed ? /^-?\d{1,18}$/ : /^\d{1,18}$/).test(str), '金额必须为整数分');
  const n = BigInt(str); assert(n >= (signed ? -999999999999999999n : 0n) && n <= 999999999999999999n, '金额超出范围');
  return n.toString();
}
function sqlDate(value = Date.now()) {
  if (value == null || value === '') return null;
  const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const d = new Date(normalized); assert(Number.isFinite(d.getTime()), '时间无效');
  return d.toISOString().slice(0,19).replace('T',' ');
}
async function transaction(pool, fn, existing) {
  if (existing) return fn(existing);
  for (let attempt=0; ; attempt++) {
    const c = await pool.getConnection();
    try { await c.query("SET time_zone='+00:00'");await c.beginTransaction(); const out = await fn(c); await c.commit(); return out; }
    catch (e) { await c.rollback().catch(() => {}); if(!['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(e.code)||attempt>=3)throw e; }
    finally { c.release(); }
  }
}
function configurePool(pool){
 const marker=Symbol.for('sy.settlement.utcPool');if(!pool||pool[marker]||typeof pool.on!=='function')return;pool[marker]=true;
 // mysql2 emits acquire before handing the raw connection to an execute/query
 // callback. Its protocol queue applies UTC before that caller's SQL, including
 // already-created pool connections. Client timezone alone is insufficient.
 pool.on('acquire',connection=>connection.query("SET time_zone='+00:00'",error=>{if(error)connection.destroy();}));
}
const rows = async (c, sql, args = []) => (await c.execute(sql, args))[0];
function calculate(input) {
  const amount = BigInt(minor(input.amount_minor));
  const bps = v => { assert(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10000, '比例须为 0 至 10000 基点'); return BigInt(v); };
  const round = (n, r) => input.rounding === 'HALF_UP_BPS_V1' ? (n*r+5000n)/10000n : n*r/10000n;
  assert(['FLOOR_BPS_V1','HALF_UP_BPS_V1'].includes(input.rounding), '计算舍入版本未批准');
  let merchant, commission;
  if (input.mode === 'FIXED_COST') { merchant = BigInt(minor(input.fixed_cost_minor)); commission = BigInt(minor(input.fixed_commission_minor)); }
  else { assert(input.mode === 'PROPORTIONAL','分账模式无效'); commission = round(amount, bps(input.commission_bps)); merchant = amount - commission; }
  assert(merchant + commission <= amount, '应结超过资金分配');
  const promoter = input.promoter_party_id ? round(commission,bps(input.channel_bps || 0)) : 0n;
  return { amount_minor: amount.toString(), merchant_minor: merchant.toString(), commission_minor: commission.toString(), promoter_minor: promoter.toString(), retained_minor:(commission-promoter).toString(), unallocated_minor:(amount-merchant-commission).toString() };
}
async function postLedger(c, event) {
  const lines = event.lines.map(l => ({ ...l, amount_minor: minor(l.amount_minor ?? l.amount) })).filter(l => BigInt(l.amount_minor) > 0n);
  if (!lines.length) return null;
  let balance = 0n;
  for (const l of lines) { assert(['debit','credit'].includes(l.side), '账务方向无效'); balance += (l.side === 'debit' ? 1n : -1n) * BigInt(l.amount_minor); }
  assert(lines.length >= 2 && balance === 0n, '账务借贷不平衡',409);
  const fingerprint = hash({ ...event, lines });
  const prior = (await rows(c,'SELECT * FROM commerce_ledger_events WHERE event_key=? FOR UPDATE',[event.event_key]))[0];
  if (prior) { assert(prior.payload_hash === fingerprint, '相同账务事件内容冲突',409); return prior.id; }
  const eventId = id();
  await c.execute('INSERT INTO commerce_ledger_events(id,event_key,context_id,payload_hash,payload,posted_at) VALUES(?,?,?,?,?,?)',[eventId,event.event_key,event.context_id || null,fingerprint,JSON.stringify({...event,lines}),event.posted_at || sqlDate()]);
  for (const l of lines) await c.execute('INSERT INTO commerce_ledger_entries(group_no,side,account,amount_minor,source_type,source_id,rule_ref,memo,event_id,context_id) VALUES(?,?,?,?,?,?,?,?,?,?)',[eventId,l.side,l.account,l.amount_minor,event.source_type || 'shared_settlement',String(event.source_id || eventId).slice(0,48),event.rule_ref || null,event.memo || null,eventId,event.context_id || null]);
  return eventId;
}
// 双人复核（起草人≠复核人）总开关：SETTLEMENT_MAKER_CHECKER=0 时允许起草人自行发布/批准（演示/单账号线）。
const makerCheckerRequired = () => (process.env.SETTLEMENT_MAKER_CHECKER ?? '1') !== '0';
module.exports = { fault, assert, id, parse, canonical, hash, minor, sqlDate, transaction, configurePool, rows, calculate, postLedger, makerCheckerRequired };
