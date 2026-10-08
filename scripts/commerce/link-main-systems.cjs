'use strict';
const {createPool}=require('../../commerce/db.cjs');
const {linkOrder,linkCase}=require('../../commerce/main-system.cjs');
(async()=>{const pool=createPool(),c=await pool.getConnection();try{await c.beginTransaction();
 const [orders]=await c.query("SELECT * FROM commerce_orders WHERE status='fulfilled'");for(const order of orders)await linkOrder(c,order);
 const [cases]=await c.query('SELECT * FROM commerce_cases');for(const entry of cases){const [[coupon]]=await c.execute('SELECT * FROM commerce_coupons WHERE id=?',[entry.coupon_id]);if(coupon)await linkCase(c,entry,coupon);}
 await c.commit();console.log(JSON.stringify({main_order_links:orders.length,main_work_links:cases.length,financial_transactions:0}));
}catch(e){await c.rollback();throw e;}finally{c.release();await pool.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
