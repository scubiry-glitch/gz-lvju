'use strict';
const {assert,parse,rows,sqlDate}=require('./primitives.cjs');
// 新旅局预订域的两个品类：channel=minsu（惠居民宿）与 channel=rental（长租，含旅居 tag）。
const CATEGORY_LABELS={minsu:'民宿',rental:'长租'};
function categoryOf(channel){if(channel==null||channel==='')return null;const value=String(channel);return CATEGORY_LABELS[value]?value:value;}
function categoryLabel(category){return category==null?null:CATEGORY_LABELS[category]||String(category);}
function delayDays(conditions){
 const value=parse(conditions).booking_checkout_delay_days;
 assert(Number.isInteger(value)&&value>=0&&value<=3650,'预订结算（民宿/长租）需配置离店后 N 天（0–3650 的整数）',422,'booking_delay_invalid');
 return value;
}
// 账单日（T+N 的账期含义）：缺省 = 逐笔，每笔订单离店 N 天后各自可结算；
// 配置后 = 订单在离店 N 天后，统一等到最近一个账单日随账单批量结算。
function billingDay(conditions){
 const value=parse(conditions).billing_day;
 if(value==null)return null;
 assert(Number.isInteger(value)&&value>=1&&value<=28,'账单日须为每月 1–28 日的整数',422,'booking_billing_day_invalid');
 return value;
}
// 账单日以北京日历为准（1–28 规避月尾长度差异）；返回 ≥ 资格日的最近账单日（YYYY-MM-DD）。
function billDayOnOrAfter(qualifiedYmd,day){
 const qualified=Date.parse(qualifiedYmd+'T00:00:00+08:00');
 assert(Number.isFinite(qualified),'离店资格日期无效',409,'booking_timing_invalid');
 let target=new Date(Date.UTC(new Date(qualified+8*3600000).getUTCFullYear(),new Date(qualified+8*3600000).getUTCMonth(),day));
 if(target.getTime()<qualified)target=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,day));
 return target.toISOString().slice(0,10);
}
function dueAt(ctx,policy){
 if(ctx.biz_type!=='booking')return null;
 const snapshot=parse(ctx.snapshot),checkout=snapshot.booking?.checkout;
 assert(typeof checkout==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(checkout),'预订订单缺少锁定的离店日期',409,'booking_checkout_missing');
 const midnight=Date.parse(checkout+'T00:00:00+08:00');
 assert(Number.isFinite(midnight)&&new Date(midnight+8*3600000).toISOString().slice(0,10)===checkout,'预订离店日期无效',409);
 const days=delayDays(policy?.conditions);
 const qualifiedMidnight=midnight+days*86400000;
 const timing={checkout,booking_checkout_delay_days:days,not_before_at:sqlDate(qualifiedMidnight),timezone:'Asia/Shanghai',source:'BOOKING_CHECKOUT_DATE',policy_id:policy.id,policy_version:Number(policy.version)};
 const day=billingDay(policy?.conditions);
 if(day!=null){
  const qualifiedYmd=new Date(qualifiedMidnight+8*3600000).toISOString().slice(0,10),billDay=billDayOnOrAfter(qualifiedYmd,day);
  timing.qualified_at=timing.not_before_at;timing.billing_day=day;timing.not_before_at=sqlDate(Date.parse(billDay+'T00:00:00+08:00'));timing.source='BOOKING_BILLING_DAY';
 }
 return timing;
}
function assertDue(ctx,policy,at){const timing=dueAt(ctx,policy);if(timing)assert(timing.not_before_at<=sqlDate(at),'尚未到离店后 N 天或账单日的可结算时间',409,'booking_settlement_not_due');return timing;}
async function selectPolicy(c,ctx,item){
 const candidates=await rows(c,"SELECT * FROM commerce_settlement_policies WHERE status='approved' AND biz_type=? AND payment_mode=? AND (party_id IS NULL OR party_id=?) ORDER BY priority DESC",[ctx.biz_type,ctx.payment_mode,ctx.party_id]);
 const amount=BigInt(item.planned_minor??item.payable_minor),matched=candidates.filter(p=>{const v=parse(p.conditions);return (v.min_minor==null||amount>=BigInt(v.min_minor))&&(v.max_minor==null||amount<=BigInt(v.max_minor))&&(!v.line_kind||v.line_kind===item.line_kind);});
 if(!matched.length)return null;
 assert(matched.length===1||Number(matched[0].priority)!==Number(matched[1].priority),'同级结算策略冲突，需处理后授权',409,'policy_conflict');return matched[0];
}
module.exports={delayDays,billingDay,billDayOnOrAfter,dueAt,assertDue,selectPolicy,categoryOf,categoryLabel,CATEGORY_LABELS};
