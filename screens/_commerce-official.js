(function(){
'use strict';
const $=s=>document.querySelector(s),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={draft:'草稿',submitted:'待复核',approved:'待发布',published:'已发布',rejected:'已驳回',archived:'已停用',reserved:'待付款',expired:'已失效',fulfilled:'已发放',available:'可使用',frozen:'售后冻结',redeemed:'已核销',booked:'已预约',cancelled:'已取消',rescheduled:'已改期',completed:'已完成',open:'待受理',processing:'处理中',awaiting_provider:'待退款通道',closed:'已结单',refund:'退款申请',help:'服务协助'};
const money=v=>v===null||v===undefined?'待确认':'¥'+(Number(v)/100).toFixed(2),label=v=>labels[v]||v||'—';
let identity=null;
async function api(url,method='GET',body,options={}){const headers={'Authorization':'Bearer '+(window.BZF_CONSOLE?.token()||'')};if(method!=='GET'){headers['Content-Type']='application/json';headers['Idempotency-Key']=options.idempotencyKey||crypto.randomUUID();}const response=await fetch('/api/commerce/v1'+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok){const error=Error(result.error||'暂时无法完成，请稍后重试');error.status=response.status;throw error;}return result.data;}
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
window.COMMERCE={api,escape,label,money,labels,status,empty,button,badge,can,login,dialog,dateText,get identity(){return identity;}};
$('#account-login')?.addEventListener('click',()=>login().then(()=>window.dispatchEvent(new Event('commerce-login'))).catch(e=>status(e.message,true)));
$('#account-logout')?.addEventListener('click',()=>BZF_CONSOLE.logout());
window.COMMERCE.ready=(async()=>{if(BZF_CONSOLE.token()){try{identity=await api('/me');$('#account-name').textContent=identity.account.display_name||'已登录';}catch(e){if(e.status===401)BZF_CONSOLE.setToken('');}}return identity;})();
})();
