'use strict';
// Shared server-authoritative form catalogue. Clients receive labels, never validation authority.
const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, required: true, ...extra });
const definitions = {
  merchants: { label: '商户管理', merchant: true, fields: [f('name','商户名称'),f('vendor_id','关联商家','reference',{source:'vendors'}),f('city_id','经营城市','reference',{source:'cities'}),f('contract_ref','合同编号'),f('contact','业务联系人'),f('phone','联系电话'),f('description','服务介绍','textarea')] },
  stores: { label: '门店管理', merchant: true, fields: [f('name','门店名称'),f('merchant_id','所属商户','reference',{ source:'merchants' }),f('city_id','城市','reference',{source:'cities'}),f('address','门店地址'),f('phone','服务电话'),f('capacity','每日预约名额','number'),f('lead_hours','提前预约小时','number',{min:0}),f('description','营业及服务说明','textarea')] },
  staff: { label: '核销人员', merchant: true, fields: [f('name','人员姓名'),f('merchant_id','所属商户','reference',{source:'merchants'}),f('store_id','所属门店','reference',{source:'stores'}),f('account_id','核销账号','reference',{source:'accounts'})] },
  skus: { label: '券商品', merchant: true, fields: [f('name','服务名称'),f('merchant_id','供应商户','reference',{source:'merchants'}),f('store_id','服务门店','reference',{source:'stores'}),f('supply_minor','供货价（元）','money'),f('retail_minor','零售价（元）','money'),f('valid_days','有效天数','number'),f('description','服务内容','textarea'),f('conditions','使用条件及除外责任','textarea')] },
  rules: { label: '报价与分配规则', fields: [f('name','规则名称'),f('merchant_id','适用商户','reference',{source:'merchants'}),f('beike_bps','贝壳比例（万分比）','number',{min:0,max:10000}),f('channel_bps','渠道占贝壳佣金（万分比）','number',{min:0,max:10000}),f('floor_bps','最低佣金率（万分比）','number',{min:0,max:10000}),f('description','规则及审批依据','textarea')] },
  packages: { label: '券包配置', fields: [f('name','券包名称'),f('city_id','适用城市','reference',{source:'cities'}),f('price_minor','券包售价（元）','money'),f('description','券包介绍','textarea'),f('items','券包明细','items')] },
  plans: { label: '会员方案', fields: [f('name','会员名称'),f('city_id','适用城市','reference',{source:'cities'}),f('package_id','赠送券包','reference',{source:'packages'}),f('price_minor','会员售价（元）','money'),f('valid_days','会员有效天数','number'),f('description','会员权益说明','textarea')] },
};
const kinds = Object.keys(definitions);
class Fault extends Error { constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; } }
const assert = (ok, message, status=422, code) => { if (!ok) throw new Fault(status,message,code); };
function validate(kind, input) {
  const def=definitions[kind]; assert(def,'资源不存在',404); const out={};
  for(const field of def.fields) {
    const value=input[field.key]; assert(value!==undefined && value!==null && value!=='',`请填写${field.label}`);
    if(['number','money','reference'].includes(field.type)) { assert(typeof value==='number' && Number.isSafeInteger(value) && value>=(field.min??1) && value<=(field.max??100000000),`${field.label}数值不合法`); out[field.key]=value; }
    else if(field.type==='items') { assert(Array.isArray(value)&&value.length>0&&value.length<=30,'券包应包含1至30项服务'); out.items=value.map(v=>{const item={}; for(const key of ['sku_id','rule_id','quantity','allocation_minor']) { assert(Number.isSafeInteger(v[key])&&v[key]>0&&v[key]<=100000000,'券包明细需填写有效的商品、规则、数量与逐券分摊金额'); item[key]=v[key]; } assert(item.quantity<=100,'单项数量不能超过100'); return item; }); assert(new Set(out.items.map(v=>v.sku_id)).size===out.items.length,'同一商品请合并数量'); }
    else { assert(typeof value==='string' && value.trim().length>0 && value.length<=(field.type==='textarea'?4000:255),`${field.label}长度不合法`); out[field.key]=value.trim(); }
  }
  if(kind==='skus') { assert(out.retail_minor>=out.supply_minor,'零售价不能低于供货价'); assert(out.valid_days<=3660,'有效期过长'); }
  if(kind==='packages') assert(out.items.reduce((s,v)=>s+v.quantity*v.allocation_minor,0)===out.price_minor,'逐券分摊金额合计必须等于券包售价');
  if(kind==='rules') assert(out.beike_bps>=out.floor_bps,'佣金比例低于最低标准');
  return out;
}
module.exports={definitions,kinds,Fault,assert,validate};
