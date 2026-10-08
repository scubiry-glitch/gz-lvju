'use strict';
// Read-only checks for this exact persistent walkthrough batch.
const assert=require('node:assert/strict');
const {parse,configurePool}=require('../../server/settlement/primitives.cjs');
const SEED='settlement-walkthrough-v1';
async function verifyWalkthrough(pool){
 configurePool(pool);const q=async(sql,args=[])=>(await pool.execute(sql,args))[0],errors=[];
 const contexts=await q("SELECT * FROM commerce_settlement_business_contexts WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.demo.seed_key'))=?",[SEED]);
 if(!contexts.length)return {ok:false,errors:[{kind:'NO_WALKTHROUGH_DATA'}],counts:{contexts:0}};
 const ids=contexts.map(c=>c.id),marks=ids.map(()=>'?').join(','),ctx=new Map(contexts.map(c=>[c.id,c]));
 const sources=await q(`SELECT * FROM commerce_funding_sources WHERE context_id IN (${marks})`,ids);
 for(const s of sources){
  if(s.provider!=='SYTEST_MOCK'||s.environment!=='SANDBOX')errors.push({kind:'WRONG_INSTITUTION',id:s.id});
  if(s.payment_id!=null)errors.push({kind:'WALKTHROUGH_LINKED_TO_PAYMENT',id:s.id});
  if(parse(s.evidence).demo_seed_key!==SEED)errors.push({kind:'MISSING_SOURCE_MARKER',id:s.id});
  if(['received_minor','reserved_minor','consumed_minor','returned_minor'].some(k=>BigInt(s[k])<0n)||BigInt(s.received_minor)<BigInt(s.reserved_minor)+BigInt(s.consumed_minor)+BigInt(s.returned_minor))errors.push({kind:'SOURCE_BALANCE',id:s.id});
  if(ctx.get(s.context_id).payment_mode!=='pay_center')errors.push({kind:'EXTERNAL_HAS_INTERNAL_FUNDS',id:s.id});
 }
 const items=await q(`SELECT * FROM commerce_settlement_items WHERE context_id IN (${marks})`,ids);
 for(const i of items){const used=['reserved_minor','discharged_minor','cancelled_minor','offset_minor'].reduce((a,k)=>a+BigInt(i[k]||0),0n);if(used>BigInt(i.payable_minor)||used<0n)errors.push({kind:'ITEM_BALANCE',id:String(i.id)});}
 const entries=await q(`SELECT event_id,SUM(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) balance,COUNT(*) line_count FROM commerce_ledger_entries WHERE context_id IN (${marks}) GROUP BY event_id`,ids);
 for(const e of entries)if(!e.event_id||BigInt(e.balance)!==0n||Number(e.line_count)<2)errors.push({kind:'UNBALANCED_LEDGER',id:e.event_id});
 const orders=await q(`SELECT * FROM commerce_execution_orders WHERE context_id IN (${marks})`,ids);
 for(const o of orders)if(o.provider!=='SYTEST_MOCK'||o.environment!=='SANDBOX')errors.push({kind:'REAL_EXECUTION_IN_WALKTHROUGH',id:o.id});
 const statements=await q("SELECT * FROM commerce_payee_statements WHERE party_id IN ('demo-cleaning','demo-moving','demo-rights','demo-external','demo-promoter','demo-platform','demo-customer','demo-stay')");
 for(const s of statements){
  const a=parse(s.snapshot).summary,b=n=>BigInt(a[n]||0);
  if(b('closing_minor')!==b('opening_minor')+b('accrued_minor')-b('reduced_minor')-b('discharged_minor'))errors.push({kind:'STATEMENT_BALANCE',id:s.id});
  for(const direction of ['receivable','payable']){
   const p='external_'+direction+'_';if(b(p+'outstanding_minor')!==b(p+'opening_minor')+b(p+'accrued_minor')-b(p+'reduced_minor')-b(p+'settled_minor'))errors.push({kind:'EXTERNAL_STATEMENT_BALANCE',id:s.id,direction});
   const r='recovery_'+direction+'_';if(b(r+'outstanding_minor')!==b(r+'opening_minor')+b(r+'accrued_minor')-b(r+'reduced_minor')-b(r+'recovered_minor'))errors.push({kind:'RECOVERY_STATEMENT_BALANCE',id:s.id,direction});
  }
 }
 return {ok:errors.length===0,seed_key:SEED,counts:{contexts:contexts.length,sources:sources.length,items:items.length,ledger_events:entries.length,execution_orders:orders.length,statements:statements.length},states:{items:items.reduce((o,i)=>(o[i.status]=(o[i.status]||0)+1,o),{}),orders:orders.reduce((o,i)=>(o[i.status]=(o[i.status]||0)+1,o),{})},errors};
}
async function main(){
 const mysql=require('mysql2/promise');let config;
 if(process.env.SETTLEMENT_TEST_SOCKET){assert.match(process.env.SETTLEMENT_TEST_SOCKET,/^\/tmp\/sy-settlement-[\w-]+\/[^/]+\.sock$/);assert(process.env.SETTLEMENT_TEST_DATABASE,'Explicit isolated database required');config={socketPath:process.env.SETTLEMENT_TEST_SOCKET,user:'root',database:process.env.SETTLEMENT_TEST_DATABASE};}
 else{assert(process.argv.includes('--target')&&process.argv[process.argv.indexOf('--target')+1]==='sytest','Use --target sytest for the read-only host check');config=require('../../commerce/db.cjs').config();}
 const pool=mysql.createPool({...config,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,timezone:'Z'});
 try{const result=await verifyWalkthrough(pool);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={verifyWalkthrough};
