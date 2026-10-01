(function(){
'use strict';
const $=s=>document.querySelector(s),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={draft:'草稿',submitted:'待复核',approved:'待发布',published:'已发布',rejected:'已驳回',archived:'已停用',reserved:'待付款',paid_pending_fulfillment:'已付款，权益发放中',closing:'订单关闭中',partially_refunded:'部分已退款',refunded:'已退款',expired:'已失效',fulfilled:'已发放',available:'可使用',frozen:'售后冻结',redeemed:'已核销',booked:'已预约',cancelled:'已取消',rescheduled:'已改期',completed:'已完成',open:'待受理',processing:'处理中',awaiting_provider:'待退款通道',closed:'已结单',refund:'退款申请',help:'服务协助'};
const money=v=>v===null||v===undefined?'待确认':'¥'+(Number(v)/100).toFixed(2),label=v=>labels[v]||v||'—';
let identity=null;
async function api(url,method='GET',body,options={}){const headers={...(window.BZF_BEIKE_LOGIN?.authHeaders()||{}),'Authorization':'Bearer '+(window.BZF_CONSOLE?.token()||'')};if(method!=='GET'){headers['Content-Type']='application/json';headers['Idempotency-Key']=options.idempotencyKey||crypto.randomUUID();}const response=await fetch('/api/commerce/v1'+url,{method,credentials:'same-origin',headers,body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok){const error=Error(result.error||'暂时无法完成，请稍后重试');error.status=response.status;throw error;}return result.data;}
let toastTimer,statusMessageVersion=0;
function status(text,error=false){
 text=String(text??'');if(text)statusMessageVersion++;
 const el=$('#commerce-status');if(el){el.textContent=text;el.classList.toggle('error',error);}
 let toast=$('#commerce-toast');clearTimeout(toastTimer);
 // Management and promoter pages retain their existing status region; only the
 // consumer stylesheet supplies the fixed toast used above the bottom navigation.
 if(!text||!document.body.classList.contains('commerce-consumer')){toast?.remove();return;}
 if(!toast){toast=document.createElement('div');toast.id='commerce-toast';toast.className='commerce-toast';if(el)toast.setAttribute('aria-hidden','true');else{toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');}document.body.append(toast);}
 toast.textContent=text;toast.classList.toggle('is-error',error);toastTimer=setTimeout(()=>toast.remove(),error?5200:2800);
}
function empty(title,description,action=''){return '<section class="commerce-card commerce-empty wide"><div class="empty-mark" aria-hidden="true">◇</div><h3>'+escape(title)+'</h3><p>'+escape(description)+'</p>'+action+'</section>';}
function button(text,action,extra='',primary=false){return '<button class="btn '+(primary?'pri':'')+'" data-action="'+action+'" '+extra+'>'+escape(text)+'</button>';}
function badge(state){return '<span class="commerce-badge state-'+escape(state)+'">'+escape(label(state))+'</span>';}
function can(perm){return identity&&(identity.permissions.includes('*')||identity.permissions.includes(perm));}
async function login(){await BZF_CONSOLE.requireLogin({hint:'使用新居住账号登录'});identity=await api('/me');$('#account-name').textContent=identity.account.display_name||'已登录';if(window.BZF_NAV?.refresh)BZF_NAV.refresh();}
async function refreshIdentity(){identity=await api('/me');if($('#account-name'))$('#account-name').textContent=identity.account.display_name||'已登录';return identity;}
function dialog(title,content,onSubmit){
 let d=$('#commerce-dialog');if(d)d.remove();d=document.createElement('dialog');d.id='commerce-dialog';d.className='commerce-dialog';d.setAttribute('aria-labelledby','dialog-title');d.innerHTML='<form><header><h2 id="dialog-title">'+escape(title)+'</h2><button type="button" class="dialog-close" aria-label="关闭">×</button></header><div class="dialog-body">'+content+'</div><p class="dialog-error" role="alert" tabindex="-1"></p><footer><button class="btn" type="button" data-close>关闭</button>'+(onSubmit?'<button class="btn pri" type="submit">确认保存</button>':'')+'</footer></form>';document.body.append(d);d.querySelector('.dialog-close').onclick=d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());
 const form=d.querySelector('form'),closeButtons=[...d.querySelectorAll('.dialog-close,[data-close]')];let submitting=false;
 d.addEventListener('cancel',event=>{if(submitting)event.preventDefault();});
 if(onSubmit)form.onsubmit=async event=>{
  event.preventDefault();if(submitting)return;submitting=true;
  const b=d.querySelector('[type=submit]'),error=d.querySelector('.dialog-error'),originalText=b.textContent,messageVersion=statusMessageVersion;
  b.disabled=true;closeButtons.forEach(button=>button.disabled=true);b.textContent='提交中…';form.setAttribute('aria-busy','true');error.textContent='';
  try{
   const result=await onSubmit(new FormData(form),d);d.close();
   // Callers can return a business-specific confirmation or set status themselves.
   if(result&&typeof result.successMessage==='string')status(result.successMessage);
   else if(statusMessageVersion===messageVersion)status('操作成功');
  }catch(e){error.textContent=e?.message||'暂时无法完成，请稍后重试';error.focus();}
  finally{submitting=false;b.disabled=false;closeButtons.forEach(button=>button.disabled=false);b.textContent=originalText;form.removeAttribute('aria-busy');}
 };
 else form.onsubmit=e=>e.preventDefault();d.showModal();return d;
}
const dateText=v=>v?String(v).slice(0,10):'—';
// 品类识别词汇表（C 端/推广端共用）：category→线性图标 path；浅底/深字色板见 _commerce.css 的 .cat-*。
const CAT_PATHS={cleaning:'<path d="m12 4 1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6Z"/><path d="m18.5 15.5.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z"/>',repair:'<path d="M14.7 6.3a4.2 4.2 0 0 0-5.5 5.5L4 17v3h3l5.2-5.2a4.2 4.2 0 0 0 5.5-5.5L15 12l-3-3Z"/>',moving:'<rect x="2" y="7" width="12" height="9" rx="1"/><path d="M14 10h3.5L21 13.5V16h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',nanny:'<path d="M12 21S2 15 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z"/>',telecom:'<path d="M6 3h4l1.5 4.5L9 9.5a12.5 12.5 0 0 0 5.5 5.5l2-2.5L21 14v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z"/>',insurance:'<path d="M12 3 5 6v5c0 5 3.1 8.5 7 10 3.9-1.5 7-5 7-10V6Z"/><path d="m9 11.5 2 2 4-4.5"/>',consumer_finance:'<circle cx="9" cy="10" r="5.5"/><path d="M13.2 5.5a5.5 5.5 0 1 1-3 10.3"/><path d="M7 10h4M9 8v4"/>',health_care:'<path d="M12 21S2 15 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z"/>',home_maintain:'<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6.5A2.5 2.5 0 0 1 11.5 4h1A2.5 2.5 0 0 1 15 6.5V8M3 13h18"/>',asset:'<path d="M4 21h16M5 10h14M12 3l8 5H4Z"/><path d="M7.5 10v8M12 10v8M16.5 10v8"/>',recycle:'<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9"/><path d="M20 4.5V9h-4.5"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 15"/><path d="M4 19.5V15h4.5"/>',community:'<circle cx="9" cy="8" r="3.5"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M17 14.6a5.5 5.5 0 0 1 3.5 5.4"/>',hotel_exchange:'<path d="M3 18V7"/><path d="M3 12h18v6"/><path d="M21 18v-6a3 3 0 0 0-3-3h-7.5v3"/><circle cx="6.8" cy="10.5" r="1.5"/>',scenic_ticket:'<path d="m3 19 6-11 4 7 2.5-4L21 19Z"/><circle cx="17.5" cy="6" r="1.5"/>',dining:'<path d="M5 4h12v6a6 6 0 0 1-12 0Z"/><path d="M17 5.5h2a2 2 0 0 1 0 5h-2"/><path d="M7 20h8"/>',online_service:'<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17.5V21"/>',packages:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Z"/><path d="M15 5v3m0 3v2m0 3v3"/>',plans:'<path d="m3 7 4 3 5-6 5 6 4-3-3 12H6Z"/><path d="M8 15h8"/>'};
// 券包/会员无品类字段走金调兜底；酒店通兑按通兑品类出图。
const catKeyOf=p=>p.exchange_tier?'hotel_exchange':(p.category_id&&CAT_PATHS[p.category_id]?p.category_id:p.kind==='packages'?'packages':p.kind==='plans'?'plans':'');
const catSvg=p=>{const k=catKeyOf(p),d=CAT_PATHS[k]||CAT_PATHS.packages;return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';};
window.COMMERCE={api,escape,label,money,labels,status,empty,button,badge,can,login,refreshIdentity,dialog,dateText,catKeyOf,catSvg,get identity(){return identity;}};
$('#account-login')?.addEventListener('click',()=>login().then(()=>window.dispatchEvent(new Event('commerce-login'))).catch(e=>status(e.message,true)));
$('#account-logout')?.addEventListener('click',()=>BZF_CONSOLE.logout());
window.COMMERCE.ready=(async()=>{try{await refreshIdentity();}catch(e){if(e.status===401)BZF_CONSOLE.setToken('');}return identity;})();
})();
