import assert from 'node:assert/strict';

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
