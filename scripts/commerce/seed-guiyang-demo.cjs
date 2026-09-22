'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createPool}=require('../../commerce/db.cjs');
const {seed}=require('../../commerce/guiyang-demo.cjs');
(async()=>{const pool=createPool();try{
 if(!process.argv.includes('--apply'))throw Error('Use --apply to initialize the explicitly authorized fictional Guiyang fixtures');
 const result=await seed(pool);const out=path.resolve(__dirname,'../../docs/verification/guiyang-life-demo');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'seed-'+Date.now()+'.json'),JSON.stringify({at:new Date().toISOString(),...result},null,2));
 console.log(JSON.stringify({city:result.city,created:result.created.reduce((o,r)=>(o[r.kind]=(o[r.kind]||0)+1,o),{}),existing:result.existing.length},null,2));
}finally{await pool.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
