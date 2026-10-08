'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PayCenter,
  createPayCenter,
  normalizeEnv,
} = require('../thirdApi/payCenter.cjs');

test('normalizeEnv maps production aliases to prod', () => {
  assert.equal(normalizeEnv('prod'), 'prod');
  assert.equal(normalizeEnv('production'), 'prod');
  assert.equal(normalizeEnv('PRODUCTION'), 'prod');
  assert.equal(normalizeEnv('test'), 'test');
  assert.equal(normalizeEnv('development'), 'test');
});

test('PayCenter selects the production gateway for production', () => {
  const pay = new PayCenter({ env: 'production' });
  assert.equal(pay.client.gatewayUrl, 'http://i.aroute.ke.com');
  assert.equal(pay.client.clientType, 'Web_Server_KeIDC');
  assert.equal(createPayCenter('production'), createPayCenter('prod'));
});

test('OAUTH_GATEWAY_URL overrides the environment default', () => {
  const previous = process.env.OAUTH_GATEWAY_URL;
  process.env.OAUTH_GATEWAY_URL = 'https://gateway.example.test';
  try {
    const pay = new PayCenter({ env: 'production' });
    assert.equal(pay.client.gatewayUrl, 'https://gateway.example.test');
    assert.equal(pay.client.clientType, 'Web_Server_KeIDC');
  } finally {
    if (previous === undefined) delete process.env.OAUTH_GATEWAY_URL;
    else process.env.OAUTH_GATEWAY_URL = previous;
  }
});

test('explicit constructor options override environment defaults independently', () => {
  const pay = new PayCenter({
    env: 'production',
    gatewayUrl: 'https://explicit.example.test',
  });
  assert.equal(pay.client.gatewayUrl, 'https://explicit.example.test');
  assert.equal(pay.client.clientType, 'Web_Server_KeIDC');
});
