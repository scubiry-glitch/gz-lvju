'use strict';

const crypto = require('node:crypto');
const {assert} = require('./configuration.cjs');

const VERSION = '015_funded_distribution';
const DDL = [
 `CREATE TABLE IF NOT EXISTS commerce_distribution_campaigns (
   id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(40) NOT NULL,
   sponsor_account_id BIGINT NOT NULL, city_id BIGINT NOT NULL,
   status VARCHAR(24) NOT NULL, coupon_count INT NOT NULL,
   claimed_count INT NOT NULL DEFAULT 0, budget_minor BIGINT NOT NULL,
   per_user_limit INT NOT NULL, expires_at DATETIME NOT NULL,
   created_by BIGINT NOT NULL, submitted_by BIGINT NULL, reviewed_by BIGINT NULL,
   review_note VARCHAR(1000) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
   updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   KEY order_idx(order_id), KEY state_idx(status,expires_at)
 ) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS commerce_distribution_items (
   id BIGINT AUTO_INCREMENT PRIMARY KEY, campaign_id VARCHAR(36) NOT NULL,
   coupon_id VARCHAR(40) NOT NULL, state VARCHAR(24) NOT NULL DEFAULT 'available',
   claimed_by BIGINT NULL, claimed_at DATETIME NULL, released_at DATETIME NULL,
   active_coupon_id VARCHAR(40) GENERATED ALWAYS AS
     (CASE WHEN state IN ('available','claimed') THEN coupon_id ELSE NULL END) STORED,
   UNIQUE KEY uk_active_coupon(active_coupon_id), KEY campaign_idx(campaign_id,state,id),
   KEY recipient_idx(claimed_by,campaign_id)
 ) ENGINE=InnoDB`,
];
const checksum = crypto.createHash('sha256').update(DDL.join('\n')).digest('hex');
const rows = async (conn, sql, args = []) => (await conn.execute(sql, args))[0];
const utc = value => new Date(value).toISOString().slice(0,19).replace('T',' ');
const toMs = value => {
  // mysql2's default Date conversion uses the process timezone. Interpret the
  // database's DATETIME wall-clock fields as UTC, matching UTC_TIMESTAMP().
  if(value instanceof Date)value=[value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-')+
    ' '+[value.getHours(),value.getMinutes(),value.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':');
  const text=String(value).replace(' ','T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text)?text:text+'Z');
};
const secret = () => process.env.JUZHU_API_KEY || process.env.JUZHU_ADMIN_PASSWORD;

async function migrate(conn) {
  const [found] = await rows(conn,'SELECT checksum FROM commerce_migrations WHERE version=?',[VERSION]);
  if(found && found.checksum!==checksum)throw Error('Distribution migration checksum changed');
  for(const sql of DDL)await conn.query(sql);
  if(!found)await conn.execute('INSERT INTO commerce_migrations(version,checksum) VALUES(?,?)',[VERSION,checksum]);
}

function sign(campaign) {
  assert(secret(),'分发服务暂不可用',503);
  const payload=Buffer.from(JSON.stringify({id:campaign.id,exp:Math.floor(toMs(campaign.expires_at)/1000)})).toString('base64url');
  const signature=crypto.createHmac('sha256',secret()).update('commerce-distribution:'+payload).digest('base64url');
  return payload+'.'+signature;
}
function verify(token) {
  assert(typeof token==='string'&&token.length<500,'领取链接无效',422);
  const [payload,signature,...extra]=token.split('.');
  assert(payload&&signature&&!extra.length,'领取链接无效',422);
  assert(secret(),'分发服务暂不可用',503);
  const expected=crypto.createHmac('sha256',secret()).update('commerce-distribution:'+payload).digest('base64url');
  assert(signature.length===expected.length&&crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)),'领取链接签名无效',422);
  let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{assert(false,'领取链接无效',422);}
  assert(/^[0-9a-f-]{36}$/.test(String(data.id))&&Number.isSafeInteger(data.exp)&&data.exp>Math.floor(Date.now()/1000),'领取链接已过期',410);
  return data;
}

