'use strict';
const {createPool}=require('../../commerce/db.cjs');
(async()=>{const p=createPool();try{
if(process.argv.includes('--summary')){for(const sql of ["SELECT id,name,slug FROM cities","SELECT s.category_id,COUNT(DISTINCT s.id) skus,COUNT(DISTINCT p.id) guiyang_products FROM jz_skus s LEFT JOIN jz_products p ON p.channel_sku_id=s.id AND p.city_id=(SELECT id FROM cities WHERE slug='guiyang') AND p.status='on' WHERE s.enabled=1 GROUP BY s.category_id","SELECT id,slug,name,category_id,price_from FROM jz_skus WHERE enabled=1 ORDER BY id"]){console.log(JSON.stringify((await p.query(sql))[0]));}return;}
const [skus]=await p.query('SELECT id,slug,name,spec,price_from,price_unit,includes,service_notice,enabled FROM jz_skus ORDER BY id');console.log(JSON.stringify({skus}));const [products]=await p.query('SELECT id,vendor_id,city_id,title,subtitle,category,unit,price,channel_sku_id,advance_booking_hours,status FROM jz_products ORDER BY id');console.log(JSON.stringify({products}));
for(const t of ['jz_products','jz_skus']){const [cols]=await p.query('SHOW COLUMNS FROM '+t);console.log(t+' columns: '+cols.map(c=>c.Field).join(','));}
const [cities]=await p.query('SELECT id,name,slug FROM cities');console.log(JSON.stringify({cities}));
const [vendors]=await p.query('SELECT id,type,name,status,city_ids,address,phone FROM jz_vendors ORDER BY id');console.log(JSON.stringify({vendors}));
const [counts]=await p.query("SELECT 'merchants' kind,COUNT(*) n FROM commerce_merchants UNION ALL SELECT 'packages',COUNT(*) FROM commerce_packages UNION ALL SELECT 'plans',COUNT(*) FROM commerce_plans");console.log(JSON.stringify({counts}));
}finally{await p.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
