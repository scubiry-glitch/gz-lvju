(function(){
'use strict';
let version=0;
async function render(){const current=++version;try{
 const city=window.BZF_JZ?.regionCity()||new URLSearchParams(location.search).get('city')||'';
 const response=await fetch('/api/commerce/v1/catalog'+(city?'?city='+encodeURIComponent(city):''));if(!response.ok)return;
 const catalog=await response.json();if(current!==version)return;
 const section=document.getElementById('jzSecCoupon'),rail=document.getElementById('jzCoupon');if(!section||!rail)return;
 const href=p=>{const q=new URLSearchParams();if(city)q.set('city',city);if(p?.id)q.set('product',p.kind+'-'+p.id);return 'juzhu-commerce.html'+(q.size?'?'+q:'');};
 section.querySelector('h2').textContent='生活权益';const more=section.querySelector('.more');more.textContent='';const link=document.createElement('a');link.href=href();link.textContent='单品券 / 券包 / 会员 ›';more.append(link);rail.textContent='';
 const products=catalog.data||[];const picks=[...products.filter(p=>p.kind==='skus').slice(0,3),...products.filter(p=>p.kind==='packages').slice(0,2),...products.filter(p=>p.kind==='plans').slice(0,1)];
 const entries=picks.length?picks:[{name:'精选生活权益',description:'好服务正在准备中',price_minor:null}];
 entries.forEach((p,i)=>{const a=document.createElement('a');a.className='ticket '+(i%2?'navy':'teal');a.href=href(p);const amount=document.createElement('div');amount.className='amt';const b=document.createElement('b');b.textContent=p.price_minor===null?'生活权益':(p.price_minor/100).toFixed(0)+'元';const title=document.createElement('span');title.textContent=p.name;amount.append(b,title);const rule=document.createElement('div');rule.className='rule';rule.textContent=p.is_demo?'演示价 · 无实际扣款':p.price_minor===null?'服务审核完成后开放展示':p.kind==='plans'?'会员权益 · 赠送生活券包':p.kind==='skus'?'单品服务券 · 单独选购':'精选服务组合';const claim=document.createElement('div');claim.className='claim';const span=document.createElement('span');span.textContent=city||'新居住频道';const go=document.createElement('i');go.textContent='查看';claim.append(span,go);a.append(amount,rule,claim);rail.append(a);});
 }catch{}
}
render();window.BZF_JZ?.onCityChange(render);
})();
