(function(){'use strict';
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=v=>'¥'+(Number(v)/100).toFixed(2);
let state=null,selected='',quote=null,busy=false,wrongAccount=false;
async function api(path,method='GET',body,key){const token=BZF_CONSOLE.token();const headers={'Authorization':'Bearer '+token};if(method!=='GET'){headers['Content-Type']='application/json';headers['Idempotency-Key']=key||crypto.randomUUID();}const r=await fetch('/api/commerce/v1'+path,{method,headers,body:body?JSON.stringify(body):undefined});const json=await r.json();if(!r.ok){const error=Error(json.error||'请求失败');error.status=r.status;throw error;}return json.data;}
function status(message='',error=false){$('#status').textContent=message;$('#status').classList.toggle('error',error);}
function setBusy(value){busy=value;document.querySelectorAll('#flow button').forEach(b=>b.disabled=value);}
async function refresh(){state=await api('/demo-life/config');$('#gate-text').textContent='已验证 admin 演示账号';$('#login').hidden=true;$('#flow').hidden=false;
 $('#product').innerHTML='<div><b>'+esc(state.product.title)+'</b><small>贵阳 · 保洁 · 测试商品，不提供实际服务</small></div><span class="money">'+money(state.product.price_minor)+'</span>';
 $('#voucher').innerHTML='<h2>'+esc(state.voucher.name)+'</h2><p>面值 '+money(state.voucher.face_minor)+'，仅适用本页的保洁测试商品。</p><div class="actions"><button class="button" id="claim" type="button">领取一张测试券</button><span>当前可用 '+state.coupons.length+' 张</span></div>';
 $('#quote').innerHTML=state.coupons.length?'<h2>选择可用券</h2><div class="coupon-list">'+state.coupons.map(c=>'<label class="coupon-choice"><input type="radio" name="coupon" value="'+esc(c.id)+'" '+(selected===c.id?'checked':'')+'><span>'+money(state.voucher.face_minor)+' 抵用券 · '+esc(c.id.slice(0,8))+' · 有效期至 '+esc(String(c.expires_at).slice(0,10))+'</span></label>').join('')+'</div><button class="button secondary" id="price" type="button">计算抵用</button>':'<p>先领取一张测试券，再查看抵用金额。</p>';
 $('#order').innerHTML=quote&&state.coupons.some(c=>c.id===quote.coupon_id)?'<div class="line"><span>服务原价</span><strong>'+money(quote.listed_minor)+'</strong></div><div class="line discount"><span>本次抵用</span><strong>−'+money(quote.coupon_minor)+'</strong></div><div class="line total"><span>模拟差额</span><strong>'+money(quote.simulated_cash_minor)+'</strong></div><div class="note">'+esc(quote.notice)+'</div><label><input id="ack" type="checkbox"> 我已知悉本次为无资金演示</label><div class="actions"><button class="button" id="submit" type="button">确认演示下单</button></div>':'<p>核对抵用金额后，可在这里提交演示订单。</p>';
 $('#history').innerHTML=state.orders.length?state.orders.map(o=>'<div class="history-row"><b>已生成演示订单</b> · '+esc(o.id.slice(0,8))+'<br>原价 '+money(o.listed_minor)+' − 抵用 '+money(o.coupon_minor)+' = 模拟差额 '+money(o.simulated_cash_minor)+'<br><small>'+esc(String(o.created_at).slice(0,19))+' · 无支付、无真实履约</small></div>').join(''):'<p>暂无演示订单。</p>';
}
async function start(){try{wrongAccount=false;await api('/me');await refresh();status('');}catch(e){wrongAccount=e.status===403;$('#gate-text').textContent=e.message;$('#login').textContent=wrongAccount?'切换到 admin':'使用 admin 登录';$('#login').hidden=![401,403].includes(e.status);$('#flow').hidden=true;}}
$('#login').onclick=async()=>{try{if(wrongAccount)BZF_CONSOLE.setToken('');await BZF_CONSOLE.requireLogin({hint:'请使用 admin 演示账号登录'});await start();}catch(e){status(e.message,true)}};
document.addEventListener('change',e=>{if(e.target.name==='coupon'){selected=e.target.value;quote=null;refresh().catch(err=>status(err.message));}});
document.addEventListener('click',async e=>{const button=e.target.closest('button');if(!button||busy)return;try{
 if(button.id==='claim'){setBusy(true);await api('/demo-orders','POST',{kind:'skus',product_id:state.voucher.id,version:state.voucher.version,demo_ack:true});quote=null;await refresh();status('测试券已到账，请选择券查看抵用金额。');}
 if(button.id==='price'){selected=document.querySelector('input[name=coupon]:checked')?.value||'';if(!selected)throw Error('请先选择一张可用券');setBusy(true);quote=await api('/demo-life/quote?coupon_id='+encodeURIComponent(selected));await refresh();status('已计算抵用金额。');}
 if(button.id==='submit'){if(!$('#ack')?.checked)throw Error('请先确认无资金演示说明');setBusy(true);await api('/demo-life/orders','POST',{coupon_id:quote.coupon_id,demo_ack:true});quote=null;selected='';await refresh();status('演示订单已生成，券已标记为已使用；没有实际扣款。');}
 }catch(err){status(err.message,true)}finally{setBusy(false)}});
start();
})();