async function fundedOrder(conn,orderId,sponsorId,lock=false) {
  const [order]=await rows(conn,`SELECT * FROM commerce_orders WHERE id=?${lock?' FOR UPDATE':''}`,[orderId]);
  assert(order && String(order.account_id)===String(sponsorId),'只能分发本人已支付的券',403);
  assert(order.status==='fulfilled'&&order.payment_mode==='pay_center'&&order.payment_status==='paid'
    &&order.paid_payment_order_id&&Number(order.refunded_minor||0)===0,'订单资金尚未确认或已有退款',409);
  const snapshot=typeof order.snapshot==='string'?JSON.parse(order.snapshot):order.snapshot||{};
  assert(snapshot.is_demo!==true&&snapshot.settlement_profiles,'演示或未准入的订单不可分发',409);
  const [source]=await rows(conn,"SELECT id,received_minor,returned_minor,status FROM commerce_funding_sources WHERE payment_id=? AND source_type='PAYMENT'",[String(order.paid_payment_order_id)]);
  assert(source&&source.status==='AVAILABLE'&&Number(source.received_minor)>=Number(order.amount_minor)
    &&Number(source.returned_minor||0)===0,'原款未进入受控资金账户或已退款',409);
  const [refunded]=await rows(conn,"SELECT COUNT(*) n FROM payment_refunds WHERE payment_order_id=? AND refund_status<>'voided'",[order.paid_payment_order_id]);
  assert(Number(refunded.n)===0,'原款退款处理中，禁止分发',409);
  return order;
}

