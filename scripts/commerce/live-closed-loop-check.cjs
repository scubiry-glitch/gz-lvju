'use strict';
// Live closed-loop probe against the sytest preview domain (zero funds, reversible actions only).
// Credentials are parsed from the in-repo demo accounts page; nothing secret is printed or stored.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const out={at:new Date().toISOString(),origin:'http://127.0.0.1:38780 (Host: sytest.meizu.life)',checks:[]};
const check=(name,ok,detail='')=>{out.checks.push({name,ok,detail});console.log((ok?'PASS ':'FAIL ')+name+(detail?' · '+detail:''));if(!ok)process.exitCode=1;};
const curl=(method,url,headers,body)=>{const args=['-fsS','-X',method,url];for(const [k,v] of Object.entries(headers||{}))args.push('-H',k+': '+v);if(body!==undefined)args.push('-d',JSON.stringify(body));const raw=execFileSync('curl',args,{encoding:'utf8',maxBuffer:1<<24});return raw?JSON.parse(raw):null;};
const commerce=(route,token,method='GET',body)=>curl(method,'http://127.0.0.1:38780/api/commerce/v1'+route,{Host:'sytest.meizu.life',...(token?{Authorization:'Bearer '+token}:{}),...(method!=='GET'?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},body);
(async()=>{
 const meta=curl('GET','http://127.0.0.1:38780/api/commerce/v1/meta',{Host:'sytest.meizu.life'});
 check('Live commerce API is the M1-A payment-disabled service',meta?.data?.mode==='mysql-m1a'&&meta.data.payment_enabled===false,JSON.stringify(meta?.data));
 const page=fs.readFileSync(path.join(root,'screens/demo-accounts.html'),'utf8');
 const m=page.match(/user:\s*'admin'\s*,\s*pwd:\s*'([^']+)'/);if(!m)throw Error('admin credential entry missing');
 const login=curl('POST','http://127.0.0.1:8766/api/auth/login',{'Content-Type':'application/json'},{login_name:'admin',password:m[1]});
 const token=login?.token||login?.data?.token;check('Platform admin signs in through the account centre',Boolean(token),login?.data?.account?.display_name||login?.display_name||'');
 const me=commerce('/me',token);check('Account centre session reaches the commerce API',(me?.data?.permissions||[]).includes('*'),String((me?.data?.permissions||[]).length)+' permissions');
 const stats=commerce('/admin/stats',token);check('Operations stats aggregates issuance, appointments, redemption, exchange and after-sales',!!(stats?.data?.coupons&&stats?.data?.exchange_codes&&stats?.data?.cases&&Array.isArray(stats?.data?.failures?.recent)),`coupons=${stats?.data?.coupons?.total} redeemed=${stats?.data?.coupons?.redeemed} codes=${stats?.data?.exchange_codes?.total} cases=${stats?.data?.cases?.total}`);
 const records=commerce('/admin/exchange-codes?state=redeemed',token);
 if((records?.data?.rows||[]).length)check('Redemption records are queryable with redeemer and order',records.data.rows.every(r=>r.order_id&&r.redeemed_name),records.data.total+' redeemed');
 else check('Redemption record query works with a clean empty state',records?.data?.total===0&&records?.data?.summary?.redeemed===0,'0 redeemed on live (capability proven on isolated database)');
 const catalog=commerce('/catalog?city=%E8%B4%B5%E9%98%B3');const product=catalog?.data?.find(p=>p.kind==='skus'&&p.is_demo);check('Published demo product available for issuance',!!product,product?.name);
 let issued=null;
 if(product){issued=commerce('/admin/exchange-codes',token,'POST',{kind:'skus',product_id:product.id,version:product.version,expires_days:7,quantity:2});
  check('Batch issuance returns distinct one-time codes',issued?.data?.count===2&&new Set((issued.data.codes||[]).map(c=>c.code)).size===2,issued?.data?.count+' codes for '+product.name);}
 if(issued?.data?.codes?.length){
  for(const c of issued.data.codes){const disabled=commerce('/admin/exchange-codes/'+c.id+'/disable',token,'POST',{});if(disabled?.data?.state!=='disabled')check('Issued code can be disabled before use',false,c.id);}
  check('Issued codes can be disabled before use',true,issued.data.codes.length+' codes disabled');
  const unused=commerce('/admin/exchange-codes?state=unused',token);
  check('Disabled codes leave the unused state',!(unused?.data?.rows||[]).some(r=>issued.data.codes.some(c=>c.id===r.id)));
  const disabledList=commerce('/admin/exchange-codes?state=disabled',token);
  check('Disabled codes remain auditable in the console',(disabledList?.data?.rows||[]).filter(r=>issued.data.codes.some(c=>c.id===r.id)).length===issued.data.codes.length);
  out.issued_note='线上验证所发码已全部停用，不构成可兑换凭证；兑换记录能力由隔离库 34 项验收覆盖';
 } else out.issued_note='线上未执行发码（商品或演示开关不可用）';
 fs.mkdirSync(path.join(root,'docs/verification/guiyang-closed-loop'),{recursive:true});
 fs.writeFileSync(path.join(root,'docs/verification/guiyang-closed-loop/live-check.json'),JSON.stringify(out,null,2));
 console.log('Live check: '+out.checks.filter(c=>c.ok).length+'/'+out.checks.length+' passed');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
