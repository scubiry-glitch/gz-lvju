#!/usr/bin/env node
/**
 * 项目真实号：校验、管理端写入字段、公开接口脱敏（不启服务、不连库）
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = require(path.join(ROOT, 'app.js'));

function run() {
  assert.strictEqual(app.validateRealPhone('138-0013-8000'), '13800138000');
  assert.strictEqual(app.validateRealPhone(''), null);
  assert.strictEqual(app.validateRealPhone(null), null);

  assert.throws(() => app.validateRealPhone('40012345678'), /真实号码/);
  assert.throws(() => app.validateRealPhone('12345'), /11–13/);

  assert.strictEqual(app.contactPhoneFromBody({ name: 'x' }), undefined);
  assert.strictEqual(app.contactPhoneFromBody({ contact_phone: '13800138000' }), '13800138000');
  assert.strictEqual(app.contactPhoneFromBody({ contact_phone: '' }), null);
  assert.throws(() => app.contactPhoneFromBody({ contact_phone: '40012345678' }), /真实号码/);

  const pub = app.stripContactPhone({ id: 1, name: 'x', contact_phone: '13800138000' });
  assert.ok(!Object.prototype.hasOwnProperty.call(pub, 'contact_phone'));
  assert.strictEqual(pub.name, 'x');
  assert.strictEqual(pub.id, 1);

  console.log('OK scripts/test_juzhu_contact_phone.js');
}

run();