async function create(service,principal,input,key) {
  assert(Array.isArray(input.coupon_ids)&&input.coupon_ids.length>=1&&input.coupon_ids.length<=200
    &&input.coupon_ids.every(v=>/^[0-9a-f-]{36,40}$/i.test(String(v)))
    &&new Set(input.coupon_ids).size===input.coupon_ids.length,'请选择 1 至 200 张不重复的券',422);
  const days=Number(input.expires_days),limit=input.per_user_limit===undefined?1:Number(input.per_user_limit);
  assert(Number.isInteger(days)&&days>=1&&days<=90&&Number.isInteger(limit)&&limit>=1&&limit<=5,'领取期限或每人限领数量无效',422);
  return service.tx(conn=>service.idem(conn,principal,'distribution.create',key,input,async()=>{
    const order=await fundedOrder(conn,input.order_id,principal.account.id,true);
    await service.allowed(conn,principal,'commerce.admin.write',{city_id:order.city_id});
    const placeholders=input.coupon_ids.map(()=>'?').join(',');
    const coupons=await rows(conn,`SELECT * FROM commerce_coupons WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,input.coupon_ids);
    assert(coupons.length===input.coupon_ids.length&&coupons.every(c=>c.order_id===order.id&&String(c.account_id)===String(principal.account.id)
      &&c.status==='available'&&toMs(c.expires_at)>Date.now()),'分发券必须全部属于该订单、尚未使用且未过期',409);
    const [booked]=await rows(conn,`SELECT coupon_id FROM commerce_appointments WHERE coupon_id IN (${placeholders}) AND status='booked' LIMIT 1`,input.coupon_ids);
    assert(!booked,'已预约的券不能参与分发，请先取消预约',409);
    assert(coupons.every(c=>{const snapshot=typeof c.snapshot==='string'?JSON.parse(c.snapshot):c.snapshot||{};return snapshot.is_demo!==true&&snapshot.sku?.is_demo!==true;}),'演示券不能参加分发',409);
    const expiry=utc(Date.now()+days*86400000);
    assert(coupons.every(c=>toMs(c.expires_at)>toMs(expiry)),'分发截止时间不得晚于券有效期',409);
    const budget=coupons.reduce((sum,c)=>sum+Number(c.allocation_minor),0);
    assert(Number.isSafeInteger(budget)&&budget>0,'活动预算无效',409);
    const id=crypto.randomUUID();
    await conn.execute("INSERT INTO commerce_distribution_campaigns(id,order_id,sponsor_account_id,city_id,status,coupon_count,budget_minor,per_user_limit,expires_at,created_by) VALUES(?,?,?,?,'draft',?,?,?,?,?)",
      [id,order.id,principal.account.id,order.city_id,coupons.length,budget,limit,expiry,principal.account.id]);
    for(const coupon of coupons){
      await conn.execute('INSERT INTO commerce_distribution_items(campaign_id,coupon_id) VALUES(?,?)',[id,coupon.id]);
      await conn.execute("UPDATE commerce_coupons SET status='reserved',token_hash=NULL,token_expires_at=NULL WHERE id=?",[coupon.id]);
    }
    await service.audit(conn,principal,'distribution.create',id,{order_id:order.id,coupon_count:coupons.length,budget_minor:budget},{city_id:order.city_id});
    return {id,status:'draft',coupon_count:coupons.length,budget_minor:budget,expires_at:expiry,per_user_limit:limit};
  }));
}

async function action(service,principal,id,verb,input={}) {
  return service.tx(async conn=>{
    const [campaign]=await rows(conn,'SELECT * FROM commerce_distribution_campaigns WHERE id=? FOR UPDATE',[id]);
    assert(campaign,'分发活动不存在',404);
    await service.allowed(conn,principal,verb==='review'?'commerce.admin.review':'commerce.admin.write',{city_id:campaign.city_id});
    if(verb==='submit'){
      assert(campaign.status==='draft'&&toMs(campaign.expires_at)>Date.now(),'活动状态不允许提交或已过期',409);
      await conn.execute("UPDATE commerce_distribution_campaigns SET status='submitted',submitted_by=? WHERE id=?",[principal.account.id,id]);
    }else if(verb==='review'){
      assert(campaign.status==='submitted'&&toMs(campaign.expires_at)>Date.now(),'活动状态不允许复核或已过期',409);
      assert(String(campaign.submitted_by)!==String(principal.account.id),'提交人不能复核自己的活动',403);
      assert(['approve','reject'].includes(input.action)&&typeof input.note==='string'&&input.note.trim().length>=2&&input.note.length<=1000,'请填写复核结果与意见',422);
      if(input.action==='approve')await fundedOrder(conn,campaign.order_id,campaign.sponsor_account_id,true);
      else await release(conn,campaign);
      await conn.execute('UPDATE commerce_distribution_campaigns SET status=?,reviewed_by=?,review_note=? WHERE id=?',
        [input.action==='approve'?'approved':'rejected',principal.account.id,input.note.trim(),id]);
    }else if(verb==='activate'){
      assert(campaign.status==='approved'&&toMs(campaign.expires_at)>Date.now(),'活动未获批准或已过期',409);
      await fundedOrder(conn,campaign.order_id,campaign.sponsor_account_id,true);
      await conn.execute("UPDATE commerce_distribution_campaigns SET status='active' WHERE id=?",[id]);
    }else if(verb==='close'){
      assert(['active','approved','submitted','draft'].includes(campaign.status),'活动不能关闭',409);
      await conn.execute("UPDATE commerce_distribution_campaigns SET status='closed' WHERE id=?",[id]);
      await release(conn,campaign);
    }else assert(false,'操作无效',404);
    await service.audit(conn,principal,'distribution.'+verb,id,{action:input.action||null,note:input.note||null},{city_id:campaign.city_id});
    const [updated]=await rows(conn,'SELECT * FROM commerce_distribution_campaigns WHERE id=?',[id]);
    return {...updated,expires_at:utc(toMs(updated.expires_at)),...(updated.status==='active'?{token:sign(updated)}:{})};
  });
}

async function preview(pool,token) {
  const {id,exp}=verify(token);
  const [campaign]=await rows(pool,'SELECT id,status,coupon_count,claimed_count,expires_at,city_id,per_user_limit FROM commerce_distribution_campaigns WHERE id=?',[id]);
  assert(campaign&&campaign.status==='active'&&Math.floor(toMs(campaign.expires_at)/1000)===exp&&toMs(campaign.expires_at)>Date.now(),'分发活动已结束',410);
  return {id,status:campaign.status,remaining:Math.max(0,Number(campaign.coupon_count)-Number(campaign.claimed_count)),expires_at:utc(toMs(campaign.expires_at)),city_id:campaign.city_id,per_user_limit:campaign.per_user_limit};
}

async function claim(service,principal,token,key) {
  const {id,exp}=verify(token);
  return service.tx(conn=>service.idem(conn,principal,'distribution.claim',key,{campaign_id:id,exp},async()=>{
    const [campaign]=await rows(conn,'SELECT * FROM commerce_distribution_campaigns WHERE id=? FOR UPDATE',[id]);
    assert(campaign&&campaign.status==='active'&&Math.floor(toMs(campaign.expires_at)/1000)===exp&&toMs(campaign.expires_at)>Date.now(),'分发活动已结束',410);
    assert(String(principal.account.id)!==String(campaign.sponsor_account_id),'发起人不能领取自己分发的券',409);
    await fundedOrder(conn,campaign.order_id,campaign.sponsor_account_id,true);
    const [prior]=await rows(conn,"SELECT COUNT(*) n FROM commerce_distribution_items WHERE campaign_id=? AND claimed_by=? AND state='claimed'",[id,principal.account.id]);
    assert(Number(prior.n)<Number(campaign.per_user_limit),'已达到每人领取上限',409);
    const [item]=await rows(conn,"SELECT di.id,di.coupon_id,c.status,c.account_id,c.expires_at FROM commerce_distribution_items di JOIN commerce_coupons c ON c.id=di.coupon_id WHERE di.campaign_id=? AND di.state='available' ORDER BY di.id LIMIT 1 FOR UPDATE",[id]);
    assert(item&&item.status==='reserved'&&String(item.account_id)===String(campaign.sponsor_account_id)&&toMs(item.expires_at)>Date.now(),'活动券已领完或已失效',409);
    await conn.execute("UPDATE commerce_distribution_items SET state='claimed',claimed_by=?,claimed_at=UTC_TIMESTAMP() WHERE id=?",[principal.account.id,item.id]);
    const [updated]=await conn.execute("UPDATE commerce_coupons SET account_id=?,status='available',snapshot=JSON_SET(snapshot,'$.distribution',JSON_OBJECT('campaign_id',?,'sponsor_account_id',?)) WHERE id=? AND account_id=? AND status='reserved'",
      [principal.account.id,id,campaign.sponsor_account_id,item.coupon_id,campaign.sponsor_account_id]);
    assert(updated.affectedRows===1,'卡券领取状态已变化',409);
    await conn.execute('UPDATE commerce_distribution_campaigns SET claimed_count=claimed_count+1 WHERE id=?',[id]);
    await service.audit(conn,principal,'distribution.claim',item.coupon_id,{campaign_id:id},{city_id:campaign.city_id});
    return {campaign_id:id,coupon_id:item.coupon_id,status:'claimed'};
  }));
}

async function list(service,principal) {
  const scope=service.scope(principal,'commerce.admin.read');
  let where='1=1',args=[];
  if(scope.level==='city'){where=`city_id IN (${scope.cityIds.map(()=>'?').join(',')||'NULL'})`;args=scope.cityIds;}
  else if(scope.level!=='all'){where='sponsor_account_id=?';args=[principal.account.id];}
  const campaigns=await rows(service.pool,`SELECT id,order_id,sponsor_account_id,city_id,status,coupon_count,claimed_count,budget_minor,per_user_limit,expires_at,created_at FROM commerce_distribution_campaigns WHERE ${where} ORDER BY created_at DESC LIMIT 100`,args);
  return campaigns.map(c=>({...c,expires_at:utc(toMs(c.expires_at)),...(c.status==='active'&&toMs(c.expires_at)>Date.now()?{token:sign(c)}:{})}));
}

async function release(conn,campaign) {
  const items=await rows(conn,"SELECT coupon_id FROM commerce_distribution_items WHERE campaign_id=? AND state='available' ORDER BY coupon_id FOR UPDATE",[campaign.id]);
  for(const item of items)await conn.execute("UPDATE commerce_coupons SET status='available' WHERE id=? AND account_id=? AND status='reserved'",[item.coupon_id,campaign.sponsor_account_id]);
  await conn.execute("UPDATE commerce_distribution_items SET state='released',released_at=UTC_TIMESTAMP() WHERE campaign_id=? AND state='available'",[campaign.id]);
}

async function expire(service) {
  const candidates=await rows(service.pool,"SELECT id FROM commerce_distribution_campaigns WHERE status IN ('draft','submitted','approved','active') AND expires_at<=UTC_TIMESTAMP() ORDER BY expires_at LIMIT 100");
  for(const {id} of candidates)await service.tx(async conn=>{
    const [campaign]=await rows(conn,'SELECT * FROM commerce_distribution_campaigns WHERE id=? FOR UPDATE',[id]);
    if(!campaign||!['draft','submitted','approved','active'].includes(campaign.status)||toMs(campaign.expires_at)>Date.now())return;
    await release(conn,campaign);
    await conn.execute("UPDATE commerce_distribution_campaigns SET status='expired' WHERE id=?",[id]);
  });
  return candidates.length;
}

module.exports={migrate,create,action,preview,claim,list,expire,sign,verify};
