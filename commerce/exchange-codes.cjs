'use strict';
const crypto=require('node:crypto');
const {assert}=require('./configuration.cjs');
const {isDemo}=require('./guiyang-demo.cjs');
const {grantDemoOrder}=require('./demo-order.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const ddl=`CREATE TABLE IF NOT EXISTS commerce_exchange_codes (
 id VARCHAR(40) PRIMARY KEY, code_hash CHAR(64) NOT NULL UNIQUE,
 product_kind VARCHAR(24) NOT NULL, product_id BIGINT NOT NULL, product_version INT NOT NULL,
 city_id BIGINT NOT NULL, expires_at DATETIME NOT NULL, created_by BIGINT NOT NULL,
 redeemed_by BIGINT NULL, order_id VARCHAR(40) NULL, redeemed_at DATETIME NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY city_idx(city_id)
) ENGINE=InnoDB`;
// 003: operations fields for code management (batch issue, state query, disable, records).
const adminDdl=[
 'ALTER TABLE commerce_exchange_codes ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT \'unused\'',
 'ALTER TABLE commerce_exchange_codes ADD COLUMN product_name VARCHAR(255) NOT NULL DEFAULT \'\'',
 'ALTER TABLE commerce_exchange_codes ADD COLUMN disabled_by BIGINT NULL',
 'ALTER TABLE commerce_exchange_codes ADD COLUMN disabled_at DATETIME NULL',
 'ALTER TABLE commerce_exchange_codes ADD KEY state_idx(status,expires_at)',
 'ALTER TABLE commerce_exchange_codes ADD KEY product_idx(product_kind,product_id)',
];
async function migrate(c){
 for(const [version,steps] of [['002_exchange_codes',[ddl]],['003_exchange_code_admin',adminDdl]]){
  const [r]=await c.execute('SELECT checksum FROM commerce_migrations WHERE version=?',[version]);
  const checksum=hash(steps.join('\n'));
  if(r.length){assert(r[0].checksum===checksum,`兑换码迁移${version}校验失败`,500);continue;}
  for(const sql of steps)await c.query(sql);
  await c.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',[version,checksum]);
 }
}
function productInput(input){assert(['skus','packages','plans'].includes(input.kind)&&Number.isSafeInteger(input.product_id)&&input.product_id>0,'兑换商品无效');}
async function issue(service,p,input,key){productInput(input);
 assert(Number.isInteger(input.expires_days)&&input.expires_days>=1&&input.expires_days<=90,'兑换期限应为1至90天');
 const quantity=input.quantity===undefined?1:input.quantity;
 assert(Number.isInteger(quantity)&&quantity>=1&&quantity<=200,'单次发放数量应为1至200张');
 return service.tx(c=>service.idem(c,p,'exchange-code-issue',key,input,async()=>{
  const product=await service.approved(c,input.kind,input.product_id);await service.allowed(c,p,'commerce.admin.write',product);
  assert(isDemo(product.payload),'当前仅支持无资金演示商品',409);assert(input.version===product.version,'商品版本已更新',409);
  const expires=new Date(Date.now()+input.expires_days*86400000).toISOString().slice(0,19).replace('T',' ');
  const codes=[];
  for(let n=0;n<quantity;n++){
   const id=crypto.randomUUID(),code='NL'+crypto.randomBytes(16).toString('hex').toUpperCase();
   await c.execute('INSERT INTO commerce_exchange_codes(id,code_hash,product_kind,product_id,product_version,city_id,expires_at,created_by,product_name) VALUES(?,?,?,?,?,?,?,?,?)',[id,hash(code),input.kind,product.id,product.version,product.city_id,expires,p.account.id,product.payload.name]);
   codes.push({id,code});
  }
  await service.audit(c,p,'exchange.code.issue',codes[0].id,{kind:input.kind,product_id:product.id,expires_at:expires,quantity,first_id:codes[0].id},product);
  return {id:codes[0].id,code:codes[0].code,codes,count:quantity,expires_at:expires,name:product.payload.name,kind:input.kind};
 }));}
const codeState=e=>e.status==='disabled'?'disabled':e.redeemed_by?'redeemed':new Date(e.expires_at)<=new Date()?'expired':'unused';
async function list(service,p,perm,query){
 const s=service.scope(p,perm);let where='1=1',args=[];
 if(s.level==='city'&&s.cityIds.length){where='e.city_id IN ('+s.cityIds.map(()=>'?').join(',')+')';args=[...s.cityIds];}
 else if(s.level!=='all')return {rows:[],total:0,page:1,size:20,summary:{unused:0,redeemed:0,expired:0,disabled:0}};
 const state=typeof query.state==='string'?query.state:'';
 if(['unused','redeemed','expired','disabled'].includes(state)){
  if(state==='disabled')where+=' AND e.status=\'disabled\'';
  if(state==='redeemed')where+=' AND e.status<>\'disabled\' AND e.redeemed_by IS NOT NULL';
  if(state==='expired')where+=' AND e.status<>\'disabled\' AND e.redeemed_by IS NULL AND e.expires_at<=UTC_TIMESTAMP()';
  if(state==='unused')where+=' AND e.status<>\'disabled\' AND e.redeemed_by IS NULL AND e.expires_at>UTC_TIMESTAMP()';
 }
 if(['skus','packages','plans'].includes(query.kind)){where+=' AND e.product_kind=?';args.push(query.kind);}
 if(query.q){where+=' AND e.product_name LIKE ?';args.push('%'+String(query.q).slice(0,100)+'%');}
 const page=Math.max(1,Math.min(10000,Number(query.page)||1)),size=20;
 const [[created]]=[await service.get(service.pool,`SELECT COUNT(*) total FROM commerce_exchange_codes e WHERE ${where}`,args)];
 const summary=(await service.get(service.pool,'SELECT SUM(status<>\'disabled\' AND redeemed_by IS NULL AND expires_at>UTC_TIMESTAMP()) unused,SUM(status<>\'disabled\' AND redeemed_by IS NOT NULL) redeemed,SUM(status<>\'disabled\' AND redeemed_by IS NULL AND expires_at<=UTC_TIMESTAMP()) expired,SUM(status=\'disabled\') disabled FROM commerce_exchange_codes e'+(where==='1=1'?'':' WHERE '+where),args))[0];
 const rows=(await service.get(service.pool,`SELECT e.id,e.product_kind,e.product_id,e.product_version,e.product_name,e.city_id,e.expires_at,e.created_by,e.redeemed_by,e.order_id,e.redeemed_at,e.status,e.disabled_by,e.disabled_at,e.created_at,ca.display_name created_name,ra.display_name redeemed_name FROM commerce_exchange_codes e LEFT JOIN accounts ca ON ca.id=e.created_by LEFT JOIN accounts ra ON ra.id=e.redeemed_by WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT 20 OFFSET ${((page-1)*size)}`,args)).map(e=>{const r={...e,state:codeState(e)};delete r.status;return r;});
 return {rows,total:created.total,page,size,summary:{unused:Number(summary.unused)||0,redeemed:Number(summary.redeemed)||0,expired:Number(summary.expired)||0,disabled:Number(summary.disabled)||0}};
}
async function disable(service,p,perm,key,input){
 return service.tx(async c=>{
  const [rows]=await c.execute('SELECT * FROM commerce_exchange_codes WHERE id=? FOR UPDATE',[key]);const entry=rows[0];assert(entry,'兑换码不存在',404);
  await service.allowed(c,p,perm,{city_id:entry.city_id,merchant_id:null,vendor_id:null});
  assert(!entry.redeemed_by,'已兑换的码不能停用',409);
  if(entry.status!=='disabled'){
   await c.execute('UPDATE commerce_exchange_codes SET status=\'disabled\',disabled_by=?,disabled_at=UTC_TIMESTAMP() WHERE id=?',[p.account.id,key]);
   await service.audit(c,p,'exchange.code.disable',key,{product_kind:entry.product_kind,product_id:entry.product_id,note:typeof input?.note==='string'?input.note.slice(0,200):null},{city_id:entry.city_id});
  }
  return {id:key,state:'disabled'};
 });
}
// Codes contain 128 random bits; bound invalid attempts per signed-in account as well.
const attempts=new Map();
function limit(id){const now=Date.now();for(const [k,v] of attempts)if(v.until<=now)attempts.delete(k);const state=attempts.get(id)||{until:now+60000,count:0};assert(state.count<12&&attempts.size<10000,'操作频繁，请稍后重试',429);state.count++;attempts.set(id,state);}
async function exchange(service,p,input,key){limit(p.account.id);const code=typeof input.code==='string'?input.code.replace(/[\s-]/g,'').toUpperCase():'';assert(/^NL[A-F0-9]{32}$/.test(code),'兑换码无效，请核对后重试');assert(input.demo_ack===true,'请确认此兑换为无资金演示');return service.tx(c=>service.idem(c,p,'exchange-code-redeem',key,{code_hash:hash(code),demo_ack:true},async()=>{
 const [rows]=await c.execute('SELECT * FROM commerce_exchange_codes WHERE code_hash=? FOR UPDATE',[hash(code)]);const entry=rows[0];assert(entry,'兑换码无效，请核对后重试',404);assert(entry.status!=='disabled','兑换码已停用，请联系发放方更换',409);assert(!entry.redeemed_by,'兑换码已使用',409);assert(new Date(entry.expires_at)>new Date(),'兑换码已过期',409);
 const product=await service.approved(c,entry.product_kind,entry.product_id);assert(isDemo(product.payload),'该商品暂不支持兑换',409);assert(product.version===entry.product_version,'兑换商品已更新，请联系发放方更换兑换码',409);
 const result=await grantDemoOrder(service,c,p,{kind:entry.product_kind},product);
 await c.execute('UPDATE commerce_exchange_codes SET redeemed_by=?,order_id=?,redeemed_at=UTC_TIMESTAMP() WHERE id=?',[p.account.id,result.id,entry.id]);
 await service.audit(c,p,'exchange.code.redeem',entry.id,{order_id:result.id},product);
 return {...result,kind:entry.product_kind,name:product.payload.name};
}));}
module.exports={migrate,issue,exchange,list,disable,codeState};
