'use strict';
// No guessed ACN fields, status codes, units or success fixtures. A reviewed,
// versioned mapping is required before any provider request can be constructed.
const crypto = require('node:crypto');
function fault(message, code = 'SETTLEMENT_PROVIDER_CONTRACT', status = 409) {
  const e = new Error(message); e.code = code; e.status = status; return e;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (value === undefined || typeof value === 'function' || !Number.isFinite(value) && typeof value === 'number') throw fault('Invalid canonical value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function authorizationHash(snapshot) { const { hash: _ignored, ...data } = snapshot; return digest(data); }
function minor(value, positive = false) {
  if (!(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) && !(Number.isSafeInteger(value) && value >= 0)) throw fault('金额必须为整数分', 'INVALID_AMOUNT', 422);
  const n = BigInt(value); if (n > 9223372036854775807n || positive && n === 0n) throw fault('金额超限或为零', 'INVALID_AMOUNT', 422); return n;
}
function get(value, path) {
  if (!path || typeof path !== 'string') return undefined;
  return path.split('.').reduce((v, k) => v != null && Object.prototype.hasOwnProperty.call(v, k) && !['__proto__', 'prototype', 'constructor'].includes(k) ? v[k] : undefined, value);
}
function amount(value, unit) {
  if (unit === 'minor') return minor(value).toString();
  if (unit !== 'yuan') throw fault('外部金额单位未核验');
  const n = minor(value); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}
function decodeAmount(value, unit) {
  if (unit === 'minor') return minor(value).toString();
  if (unit !== 'yuan' || typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw fault('机构金额格式不匹配');
  const [a, b = ''] = value.split('.'); return minor(BigInt(a) * 100n + BigInt(b.padEnd(2, '0')) + '').toString();
}
function template(node, scope) {
  if (Array.isArray(node)) return node.map(n => template(n, scope));
  if (!node || typeof node !== 'object') return node;
  if (Object.hasOwn(node, '$ref')) {
    const v = get(scope, node.$ref); if (v === undefined || v === null) throw fault('映射缺少必要字段: ' + node.$ref);
    return node.$unit ? amount(v, node.$unit) : v;
  }
  if (Object.hasOwn(node, '$each')) {
    const list = get(scope, node.$each); if (!Array.isArray(list)) throw fault('映射列表不存在');
    return list.map(line => template(node.template, { ...scope, line }));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) throw fault('无效映射字段');
    return [k, template(v, scope)];
  }));
}
function createProvider({ config = {}, payCenter = {} } = {}) {
  const contractDigest=c=>{const {enabled:ignored,...frozen}=c;return digest(frozen);};
  function contract(version, operation, {queryOnly=false}={}) {
    const c = (config.provider_contracts || {})[version];
    if ((!queryOnly && config.execution_enabled !== true) || !c || (!queryOnly && c.enabled !== true) || c.verified !== true || !c.evidence_ref || !c.provider || !c.environment) throw fault('真实分账能力未启用或机构契约未核验', 'PROVIDER_CAPABILITY_DISABLED');
    if (!c.operations || !c.operations[operation]) throw fault('机构未核验此资金操作', 'PROVIDER_OPERATION_DISABLED');
    const op = c.operations[operation];
    if (!op.submit || !op.query || !op.result || !['minor', 'yuan'].includes(op.amount_unit)) throw fault('机构映射不完整');
    for (const action of ['submit', 'query']) {
      if (!['splitApply', 'splitReturn', 'querySplitResult', 'payout', 'queryPayout', 'release', 'queryRelease'].includes(op[action].method) || typeof payCenter[op[action].method] !== 'function') throw fault('机构方法未实现', 'PROVIDER_OPERATION_DISABLED');
    }
    return { ...c, version, op };
  }
  function build(version, operation, input) {
    const c = contract(version, operation);
    return { submit: template(c.op.submit.template, input), query: template(c.op.query.template, input), contract_hash: contractDigest(c), version };
  }
  function normalize(c, input, raw) {
    const m = c.op.result, root = m.root ? get(raw, m.root) : raw;
    const read = field => get(root, m[field]);
    if (!root || !m.request_no || String(read('request_no')) !== input.request_no) throw fault('机构请求号不匹配', 'PROVIDER_RESULT_MISMATCH');
    for (const field of ['contract_no', 'currency', 'source_merchant_no']) {
      if (!m[field] || String(read(field)) !== String(input[field])) throw fault('机构资金来源不匹配: ' + field, 'PROVIDER_RESULT_MISMATCH');
    }
    const result = { request_no: input.request_no, provider_order_no: read('provider_order_no') == null ? null : String(read('provider_order_no')), lines: [], raw_hash: digest(raw) };
    const list = read('lines');
    if (!Array.isArray(list)) return result; // accepted is not success
    const seen = new Set();
    for (const received of list) {
      const fields = m.line || {}, id = get(received, fields.id);
      const original = input.effects.find(l => l.id === String(id));
      if (!original || seen.has(original.id)) throw fault('机构明细未知或重复', 'PROVIDER_RESULT_MISMATCH');
      seen.add(original.id);
      if (decodeAmount(get(received, fields.amount), c.op.amount_unit) !== original.amount_minor ||
          String(get(received, fields.payee_merchant_no)) !== original.payee_merchant_no ||
          String(get(received, fields.currency)) !== input.currency) throw fault('机构明细金额或收款方不匹配', 'PROVIDER_RESULT_MISMATCH');
      const status = (m.statuses || {})[String(get(received, fields.status))] || 'UNKNOWN';
      if (!['SUCCEEDED', 'FAILED_FINAL', 'PROCESSING', 'UNKNOWN'].includes(status)) throw fault('未知机构状态映射');
      const providerLine = get(received, fields.provider_line_id);
      if (status === 'SUCCEEDED' && !providerLine) throw fault('成功结果缺少机构明细凭证', 'PROVIDER_RESULT_MISMATCH');
      if (status === 'FAILED_FINAL' && !(get(received, fields.no_debit) === true && get(received, fields.reservation_released) === true)) {
        result.lines.push({ id: original.id, status: 'UNKNOWN' }); continue;
      }
      result.lines.push({ id: original.id, status, provider_line_id: providerLine == null ? null : String(providerLine), evidence: received });
    }
    return result;
  }
  async function invoke(order, action) {
    const input = typeof order.canonical_request === 'string' ? JSON.parse(order.canonical_request) : order.canonical_request;
    const c = contract(order.mapping_version, order.operation,{queryOnly:action==='query'});
    if (contractDigest(c) !== order.contract_hash) throw fault('机构契约版本内容已改变', 'PROVIDER_CONTRACT_CHANGED');
    const payload = action === 'submit' ? order.request_payload : order.query_payload;
    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const raw = await payCenter[c.op[action].method](body);
    try { return { normalized: normalize(c, input, raw), raw }; }
    catch(error) { error.provider_raw=raw; throw error; }
  }
  return { contract, build, normalize, invoke };
}
function paymentCollectionContract(config,snapshot) {
 const profile=snapshot?.settlement_profile;if(!profile)return null;
 const collection=profile.collection;
 let contracts=config.settlement_payment_contracts||config.SETTLEMENT_PAYMENT_CONTRACTS||{};
 if(typeof contracts==='string'){try{contracts=JSON.parse(contracts);}catch{throw fault('受控支付契约配置不是合法JSON','PAYMENT_COLLECTION_DISABLED');}}
 const mapping=collection&&contracts[collection.mapping_version];
 if(!collection || !mapping || mapping.enabled!==true || mapping.verified!==true || !mapping.evidence_ref || !collection.contract_no || !collection.source_merchant_no || !collection.provider || !collection.environment || mapping.provider!==collection.provider || mapping.environment!==collection.environment || !Array.isArray(mapping.funding_modes) || !mapping.funding_modes.includes(profile.funding_mode))throw fault('受控收款机构契约尚未核验','PAYMENT_COLLECTION_DISABLED');
 if(!mapping.request_template?.recAndShareInfo || !mapping.request_template?.contractInfo || !mapping.result?.contract_no || !mapping.result?.source_merchant_no || !mapping.result?.control_status || !Array.isArray(mapping.result.controlled_values) || !mapping.result.controlled_values.length)throw fault('受控收款请求或到账证据映射不完整','PAYMENT_COLLECTION_DISABLED');
 return {profile,collection,mapping,hash:digest({collection,mapping})};
}
function buildPaymentCollection(config,snapshot,payment,base) {
 const contract=paymentCollectionContract(config,snapshot);if(!contract)return {body:base,contract_hash:null};
 const {profile,collection,mapping}=contract;
 if(String(payment.merchant_no)!==collection.source_merchant_no)throw fault('订单收款方与受控账户不一致','PAYMENT_COLLECTION_MISMATCH');
 const overrides=template(mapping.request_template,{base,profile,collection,amount_minor:String(payment.amount_minor),amount_yuan:amount(String(payment.amount_minor),'yuan')});
 if(Object.keys(overrides).some(key=>!['recAndShareInfo','contractInfo'].includes(key)) || String(overrides.recAndShareInfo.merchantNo)!==collection.source_merchant_no || String(overrides.contractInfo.contractNo)!==collection.contract_no || overrides.recAndShareInfo.shareOrderMode==null)throw fault('受控支付请求映射与批准账户或合同不符','PAYMENT_COLLECTION_MISMATCH');
 return {body:{...base,...overrides},contract_hash:contract.hash};
}
function verifyPaymentCollection(config,snapshot,payment,data) {
 const contract=paymentCollectionContract(config,snapshot);if(!contract)return;
 const {collection,mapping}=contract,result=mapping.result,root=result.root?get(data,result.root):data,status=get(root,result.control_status);
 if(String(payment.merchant_no)!==collection.source_merchant_no || String(get(root,result.contract_no))!==collection.contract_no || String(get(root,result.source_merchant_no))!==collection.source_merchant_no || status===undefined || !result.controlled_values.some(value=>canonical(value)===canonical(status)))throw fault('支付成功尚缺少合同、原款受控状态或来源凭据','PAYMENT_COLLECTION_EVIDENCE_MISMATCH');
}
module.exports = { createProvider, authorizationHash, canonical, digest, minor, fault, buildPaymentCollection, verifyPaymentCollection, paymentCollectionContract };
