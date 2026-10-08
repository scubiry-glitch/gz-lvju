'use strict';
// 酒店通兑三品类演示 seed 薄壳：--apply 初始化/补缺（幂等），--clean 按收据清理（有业务单据拒删）。
const fs=require('node:fs'),path=require('node:path');
const {createPool}=require('../../commerce/db.cjs');
const demo=require('../../commerce/hotel-exchange-demo.cjs');
(async()=>{const pool=createPool();try{
 const out=path.resolve(__dirname,'../../docs/verification/hotel-exchange-closed-loop');
 if(process.argv.includes('--clean')){
  if(!process.argv.includes('--apply'))throw Error('clean 也需要 --apply 确认（会删除演示实体）');
  const result=await demo.clean(pool);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'clean-'+Date.now()+'.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2));
  console.log(JSON.stringify(result,null,2));return;
 }
 if(!process.argv.includes('--apply'))throw Error('Use --apply to initialize the hotel exchange demo fixtures (真实名单试点演示，无资金)');
 const result=await demo.seed(pool);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'seed-'+Date.now()+'.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2));
 console.log(JSON.stringify({city:result.city&&result.city.name,sampled:result.sampled,created:result.created.reduce((o,r)=>(o[r.kind]=(o[r.kind]||0)+1,o),{}),existing:result.existing.length},null,2));
}finally{await pool.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
