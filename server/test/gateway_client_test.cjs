'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GatewayClient,
  GatewayHttpError,
  normalizeEnv,
} = require('../utils/gateway-client.cjs');

test('gateway environment normalization recognizes production aliases', () => {
  assert.equal(normalizeEnv('prod'), 'prod');
  assert.equal(normalizeEnv('production'), 'prod');
  assert.equal(normalizeEnv('development'), 'test');
});

test('gateway refuses to request a token without injected credentials', async () => {
  const client = new GatewayClient({
    gatewayUrl: 'https://gateway.example.test',
    clientConfig: { clientId: '', clientSecret: '', clientType: 'test' },
  });
  await assert.rejects(client.getToken(), (error) => {
    assert.ok(error instanceof GatewayHttpError);
    assert.equal(error.code, 'GATEWAY_CONFIG_ERROR');
    return true;
  });
});
