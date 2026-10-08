import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxyaddr = require('proxy-addr');
assert.equal(require('proxy-addr/package.json').version, '2.0.8');
for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
  const trust = proxyaddr.compile(subnet);
  assert.equal(trust('203.0.113.9'), false, 'an IPv6 trust subnet must not accidentally trust arbitrary IPv4 peers');
  assert.equal(trust('::ffff:203.0.113.9'), false, 'mapped peers must not evade the trust boundary');
}
for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
  const trust = proxyaddr.compile(subnet);
  assert.equal(trust('10.1.2.3'), true);
  assert.equal(trust('203.0.113.9'), false);
}

const { getTrustedClientAddress } = await import('../dist/utils/client-address.js');

function request(remoteAddress, forwardedFor) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  };
}

const proxiedRequest = request('::ffff:172.20.0.3', '198.51.100.25, 203.0.113.8');
assert.equal(getTrustedClientAddress(proxiedRequest, 0), '172.20.0.3');
assert.equal(getTrustedClientAddress(proxiedRequest, 1), '203.0.113.8');
assert.equal(getTrustedClientAddress(proxiedRequest, 2), '198.51.100.25');
assert.equal(getTrustedClientAddress(proxiedRequest, 20), '198.51.100.25');
assert.equal(getTrustedClientAddress(request('2001:db8::10', ''), 2), '2001:db8::10');

console.log('client address verification passed');
