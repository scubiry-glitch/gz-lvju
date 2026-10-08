'use strict';
// 把《门店长租价格建议及报名表 - 上线名单.xlsx》转换为 commerce/hotel-roster.json。
// 只用 Node（unzip 二进制解包 + 正则解析 sheet XML），不引入 Python；转换可重跑、结果确定。
const {execFile}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const TIERS=[80,100,120,160,180,200];

function decode(s){return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}

async function extract(xlsx){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hotel-roster-'));
  await new Promise((resolve,reject)=>execFile('unzip',['-o',xlsx,'xl/sharedStrings.xml','xl/worksheets/sheet1.xml','-d',dir],{maxBuffer:16*1024*1024},(e,stdout)=>e?reject(e):resolve(stdout)));
  return dir;
}

function readSharedStrings(dir){
  const xml=fs.readFileSync(path.join(dir,'xl/sharedStrings.xml'),'utf8');
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join('')));
}

function readRows(dir,strings){
  const xml=fs.readFileSync(path.join(dir,'xl/worksheets/sheet1.xml'),'utf8');
  const rows=[];
  for(const rm of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
    const cells={};
    for(const cm of rm[2].matchAll(/<c \br="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)){
      const attrs=cm[2],inner=cm[3];
      const vm=inner.match(/<v>([\s\S]*?)<\/v>/);
      const tm=inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      let value=vm?vm[1]:(tm?decode(tm[1]):'');
      if(/\bt="s"/.test(attrs)&&value!=='')value=decode(strings[Number(value)]??'');
      if(value!=='')cells[cm[1]]=value;
    }
    rows.push({row:Number(rm[1]),cells});
  }
  return rows;
}

async function build(xlsx,outPath){
  const dir=await extract(xlsx);
  try{
    const strings=readSharedStrings(dir);
    const rows=readRows(dir,strings).sort((a,b)=>a.row-b.row);
    const head=rows[0]?.cells||{};
    const expect={'A':'战区','B':'分公司','C':'区域','D':'酒店名称','E':'酒店编码','F':'酒店品牌'};
    for(const [col,label] of Object.entries(expect))if(head[col]!==label)throw Error(`表头不符：${col} 应为「${label}」，实际「${head[col]}」`);
    if(!/^最终报名价格档位/.test(head.G||''))throw Error(`G 列表头应为「最终报名价格档位（OTA）」，实际「${head.G}」`);
    const hotels=[];const codes=new Set();const tiers={};const brandTiers={};
    for(const {row,cells} of rows.slice(1)){
      const record={war_zone:cells.A,branch:cells.B,region:cells.C,name:cells.D,code:cells.E,brand:cells.F,tier:Number(cells.G)};
      for(const [k,v] of Object.entries(record))if(v===undefined||v===''||(k==='tier'&&!Number.isFinite(v)))throw Error(`第 ${row} 行字段缺失或不合法：${k}`);
      if(!TIERS.includes(record.tier))throw Error(`第 ${row} 行价格档 ${record.tier} 不在 ${TIERS.join('/')} 内`);
      if(codes.has(record.code))throw Error(`第 ${row} 行酒店编码重复：${record.code}`);
      codes.add(record.code);
      tiers[record.tier]=(tiers[record.tier]||0)+1;
      brandTiers[record.brand]=brandTiers[record.brand]||{};brandTiers[record.brand][record.tier]=(brandTiers[record.brand][record.tier]||0)+1;
      hotels.push(record);
    }
    const payload={meta:{source:path.basename(xlsx),converted_at:new Date().toISOString(),count:hotels.length,tiers,brands:brandTiers,note:'真实报名上线名单；本仓库仅用于试点演示匹配，全量导入与真实履约属后续工作。'},hotels};
    fs.mkdirSync(path.dirname(outPath),{recursive:true});
    fs.writeFileSync(outPath,JSON.stringify(payload,null,1)+'\n');
    console.log(`converted ${hotels.length} hotels -> ${outPath}`);
    console.log('tiers:',JSON.stringify(tiers));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

if(require.main===module){
  const xlsx=process.argv[2],out=process.argv[3]||path.resolve(__dirname,'../../commerce/hotel-roster.json');
  if(!xlsx){console.error('usage: node scripts/commerce/hotel-roster-build.cjs <名单.xlsx> [输出.json]');process.exit(1);}
  build(path.resolve(xlsx),path.resolve(out)).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={build};
