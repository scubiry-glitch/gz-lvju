'use strict';
// Explicit operations CLI. Importing this module never opens a database.
async function main(){
 const command=process.argv[2];if(!['migrate','worker-once','verify'].includes(command))throw new Error('Usage: node scripts/settlement/manage.cjs migrate|worker-once|verify');
 const mysql=require('mysql2/promise'),db=require('../../commerce/db.cjs'),options=db.config();
 const pool=mysql.createPool({...options,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:8});
 try{
  const module=require('../../server/settlement/index.cjs');
  if(command==='migrate'){await module.migrate(pool);console.log('Shared settlement migrations verified.');return;}
  const {payCenter}=require('../../server/thirdApi/payCenter.cjs');
  const auth=db.initAuth(pool),core=require('../../server/payment/core.cjs').createPaymentCore({createConnection:()=>pool.getConnection(),config:process.env,payCenter});
  const service=module.createSettlement({pool,auth,paymentCore:core,payCenter,config:process.env});
  if(command==='worker-once'){console.log(JSON.stringify(await service.maintenance()));return;}
  console.log(JSON.stringify(await service.execution.verifyInvariants(require('../../server/settlement/access.cjs').systemPrincipal,{})));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={main};
