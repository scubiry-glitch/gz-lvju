'use strict';
// Run the repository's required IAM suite against a fresh database and temporary DB-only user.
const mysql=require('mysql2/promise'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {config,initAuth}=require('../../commerce/db.cjs');
const scrub=s=>String(s).replace(/("(?:token|password|api_key)"\s*:\s*")[^"]*/gi,'$1[REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_SESSION]');
(async()=>{
 const cfg=config(),suffix=Date.now(),database='commerce_iam_test_'+suffix,user='cm_iam_'+suffix,password=crypto.randomBytes(24).toString('base64url');
 const root=await mysql.createConnection({...cfg,user:'root',password:undefined,socketPath:'/var/lib/mysql/mysql.sock'});let dbCreated=false,userCreated=false,db,app;const out=path.resolve(__dirname,'../../docs/verification/newliving-commerce-m1a');fs.mkdirSync(out,{recursive:true});
 try{
  await root.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');dbCreated=true;
  await root.query("CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?",[user,password]);userCreated=true;
  await root.query('GRANT ALL PRIVILEGES ON `'+database+"`.* TO ?@'127.0.0.1'",[user]);
  const [tables]=await root.query('SHOW FULL TABLES FROM `'+cfg.database+"` WHERE Table_type='BASE TABLE'");
  for(const table of tables){const name=Object.values(table)[0];if(!/^[A-Za-z0-9_]+$/.test(name))throw Error('Unexpected table name');await root.query('CREATE TABLE `'+database+'`.`'+name+'` LIKE `'+cfg.database+'`.`'+name+'`');}
  db=mysql.createPool({...cfg,host:'127.0.0.1',database,user,password});
  process.env.JUZHU_ADMIN_PASSWORD=crypto.randomBytes(24).toString('base64url');process.env.JUZHU_API_KEY=crypto.randomBytes(32).toString('base64url');
  const auth=initAuth(db),conn=await db.getConnection();try{await auth.ensureAuthSchema(conn);}finally{conn.release();}
  await db.query("INSERT INTO cities(id,name,slug) VALUES(1,'验收城市一','test-city-a'),(2,'验收城市二','test-city-b')");
  await db.query("INSERT INTO jz_vendors(id,type,name,status) VALUES(153,'housing_operator','隔离验收商家','active')");
  const env={...process.env,MYSQL_HOST:'127.0.0.1',MYSQL_PORT:String(cfg.port),MYSQL_DB:database,MYSQL_USER:user,MYSQL_PASSWORD:password,JUZHU_ENV:'test',NODE_ENV:'test',PORT:'38882'};
  const base='http://127.0.0.1:38882';let appLog='';app=spawn(process.execPath,['app.js'],{cwd:path.resolve(__dirname,'../..'),env,stdio:['ignore','pipe','pipe']});app.stdout.on('data',b=>appLog+=b);app.stderr.on('data',b=>appLog+=b);
  let ready=false;for(let i=0;i<100;i++){if(app.exitCode!==null)throw Error('Isolated app exited: '+scrub(appLog));try{const r=await fetch(base+'/api/auth/me');if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('Isolated app not ready: '+scrub(appLog));
  if(process.argv.includes('--main-reuse'))try{await require('./main-reuse-regression.cjs').run({base,db,auth,sourceDatabase:cfg.database,root,database});}catch(e){throw Error(e.stack+'\n'+scrub(appLog).slice(-3000));}
  for(const file of (process.argv.includes('--main-reuse')?[]:process.argv.includes('--remaining')?['scope_regression.cjs','iam_api_regression.cjs']:['perm_registry_snapshot.cjs','perm_gate_regression.cjs','auth_security_regression.cjs','scope_regression.cjs','iam_api_regression.cjs'])){
   const result=await new Promise((resolve,reject)=>{let output='';const child=spawn(process.execPath,['scripts/'+file,base],{cwd:path.resolve(__dirname,'../..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);const timeout=setTimeout(()=>child.kill('SIGTERM'),120000);child.on('exit',code=>{clearTimeout(timeout);resolve({code,output:scrub(output)});});});
   fs.writeFileSync(path.join(out,file+'.txt'),result.output);console.log(file+': '+(result.code===0?'PASS':'FAIL')+' ('+(result.output.match(/^PASS/gm)||[]).length+' checks)');if(result.code!==0)throw Error(result.output);
  }
 }finally{
  if(app&&app.exitCode===null){app.kill('SIGTERM');await new Promise(resolve=>{app.once('exit',resolve);setTimeout(()=>{app.kill('SIGKILL');resolve();},3000).unref();});}
  if(db)await db.end();if(dbCreated&&/^commerce_iam_test_\d+$/.test(database))await root.query('DROP DATABASE `'+database+'`');if(userCreated)await root.query("DROP USER ?@'127.0.0.1'",[user]);await root.end();
 }
})().catch(e=>{console.error(scrub(e.message));process.exitCode=1;});
