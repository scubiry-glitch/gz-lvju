(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>'¥'+Number(n||0).toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:2});
  const scenes={
    beijing:{name:'北京 · 卖旧买新',city:'北京',reference:'沈阳',persona:'lin',channel:'银行自有渠道',need:'旧房出售净得与回款时间未定，先核事实并比较资金时间轴；确认搬迁服务需求时再给券。',rights:[
      {key:'move',name:'搬家服务券',category:'moving',query:'居民搬家 · 同城',why:'完成换房方案后，客户确认实际搬家日期再领；避免只因浏览新房就发券。',unit:150,selected:true},
      {key:'water',name:'漏水排查 / 水管维修券',category:'repair',query:'水管维修 · 应急',why:'新旧房交接时提供一次故障排查；保单不能由维修券替代。',unit:90,selected:true},
      {key:'handover',name:'入住前深度保洁券',category:'cleaning',query:'深度清洁 · 4小时',why:'新房交接且确有入住日期时可选；需核验清洁面积与施工后的适用条件。',unit:120,selected:false},
      {key:'insurance',name:'漏水保险咨询入口',external:true,why:'保险产品、保障责任和承保资格需由保险机构独立核验；先放入口，不创建保险券。',unit:0,selected:false}
    ],note:'当前北京目录为空。沈阳已有同类搬家、维修演示商品，仅能证明券平台有该品类流程；北京投放还须本地商家、报价、库存和服务规则。消费贷不与领券绑定。'},
    suzhou:{name:'苏州 · 高端省心租',city:'苏州',reference:'沈阳',persona:'suzhou',channel:'贝壳居住通路',need:'先核出租、托管和维修责任，再交付净租金方案；权益帮助业主处理真实的出租管理问题。',rights:[
      {key:'clean',name:'退租 / 入租深度保洁券',category:'cleaning',query:'深度清洁 · 4小时',why:'在房屋交接或托管签约后的实际清洁节点领取，不以购买理财为前提。',unit:120,selected:true},
      {key:'repair',name:'家电检修服务券',category:'repair',query:'家电维修 · 上门',why:'空置期或租客报修时使用；服务范围和超出基础工序的费用需先说明。',unit:90,selected:true},
      {key:'visit',name:'空置巡检服务权益',proposal:true,why:'建议新增可预约的上门巡检：照片回执、异常报修和业主确认，作为省心租场景的核心权益。',unit:80,selected:false}
    ],note:'当前苏州目录为空。沈阳已有保洁与维修演示券；空置巡检是新提案，需运营商定义工序、频次、价格与核销证据。理财咨询留在银行自营流程。'},
    travel:{name:'上海房东 · 贵阳试住',city:'贵阳',reference:'贵阳',persona:'travel',channel:'贝壳居住通路',need:'上海原房出租、出售或先试住未定；先交付现金流和目的地住房核验清单，再给异地试住权益。',rights:[
      {key:'hotel',name:'酒店通兑券',category:'hotel_exchange',tier:'t120',why:'先住一晚验证目的地生活。现有演示券可在同档试点名单酒店中按券页规则选店、预约与核销。',unit:120,selected:true},
      {key:'scenic',name:'城市漫游门票券',category:'scenic_ticket',query:'城市漫游',why:'客户明确有短期探索需求时可搭配，不强制打包。',unit:55,selected:false},
      {key:'dining',name:'本地餐饮代金券',category:'dining',query:'本地风味',why:'首日抵达的生活体验，可作为酒店券之外的小额权益。',unit:65,selected:false},
      {key:'area',name:'目的地居住条件核验服务',proposal:true,why:'建议新增实地看住处服务：核验交通、租住条件和无障碍需求，形成可追溯记录；需先定义服务商和工序。',unit:80,selected:false}
    ],note:'贵阳目录已有酒店通兑、门票和餐饮演示券；上海是客户来源地，贵阳是本轮可演练目的地。此前昆明仅是旅程假设，当前名单未核到昆明试点酒店，不能承诺昆明可用。旅居预付与实际服务费用的多退少补另走订单结算，不改变固定一晚酒店券面值。'}
  };
  let active='beijing',catalog={};
  const selections={};for(const [k,s] of Object.entries(scenes))selections[k]=Object.fromEntries(s.rights.map(r=>[r.key,{checked:r.selected,unit:r.unit,tier:r.tier||''}]));
  function match(right,items){return (items||[]).find(p=>p.kind==='skus'&&p.category_id===right.category&&(!right.tier||p.exchange_tier===right.tier)&&(!right.query||p.name.includes(right.query)));}
  function productCard(s,right){
    const chosen=selections[active][right.key];
    const selectedRight={...right,tier:chosen.tier||right.tier};
    const product=right.external||right.proposal?null:match(selectedRight,catalog[s.city]);
    const example=right.external||right.proposal?null:match(selectedRight,catalog[s.reference]);
    const usable=!!product&&product.is_demo&&product.in_stock&&product.demo_purchase_enabled;
    const state=right.external?'外部机构':right.proposal?'待定义工序':usable?'可演练':'目标城市待上架';
    const detail=right.external?'保险机构的咨询入口，不代表可领保险或已承保。':right.proposal?'新服务提案，尚无可核销商品。':product?'目标城市目录：'+product.name+'；展示价 '+money(product.price_minor/100)+'，演示购买零支付。':example?'已有'+s.reference+'同类演示商品：'+example.name+'；不能跨城当作本地券发放。':'目前目录没有对应商品。';
    const linkProduct=usable?product:example;
    const link=linkProduct?'<a href="juzhu-voucher.html?kind=skus&amp;id='+Number(linkProduct.id)+'&amp;city='+encodeURIComponent(usable?s.city:s.reference)+'" target="_blank" rel="noopener">'+(usable?'打开当前券':'查看异地样例')+' ↗</a>':'';
    const tiers=right.category==='hotel_exchange'?'<label class="tier-row">酒店通兑档位<select data-tier="'+esc(right.key)+'">'+[80,100,120,160,180,200].map(n=>'<option value="t'+n+'" '+(chosen.tier==='t'+n?'selected':'')+'>'+n+' 元档</option>').join('')+'</select></label>':'';
    return '<article class="product"><div class="product-head"><div><small>'+esc(right.category?right.category.toUpperCase():'EXTERNAL / PROPOSAL')+'</small><h3>'+esc(right.name)+'</h3></div><span class="badge '+(usable?'ready':'pending')+'">'+esc(state)+'</span></div><p>'+esc(right.why)+'</p><div class="ref"><b>'+esc(usable?'券平台已核到演示商品':'供给状态')+'</b>'+esc(detail)+'</div>'+tiers+'<div class="product-controls"><label><input type="checkbox" data-right="'+esc(right.key)+'" '+(chosen.checked?'checked':'')+'> 纳入方案</label>'+link+'</div><label class="unit-row">策划假设 · 单次核销成本 ¥<input type="number" min="0" max="100000" step="0.01" data-cost="'+esc(right.key)+'" value="'+esc(chosen.unit)+'"></label></article>';
  }
  function refreshBudget(){
    const s=scenes[active],selected=s.rights.filter(r=>selections[active][r.key].checked),reach=Number($('reach').value),issue=Number($('issue-rate').value),redeem=Number($('redeem-rate').value),cap=Number($('budget-cap').value);
    const valid=[reach,issue,redeem,cap].every(Number.isFinite)&&reach>=1&&reach<=1e6&&issue>=0&&issue<=100&&redeem>=0&&redeem<=100&&cap>=0;
    const units=selected.reduce((n,r)=>n+Number(selections[active][r.key].unit||0),0),count=valid?reach*issue/100*redeem/100:0,expected=units*count;
    const over=valid&&expected>cap;
    $('calculation').className='calculation'+(over?' warn':'');
    $('calculation').innerHTML=valid?'<b>预计核销约 '+count.toFixed(1)+' 人次 · 每人所选权益假设成本 '+money(units)+'</b><br><strong>'+money(expected)+'</strong> 预计权益成本 / '+money(cap)+' 预算上限<br><small>'+(over?'超出上限，降低发券量、核销成本或调整组合。':'在假设预算内；还需加上渠道、服务与平台成本。')+'</small>':'请输入有效的触达人数、比例和预算上限。';
    const noSupply=selected.filter(r=>{if(r.external||r.proposal)return false;const p=match({...r,tier:selections[active][r.key].tier||r.tier},catalog[s.city]);return !p||!p.is_demo||!p.in_stock||!p.demo_purchase_enabled;});
    const external=selected.filter(r=>r.external||r.proposal);
    $('release-list').innerHTML='<li><b>城市供给：</b>'+esc(noSupply.length?noSupply.map(r=>r.name).join('、')+'尚未在'+s.city+'上架。':'所选已有券均在'+s.city+'演示目录中；仍须核实真实供给。')+'</li>'+
      '<li><b>外部权益：</b>'+esc(external.length?external.map(r=>r.name).join('、')+'需单独确认机构或服务商。':'无待外部承接的所选权益。')+'</li>'+
      '<li><b>预算：</b>'+esc(valid?(over?'当前策划假设超出预算。':'当前策划假设未超预算。'):'输入尚未完整。')+'</li>'+
      '<li><b>投放：</b>确认商品版本、适用城市、库存、授权触达和核销回执后发布。</li>';
  }
  function render(){
    const s=scenes[active];document.querySelectorAll('[data-scene]').forEach(b=>{b.setAttribute('aria-selected',b.dataset.scene===active?'true':'false');b.tabIndex=b.dataset.scene===active?0:-1;});
    $('journey-head').innerHTML='<div><strong>'+esc(s.name)+'</strong><p>'+esc(s.need)+'</p></div><em>'+esc(s.channel)+' · 服务城市 '+esc(s.city)+'</em>';
    $('product-grid').innerHTML=s.rights.map(r=>productCard(s,r)).join('');
    $('supply-note').textContent=s.note;
    $('supply-status').textContent=catalog[s.city]?'已核对 '+s.city+' 公开目录 · '+catalog[s.city].length+' 项商品':'目录暂不可核验，所有供给按待确认处理';
    $('marketing-link').href='https://marketing.renos.life/marketing?persona='+encodeURIComponent(s.persona)+'&fresh=1';
    refreshBudget();
  }
  document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>{active=b.dataset.scene;render();}));
  $('product-grid').addEventListener('change',e=>{const right=e.target.dataset.right,tier=e.target.dataset.tier;if(right){selections[active][right].checked=e.target.checked;refreshBudget();}if(tier){selections[active][tier].tier=e.target.value;selections[active][tier].unit=Number(e.target.value.slice(1));render();}});
  $('product-grid').addEventListener('input',e=>{const key=e.target.dataset.cost;if(key){const n=Number(e.target.value);if(Number.isFinite(n)&&n>=0&&n<=100000)selections[active][key].unit=n;refreshBudget();}});
  ['reach','issue-rate','redeem-rate','budget-cap'].forEach(id=>$(id).addEventListener('input',refreshBudget));
  render();
  Promise.all(['北京','苏州','贵阳','沈阳'].map(async city=>{try{const res=await fetch('/api/commerce/v1/catalog?city='+encodeURIComponent(city));if(!res.ok)throw Error('HTTP '+res.status);const data=await res.json();catalog[city]=Array.isArray(data.data)?data.data:[];}catch(e){catalog[city]=null;}})).then(render);
})();
