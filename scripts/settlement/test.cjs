'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const socket=process.env.SETTLEMENT_TEST_SOCKET;
assert.match(socket||'',/^\/tmp\/sy-(?:settlement-[\w-]+|cashier-mysql)\/[^/]+\.sock$/,'Integration tests require SETTLEMENT_TEST_SOCKET pointing to a private temporary MySQL instance.');
const root=path.resolve(__dirname,'../..'),tests=fs.readdirSync(path.join(root,'server/test')).filter(f=>/^settlement_.*_test\.cjs$/.test(f)).map(f=>'server/test/'+f);
const result=spawnSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',env:{...process.env,PAYMENT_TEST_SOCKET:socket}});if(result.status!==0)process.exit(result.status||1);
const browser=spawnSync(process.execPath,['scripts/settlement/browser.test.cjs'],{cwd:root,stdio:'inherit',env:process.env});process.exit(browser.status||0);
