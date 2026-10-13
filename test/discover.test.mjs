/**
 * Unit tests for local-network discovery candidates (no network access).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { localCandidates } from '../lib/discover.mjs';

const iface = (address, netmask, extra = {}) => ({ address, netmask, family: 'IPv4', internal: false, ...extra });

test('covers a /24 subnet except our own address', () => {
  const hosts = localCandidates({ en0: [iface('192.168.1.20', '255.255.255.0')] });
  assert.equal(hosts.length, 253);
  assert.ok(hosts.includes('192.168.1.1'));
  assert.ok(hosts.includes('192.168.1.254'));
  assert.ok(!hosts.includes('192.168.1.20'));
  assert.ok(!hosts.includes('192.168.1.0') && !hosts.includes('192.168.1.255'));
});

test('scans a whole /22 (eero-style) subnet', () => {
  const hosts = localCandidates({ en0: [iface('192.168.4.50', '255.255.252.0')] });
  assert.equal(hosts.length, 1021);
  assert.ok(hosts.includes('192.168.7.254'));
});

test('caps larger subnets at the /22 around our address', () => {
  const hosts = localCandidates({ en0: [iface('10.1.6.9', '255.255.0.0')] });
  assert.equal(hosts.length, 1021);
  assert.ok(hosts.includes('10.1.4.1') && hosts.includes('10.1.7.254'));
  assert.ok(!hosts.includes('10.1.8.1'));
});

test('skips loopback, IPv6 and non-private addresses', () => {
  const hosts = localCandidates({
    lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    en0: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
    utun0: [iface('198.19.254.2', '255.255.255.0')],
  });
  assert.deepEqual(hosts, []);
});
