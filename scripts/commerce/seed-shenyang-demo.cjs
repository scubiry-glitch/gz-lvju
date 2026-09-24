'use strict';
// 沈阳生活权益演示批次：同构于 scripts/commerce/seed-guiyang-demo.cjs（同一 seed 函数，
// 城市预设见 commerce/guiyang-demo.cjs CITY_PRESETS.shenyang；channelProducts=false，
// 频道货架由 scripts/life-shenyang-seed.cjs 用真实商家负责）。
// 幂等：仅创建本批次缺项（commerce_events seed_key 收据），保留已编辑记录与库存。
const fs=require('node:fs'),path=require('node:path');
const {createPool}=require('../../commerce/db.cjs');
const {seed}=require('../../commerce/guiyang-demo.cjs');
(async()=>{const pool=createPool();try{
 if(!process.argv.includes('--apply'))throw Error('Use --apply to initialize the explicitly authorized fictional Shenyang fixtures');
 const result=await seed(pool,{city:'shenyang'});const out=path.resolve(__dirname,'../../docs/verification/shenyang-life-demo');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'seed-'+Date.now()+'.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2));
 console.log(JSON.stringify({city:result.city,batch:result.batch,created:result.created.reduce((o,r)=>(o[r.kind]=(o[r.kind]||0)+1,o),{}),existing:result.existing.length},null,2));
}finally{await pool.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
