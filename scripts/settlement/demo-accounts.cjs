'use strict';
// Only the settlement walkthrough identities. Never resets existing passwords,
// grants wildcard permissions, or changes an unrelated role/account.
const assert=require('node:assert/strict');
const {hashPassword}=require('../../auth_center.cjs');
const parties=['demo-cleaning','demo-moving','demo-rights','demo-external','demo-promoter','demo-platform','demo-customer'];
const statement=['settlement.statement.read','settlement.statement.export','settlement.statement.confirm','settlement.statement.dispute'];
const definitions={
 operator:{name:'结算走查·财务经办',permissions:['settlement.fund.read','settlement.fund.write','settlement.fund.adjust','settlement.policy.write','settlement.external.read','settlement.external.import','settlement.external.link','settlement.accrual.adjust','settlement.statement.generate',...statement],parties},
 reviewer:{name:'结算走查·财务复核',permissions:['settlement.fund.read','settlement.fund.review','settlement.approval.act','settlement.policy.review','settlement.external.read','settlement.external.review','settlement.statement.review',...statement],parties},
 merchant:{name:'结算走查·商家财务',permissions:[...statement,'settlement.external.submit'],parties:['demo-cleaning','demo-moving','demo-rights','demo-external']},
 promoter:{name:'结算走查·推广渠道',permissions:statement,parties:['demo-promoter']},
 platform:{name:'结算走查·平台财务',permissions:statement,parties:['demo-platform']},
};
definitions.reviewer2={...definitions.reviewer,name:'结算走查·资金复核'};
async function ensureDemoAccounts(pool,{password}={}){
 assert(typeof password==='string'&&password.length>=12,'Use a host-managed walkthrough password of at least 12 characters');
 const c=await pool.getConnection(),result={};
 try{
  await c.beginTransaction();
  for(const [key,d] of Object.entries(definitions)){
   const role='settlement_demo_'+key,login='settlement_demo_'+key;
   const [[oldRole]]=await c.execute('SELECT * FROM roles WHERE role_code=? FOR UPDATE',[role]);
   if(oldRole){assert.equal(oldRole.name,d.name,'Existing role is not owned by this walkthrough');assert.equal(Number(oldRole.builtin),0,'Never modify a built-in role');}
   else await c.execute('INSERT INTO roles(role_code,name,permissions,builtin) VALUES(?,?,?,0)',[role,d.name,JSON.stringify(d.permissions)]);
   const [[old]]=await c.execute('SELECT id,display_name,principal_type,status FROM accounts WHERE login_name=? FOR UPDATE',[login]);
   let aid;
   if(old){assert.equal(old.display_name,d.name,'Existing account is not owned by this walkthrough');assert.equal(old.principal_type,'user');assert.equal(old.status,'active','Disabled walkthrough accounts are not silently reactivated');aid=old.id;}
   else{const now=new Date().toISOString(),[r]=await c.execute("INSERT INTO accounts(login_name,display_name,principal_type,status,password_hash,created_at,updated_at) VALUES(?,?,'user','active',?,?,?)",[login,d.name,await hashPassword(password),now,now]);aid=r.insertId;}
   const scope={level:'all',party_ids:d.parties};
   const [[existing]]=await c.execute('SELECT scope FROM account_roles WHERE account_id=? AND role_code=?',[aid,role]);
   if(existing)assert.deepEqual(typeof existing.scope==='string'?JSON.parse(existing.scope):existing.scope,scope,'Walkthrough scope was changed; preserve administrator changes');
   else await c.execute('INSERT INTO account_roles(account_id,role_code,scope) VALUES(?,?,?)',[aid,role,JSON.stringify(scope)]);
   if(oldRole)assert.deepEqual(JSON.parse(oldRole.permissions),d.permissions,'Walkthrough permissions were changed; preserve administrator changes');
   const account={id:aid,display_name:d.name,login_name:login,principal_type:'user',status:'active'};
   result[key]={id:aid,login_name:login,principal:{type:'account',account,roles:[{role_code:role,permissions:d.permissions,scope}]}};
  }
  await c.commit();return result;
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
module.exports={ensureDemoAccounts,definitions,parties};
