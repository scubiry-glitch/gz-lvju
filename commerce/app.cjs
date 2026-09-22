'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Service,digest}=require('./service.cjs'),{definitions,Fault,assert}=require('./configuration.cjs');
const registry=require('../perm_registry.cjs');
const settlement=require('./settlement.cjs');
const FUND_READ='commerce.fund.read',FUND_WRITE='commerce.fund.write',FUND_REVIEW='commerce.fund.review';
const prefix='/api/commerce/v1';
function createServer({pool,auth,publicOrigin='',staticFiles=false,demoEnabled=process.env.JUZHU_ENV==='test'}){
 const service=new Service(pool,auth);
 const server=http.createServer(async(req,res)=>{
  const reply=(status,data,error,code)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(error===undefined?{data}:{...(code?{code}:{}),error}));};
  let principal=null,method=req.method,pathname='';
  try{
   const url=new URL(req.url,'http://localhost');pathname=url.pathname;
   if(!pathname.startsWith(prefix+'/')){
    if(staticFiles&&req.method==='GET'){
     const valid=/^\/(?:assets\/commerce\/living\.webp|juzhu-(?:commerce|promoter|voucher|vouchers|hotels)\.html|(?:lvju|jiazheng)-app\.css|screens\/(?:commerce-[a-z-]+\.html|_commerce[a-z0-9-]*\.(?:js|css)|_console-login\.js|_qr\.js|_nav\.js))$/;
     if(valid.test(pathname)){const file=path.resolve(__dirname,'..','.'+pathname);if(fs.existsSync(file)){res.writeHead(200,{'Content-Type':pathname.endsWith('.html')?'text/html; charset=utf-8':pathname.endsWith('.css')?'text/css':pathname.endsWith('.webp')?'image/webp':'text/javascript'});res.end(fs.readFileSync(file));return;}}
    }
    throw new Fault(404,'接口不存在');
   }
   if(!['GET','POST','PUT'].includes(method))throw new Fault(405,'请求方法不支持');
   const origin=publicOrigin||`http://${req.headers.host}`;
   assert(req.headers.host===new URL(origin).host,'请求来源无效',403);
   if(method!=='GET')assert(!req.headers.origin||req.headers.origin===origin,'不允许跨站操作',403);
   if(pathname===prefix+'/meta'&&method==='GET'){await pool.query('SELECT 1');return reply(200,{mode:'mysql-m1a',payment_enabled:false,version:'M1-A',authentication:'account-center'});}
   if(pathname===prefix+'/healthz'&&method==='GET'){try{const result=(await pool.query('SELECT 1 AS ok, (SELECT MAX(version) FROM commerce_migrations) AS migration').catch(()=>[[{ok:0}]]))[0];if(result[0]&&Number(result[0].ok)===1)return reply(200,{status:'ok',database:true,migration:result[0].migration||null,payment_enabled:false});}catch(e){}return reply(503,{status:'unavailable',database:false});}
   if(pathname===prefix+'/referral'&&method==='GET'){const data=await service.verifyReferral(url.searchParams.get('token'));return reply(200,{kind:data.kind,product_id:data.id,version:data.v});}
   if(pathname===prefix+'/catalog'&&method==='GET')return reply(200,(await service.catalog(url.searchParams.get('city')||'')).map(p=>({...p,demo_purchase_enabled:demoEnabled&&p.is_demo})));
   if(pathname===prefix+'/hotels'&&method==='GET')return reply(200,await service.hotels(Object.fromEntries(url.searchParams)));
   // No legacy API key, M0 role selector, arbitrary account header, or machine token fallback.
   const session=await auth.verifySessionToken(auth.bearerToken(req));
   assert(session&&session.account.status==='active'&&session.account.principal_type==='user','请登录后继续',401);
   principal={type:'account',...session};
   let body={};
   if(method!=='GET'){assert((req.headers['content-type']||'').split(';')[0]==='application/json','请求格式必须为JSON',415);let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;assert(bytes<=65536,'请求内容过大',413);text+=chunk;}try{body=JSON.parse(text||'{}');}catch{throw new Fault(400,'请求内容不是有效JSON');}assert(body&&typeof body==='object'&&!Array.isArray(body),'请求格式无效',400);}
   if(pathname===prefix+'/me'&&method==='GET')return reply(200,{account:{id:principal.account.id,display_name:principal.account.display_name},permissions:[...auth.permissionsOf(principal)],scope:auth.scopeOf(principal)});
   if(pathname===prefix+'/my'&&method==='GET')return reply(200,await service.my(principal));
   const track=pathname.match(/^\/api\/commerce\/v1\/my\/orders\/([a-f0-9-]{36})$/);
   if(track&&method==='GET')return reply(200,await service.track(principal,track[1]));
   if(pathname===prefix+'/orders'&&method==='POST')throw new Fault(409,'购买暂未开放，请关注开售通知');
   if(pathname===prefix+'/demo-orders'&&method==='POST'){assert(demoEnabled,'演示购买未开放',409);return reply(201,await require('./demo-order.cjs').demoOrder(service,principal,body,req.headers['idempotency-key']));}
   if(pathname===prefix+'/exchange'&&method==='POST'){assert(demoEnabled,'兑换暂未开放',409);return reply(201,await require('./exchange-codes.cjs').exchange(service,principal,body,req.headers['idempotency-key']));}
   if(pathname===prefix+'/appointments'&&method==='POST')return reply(201,await service.appointment(principal,body,req.headers['idempotency-key']));
   if(pathname===prefix+'/cases'&&method==='POST')return reply(201,await service.openCase(principal,body,req.headers['idempotency-key']));
   const coupon=pathname.match(/^\/api\/commerce\/v1\/coupons\/([a-f0-9-]{36})\/token$/);
   if(coupon&&method==='POST')return reply(200,await service.token(principal,coupon[1]));
   if(pathname===prefix+'/promotion'&&method==='GET'){
    const [rows]=await pool.execute("SELECT COUNT(DISTINCT o.id) AS orders,COUNT(DISTINCT CASE WHEN JSON_EXTRACT(o.snapshot,'$.is_demo')=true THEN o.id END) AS demo_orders,COUNT(r.id) AS redemptions,COALESCE(SUM(r.channel_minor),0) AS confirmed_minor FROM commerce_orders o LEFT JOIN commerce_coupons c ON c.order_id=o.id LEFT JOIN commerce_redemptions r ON r.coupon_id=c.id WHERE o.source_account_id=?",[principal.account.id]);
    return reply(200,{...rows[0],settlement:await settlement.promoterSettlement(pool,principal.account.id),withdrawal_enabled:false,demo_note:'演示订单不发生资金与佣金，统计与真实交易分开呈现'});
   }
   if(pathname===prefix+'/shares'&&method==='POST'){
    const products=await service.catalog(),product=products.find(v=>v.kind===body.kind&&v.id===body.product_id);assert(product,'商品尚未发布',404);
    const payload=Buffer.from(JSON.stringify({aid:principal.account.id,kind:product.kind,id:product.id,v:product.version,exp:Math.floor(Date.now()/1000)+7*86400})).toString('base64url');
    const secret=process.env.JUZHU_API_KEY||process.env.JUZHU_ADMIN_PASSWORD;assert(secret,'分享服务暂不可用',503);const signature=crypto.createHmac('sha256',secret).update('commerce-share:'+payload).digest('base64url');
    await service.audit(pool,principal,'promotion.share',`${product.kind}/${product.id}`,{version:product.version},{city_id:product.city_id});
    return reply(201,{url:origin+'/juzhu-commerce.html?product='+product.kind+'-'+product.id+'&ref='+payload+'.'+signature,expires_days:7});
   }
   const route=registry.match(pathname,method);assert(route?.perm&&route.perm.startsWith('commerce.'),'接口不存在',404);assert(auth.hasPermission(principal,route.perm),'当前账号没有访问权限',403);
   if(pathname===prefix+'/admin/exchange-codes'&&method==='POST'){assert(demoEnabled,'演示兑换码暂未开放',409);return reply(201,await require('./exchange-codes.cjs').issue(service,principal,body,req.headers['idempotency-key']));}
   if(pathname===prefix+'/admin/exchange-codes'&&method==='GET')return reply(200,await require('./exchange-codes.cjs').list(service,principal,route.perm,Object.fromEntries(url.searchParams)));
   const codeKey=pathname.match(/^\/api\/commerce\/v1\/admin\/exchange-codes\/([0-9a-f-]{36})\/disable$/);
   if(codeKey&&method==='POST')return reply(200,await require('./exchange-codes.cjs').disable(service,principal,route.perm,codeKey[1],body));
   const merchant=pathname.startsWith(prefix+'/merchant/'),perm=route.perm;
   if(pathname===prefix+'/merchant/redeem/preview'&&method==='POST')return reply(200,await service.previewRedeem(principal,perm,body));
   if(pathname.endsWith('/lookups'))return reply(200,await service.lookups(principal,perm,url.searchParams.get('kind'),merchant));
   if(pathname.endsWith('/definitions'))return reply(200,Object.fromEntries(Object.entries(definitions).filter(([,v])=>!merchant||v.merchant)));
   if(pathname.endsWith('/inventory')&&method==='PUT')return reply(200,await service.inventory(principal,perm,body,merchant));
   if(pathname.endsWith('/redeem')&&method==='POST')return reply(200,await service.redeem(principal,perm,body,req.headers['idempotency-key']));
   if(pathname===prefix+'/admin/stats'&&method==='GET')return reply(200,await service.stats(principal,perm));
   // ── settlement closed loop (结算域)：registry 已按 FUND_* 权限点校验 ──
   if(pathname===prefix+'/admin/settlement/overview'&&method==='GET')return reply(200,await settlement.overview(service));
   if(pathname===prefix+'/admin/settlement/alerts'&&method==='GET')return reply(200,await settlement.operationalAlerts(service));
   if(pathname===prefix+'/admin/settlement/batches'&&method==='GET')return reply(200,await settlement.listBatches(service,principal,Object.fromEntries(url.searchParams)));
   if(pathname===prefix+'/admin/settlement/batches'&&method==='POST')return reply(201,await settlement.generateBatches(service,principal,body,req.headers['idempotency-key']));
   const batchId=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/batches\/(\d+)$/);
   if(batchId&&method==='GET')return reply(200,await service.tx(c=>settlement.batchView(c,Number(batchId[1]))));
   const batchAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/batches\/(\d+)\/(freeze|unfreeze|submit|review|execute|close)$/);
   if(batchAct&&method==='POST')return reply(200,await settlement.batchAction(service,principal,batchAct[2]==='review'?FUND_REVIEW:FUND_WRITE,Number(batchAct[1]),body,batchAct[2]));
   if(pathname===prefix+'/admin/settlement/instructions'&&method==='GET')return reply(200,await settlement.listInstructions(service,principal,Object.fromEntries(url.searchParams)));
   const instrAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/instructions\/(\d+)\/(retry|query)$/);
   if(instrAct&&method==='POST')return reply(200,await settlement[instrAct[2]+'Instrument'](service,principal,'payout',Number(instrAct[1])));
   if(pathname===prefix+'/admin/settlement/receipts'&&method==='POST')return reply(200,await settlement.ingestReceipt(service,principal,body));
   if(pathname===prefix+'/admin/settlement/refunds'&&method==='GET')return reply(200,await settlement.listRefundOrders(service,principal,Object.fromEntries(url.searchParams)));
   if(pathname===prefix+'/admin/settlement/refunds'&&method==='POST')return reply(201,await settlement.createRefundOrder(service,principal,body,req.headers['idempotency-key']));
   const refundAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/refunds\/(\d+)\/(execute|cancel)$/);
   if(refundAct&&method==='POST')return reply(200,await settlement.refundAction(service,principal,Number(refundAct[1]),refundAct[2],body));
   const refundSync=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/refunds\/(\d+)\/(retry|query)$/);
   if(refundSync&&method==='POST')return reply(200,await settlement[refundSync[2]+'Instrument'](service,principal,'refund',Number(refundSync[1])));
   if(pathname===prefix+'/admin/settlement/reversals'&&method==='GET')return reply(200,await settlement.listReversals(service,principal,{}));
   if(pathname===prefix+'/admin/settlement/reversals'&&method==='POST')return reply(201,await settlement.requestReversal(service,principal,body,req.headers['idempotency-key']));
   const reversalAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/reversals\/(\d+)\/review$/);
   if(reversalAct&&method==='POST')return reply(200,await settlement.reviewReversal(service,principal,Number(reversalAct[1]),body));
   if(pathname===prefix+'/admin/settlement/recoveries'&&method==='GET')return reply(200,await settlement.listRecoveries(service,principal,Object.fromEntries(url.searchParams)));
   if(pathname===prefix+'/admin/settlement/compensations'&&method==='GET')return reply(200,await settlement.listCompensations(service,principal,Object.fromEntries(url.searchParams)));
   if(pathname===prefix+'/admin/settlement/compensations'&&method==='POST')return reply(201,await settlement.createCompensation(service,principal,body,req.headers['idempotency-key']));
   const compAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/compensations\/(\d+)\/review$/);
   if(compAct&&method==='POST')return reply(200,await settlement.reviewCompensation(service,principal,Number(compAct[1]),body));
   const recoveryAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/recoveries\/(\d+)\/(recover|write-off)$/);
   if(recoveryAct&&method==='POST')return reply(200,await settlement[recoveryAct[2]==='recover'?'recover':'writeOffRecovery'](service,principal,Number(recoveryAct[1]),body));
   if(pathname===prefix+'/admin/settlement/reconciliation'&&method==='GET')return reply(200,await settlement.listRecons(service,principal));
   if(pathname===prefix+'/admin/settlement/reconciliation'&&method==='POST')return reply(201,await settlement.runReconciliation(service,principal,body,req.headers['idempotency-key']));
   const reconId=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/reconciliation\/(\d+)$/);
   if(reconId&&method==='GET')return reply(200,await settlement.reconDetail(service,principal,Number(reconId[1])));
   const diffAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/reconciliation\/(\d+)\/diffs\/(\d+)\/(assign|resolve|close)$/);
   if(diffAct&&method==='POST')return reply(200,await settlement.diffAction(service,principal,Number(diffAct[1]),Number(diffAct[2]),body,diffAct[3]));
   const sandboxAct=pathname.match(/^\/api\/commerce\/v1\/admin\/settlement\/sandbox\/(PR-[0-9a-f]{16})$/);
   if(sandboxAct&&method==='POST'){const row=await service.tx(c=>settlement.sandboxSimulate(c,sandboxAct[1],body.result));await pool.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(?,NULL,NULL,?,?,?)',[principal.account.id,'settlement.sandbox',sandboxAct[1],JSON.stringify({result:body.result})]);return reply(200,row);}
   if(pathname===prefix+'/admin/settlement/sandbox'&&method==='GET'){const requestNo=url.searchParams.get('request_no');assert(requestNo&&/^PR-[0-9a-f]{16}$/.test(requestNo),'请求号无效');return reply(200,await service.tx(c=>settlement.sandboxQuery(c,requestNo)));}
   if(pathname===prefix+'/merchant/settlement'&&method==='GET')return reply(200,await settlement.merchantSettlement(service,principal));
   const match=pathname.match(/^\/api\/commerce\/v1\/(admin|merchant)\/(merchants|stores|staff|skus|rules|packages|plans|orders|coupons|memberships|appointments|redemptions|cases|audit|inventory|capacity)(?:\/([0-9a-f-]+))?(?:\/(transition|review|handle))?$/);
   assert(match,'接口不存在',404);const [,area,kind,key,action]=match;
   if(method==='GET'&&!key)return reply(200,await service.list(principal,perm,kind,Object.fromEntries(url.searchParams),merchant));
   if(['transition','review'].includes(action)&&method==='POST'){assert((action==='review')===['approve','reject'].includes(body.action),'操作与权限接口不匹配',403);return reply(200,await service.transition(principal,perm,kind,Number(key),body,merchant));}
   if(action==='handle'&&kind==='cases'&&method==='POST')return reply(200,await service.resolveCase(principal,perm,key,body,merchant));
   if(!action&&definitions[kind]&&method==='POST'&&!key)return reply(201,await service.save(principal,perm,kind,null,body,merchant));
   if(!action&&definitions[kind]&&method==='PUT'&&key)return reply(200,await service.save(principal,perm,kind,Number(key),body,merchant));
   throw new Fault(404,'接口不存在');
  }catch(e){
   if(!e.status)console.error('Commerce request failed:',e.code||e.name);
   // Locateable failure record for retryable business operations (never inside the rolled-back transaction).
   if(principal&&method==='POST'&&[403,404,409,422].includes(e.status))pool.execute('INSERT INTO commerce_audit(actor_id,city_id,merchant_id,action,resource,detail) VALUES(?,NULL,NULL,\'operation.failed\',?,?)',[principal.account.id,method+' '+pathname,JSON.stringify({status:e.status,reason:e.message,code:e.code||null})]).catch(()=>{});
   reply(e.status||500,null,e.status?e.message:'服务暂时不可用，请稍后重试',e.status?e.code:undefined);
  }
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.service=service;return server;
}
module.exports={createServer};
if(require.main===module){const {createPool,initAuth}=require('./db.cjs'),{migrate}=require('./migrate.cjs');const pool=createPool();migrate(pool).then(()=>{const server=createServer({pool,auth:initAuth(pool),publicOrigin:process.env.COMMERCE_PUBLIC_ORIGIN||''});server.listen(Number(process.env.COMMERCE_PORT||38780),'127.0.0.1',()=>console.log('Commerce M1-A API ready; payments disabled'));const task=setInterval(()=>server.service.expire().catch(e=>console.error('Commerce expiry failed:',e.code||e.name)),30000);task.unref();const stop=()=>{clearInterval(task);server.close(()=>pool.end().then(()=>process.exit(0)));};process.on('SIGTERM',stop);process.on('SIGINT',stop);}).catch(e=>{console.error('Commerce startup failed:',e.code||e.message);pool.end();process.exitCode=1;});}
