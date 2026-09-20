'use strict';
// Existing gr_orders is the customer order centre; jz_orders is the service work pool.
// Commerce tables retain only their domain snapshots/entitlements linked by the same ID.
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const accountUser=id=>'commerce-account-'+id;
async function linkOrder(c,order){
 const p=parse(order.snapshot),now=new Date().toISOString(),[[city]]=await c.execute('SELECT name FROM cities WHERE id=?',[order.city_id]);
 const [existing]=await c.execute('SELECT user_id FROM gr_orders WHERE order_ref=?',[order.id]);
 if(existing.length){if(existing[0].user_id!==accountUser(order.account_id))throw Error('Main order owner conflict');return;}
 await c.execute('INSERT INTO gr_orders(order_ref,user_id,sku,city,status,fee,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',[order.id,accountUser(order.account_id),'commerce:'+order.product_kind,city?.name||'',order.status==='fulfilled'?'completed':order.status==='expired'?'cancelled':'pending',order.amount_minor,order.created_at?new Date(order.created_at).toISOString():now,now,order.status==='fulfilled'?now:null]);
}
async function linkCase(c,entry,coupon){
 const p=parse(coupon.snapshot),now=new Date().toISOString(),category=p.sku?.category_id||'community';
 const [existing]=await c.execute('SELECT id FROM jz_orders WHERE id=?',[entry.id]);if(existing.length)return;
 const [[cat]]=await c.execute('SELECT id FROM jz_categories WHERE id=?',[category]);
 await c.execute('INSERT INTO jz_orders(id,sku_id,category_id,type,house,phone,expect_time,`desc`,fee,pay_status,status,source,created_at,updated_at,log_json) VALUES(?,NULL,?,?,?,?,?,?,0,?,?,?,?,?,?)',[entry.id,cat?.id||'community','权益售后',p.sku?.name||'生活权益','未提供','待客服确认',entry.reason,'not_required',entry.status==='closed'||entry.status==='rejected'?'done':'pending',p.is_demo?'新居住权益售后（演示）':'新居住权益售后',now,now,JSON.stringify([{at:now,action:'created',note:entry.reason,order_ref:coupon.order_id,coupon_id:coupon.id}])]);
}
async function resolveWork(c,caseId,resolution){
 const [[work]]=await c.execute('SELECT log_json FROM jz_orders WHERE id=?',[caseId]);if(!work)return;
 const now=new Date().toISOString(),log=parse(work.log_json||'[]');log.push({at:now,action:'resolved',note:resolution});
 await c.execute("UPDATE jz_orders SET status='done',updated_at=?,log_json=? WHERE id=?",[now,JSON.stringify(log),caseId]);
}
async function workCompleted(c,work){
 if(!String(work.source||'').startsWith('新居住权益售后'))return;
 const [[entry]]=await c.execute('SELECT s.*,c.snapshot FROM commerce_cases s JOIN commerce_coupons c ON c.id=s.coupon_id WHERE s.id=? FOR UPDATE',[work.id]);if(!entry||!['open','processing'].includes(entry.status))return;
 const snapshot=parse(entry.snapshot),status=entry.kind==='refund'&&!snapshot.is_demo?'awaiting_provider':'closed';
 await c.execute('UPDATE commerce_cases SET status=?,resolution=COALESCE(resolution,?) WHERE id=?',[status,'主站售后工单已处理完成'+(snapshot.is_demo?'（演示，无实际退款）':''),entry.id]);
}
async function enrichOrders(c,rows){
 const owned=rows.filter(o=>String(o.user_id||'').startsWith('commerce-account-'));if(!owned.length)return rows;
 const [ext]=await c.execute('SELECT id,account_id,snapshot FROM commerce_orders WHERE id IN ('+owned.map(()=>'?').join(',')+')',owned.map(o=>o.order_ref));
 const map=new Map(ext.map(e=>[e.id,e]));return rows.map(o=>{const e=map.get(o.order_ref);if(!e||accountUser(e.account_id)!==o.user_id)return o;const p=parse(e.snapshot);return {...o,product_name:p.name,category_id:p.category_id||'community',is_commerce:true,is_demo:p.is_demo===true,demo_price_minor:p.demo_price_minor??null};});
}
module.exports={accountUser,linkOrder,linkCase,resolveWork,workCompleted,enrichOrders};
