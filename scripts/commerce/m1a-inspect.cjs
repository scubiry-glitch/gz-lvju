'use strict';
const {createPool} = require('../../commerce/db.cjs');
(async()=>{
  const pool=createPool();
  try {
    const [version]=await pool.query('SELECT VERSION() AS version, DATABASE() AS database_name');
    const [tables]=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name LIKE 'commerce\\_%' OR table_name IN ('accounts','roles','sessions','cities','jz_vendors'))");
    const [accounts]=await pool.query('SELECT status, principal_type, COUNT(*) AS n FROM accounts GROUP BY status, principal_type');
    console.log(JSON.stringify({database:version[0],tables:tables.map(x=>x.TABLE_NAME||x.table_name),accounts_summary:accounts},null,2));
  } finally {await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
