'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const C={
 identity:true,
 escape:value=>String(value??''),
 money:value=>'¥'+(Number(value||0)/100).toFixed(2),
 dateText:value=>String(value||'').slice(0,10),
 button:(label,action,attrs='')=>'<button data-action="'+action+'" '+attrs+'>'+label+'</button>'
};
const window={COMMERCE:C};
const source=readFileSync(path.resolve(__dirname,'../../screens/_commerce-consumer.js'),'utf8');
vm.runInNewContext(source,{window,Intl,Date,Set,Number,String,encodeURIComponent});
const U=window.COMMERCE_CONSUMER;
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const coupon={id:'coupon-1',name:'景点门票',description:'体验券',status:'available',expires_at:'2099-01-01',redeem_channel:'offline'};

assert(!U.couponCard(coupon,0).includes('data-action="code"'));
assert(U.couponCard(coupon,0,{service_date:today}).includes('data-action="code"'));
assert(U.couponCard({...coupon,redeem_channel:'online'},0).includes('data-action="code"'));
const refunded=U.couponCard({...coupon,status:'refunded'},0);
assert(refunded.includes('已退款'));
assert(!refunded.includes('data-action="code"'));

const plan=(id,cityId,cityName)=>({id,kind:'plans',city_id:cityId,city_name:cityName,name:'同名会员',price_minor:1000,valid_days:365,items:[],purchase_enabled:false,demo_purchase_enabled:false,in_stock:false});
const member=(productId,cityId,cityName)=>({product_id:productId,city_id:cityId,city_name:cityName,name:'同名会员',expires_at:'2099-01-01',order_id:'order-'+productId,items:[]});
const city3=plan(11,3,'贵阳'),city4=plan(12,4,'安顺');
const otherCity=U.memberships([city3,city4],{memberships:[member(11,3,'贵阳')],couponCounts:{available:2}},'4');
assert(!otherCity.includes('已开通'));
assert(otherCity.includes('暂时缺货'));
assert(otherCity.includes('2 张可用'));
assert(!otherCity.includes('data-action="checkout"'));

const second=plan(13,3,'贵阳');
const both=U.memberships([city3,second],{memberships:[member(11,3,'贵阳'),member(13,3,'贵阳')],couponCounts:{available:2}},'3');
assert.equal((both.match(/plan-owned-chip">已开通/g)||[]).length,2);
console.log('PASS coupon consumer states, booking code, city membership and purchase flags');
