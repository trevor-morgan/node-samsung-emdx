/**
 * Unit tests for the EMDX Bluetooth setup protocol encoding (no hardware needed).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authDigest,
  bcryptB64Decode,
  bcryptB64Encode,
  buildFrame,
  Cmd,
  decodeDeviceStatus,
  decodeNetworkAddress,
  encodeWifi,
  Op,
  parseFrame,
  parseReply,
} from '../lib/emdx-ble.mjs';

test('buildFrame packs header, length, command id and payload', () => {
  // StartAuthorization: op 7, cmd 1, no payload -> 0e 01 01
  assert.equal(buildFrame({ op: Op.AUTHORIZATION, cmd: Cmd.START_AUTHORIZE }).toString('hex'), '0e0101');
  // NetworkType Set(Wi-Fi): op 0, cmd 0x11, payload [1] -> 00 02 11 01
  assert.equal(buildFrame({ op: Op.REQUEST_WITH_RESPONSE, cmd: Cmd.NETWORK_TYPE, payload: [1] }).toString('hex'), '00021101');
  // A 300-byte payload sets the length's high bit in byte 0.
  const big = buildFrame({ op: 0, cmd: 0x14, payload: new Uint8Array(300) });
  assert.equal(big[0] & 1, 1);
  assert.equal(((big[0] & 1) << 8) | big[1], 301);
});

test('parseFrame reads authorization replies (no status byte)', () => {
  // Captured StartAuthorization reply: version 3, cost 4, 16-byte salt.
  const f = parseFrame(Buffer.from('0e120364a7b8777d7c5b3530a167ec7552352f54', 'hex'));
  assert.equal(f.op, Op.AUTHORIZATION);
  assert.equal(f.cmd, 3);
  assert.equal(f.payload.length, 17);
  assert.equal(f.payload[0] >> 5, 3);
  assert.equal(f.payload[0] & 31, 4);
  // Captured AnswerAuthorization reply: result 0 (SUCCESS).
  assert.equal(parseFrame(Buffer.from('0e020200', 'hex')).payload[0], 0);
});

test('parseReply reads status, command id and data of settings replies', () => {
  const r = parseReply(Buffer.from('020e0012c0c0a8010a0a0101c0a80101', 'hex'));
  assert.equal(r.status, 0);
  assert.equal(r.cmd, Cmd.NETWORK_ACCESS);
  assert.equal(r.data.length, 12);
  assert.equal(parseReply(Buffer.from('02022614', 'hex')).status, 38); // INVALID_DATA
});

test('bcrypt base64 round-trips a 16-byte salt to 22 characters', () => {
  const salt = Buffer.from('a7b8777d7c5b3530a167ec7552352f54', 'hex');
  const s = bcryptB64Encode(salt);
  assert.equal(s.length, 22);
  assert.deepEqual(bcryptB64Decode(s), salt);
  assert.equal(bcryptB64Encode(bcryptB64Decode('CCCCCCCCCCCCCCCCCCCCC.')), 'CCCCCCCCCCCCCCCCCCCCC.');
});

test('authDigest matches an independent bcrypt implementation', () => {
  // Synthetic PIN; expected value computed with pyca/bcrypt 5.0.0 ($2b$04$, same salt).
  const salt = Buffer.from('a7b8777d7c5b3530a167ec7552352f54', 'hex');
  const digest = authDigest('123456', 4, salt);
  assert.equal(digest.length, 23);
  assert.equal(digest.toString('hex'), '22238648b1ee9f8a6720c7d6de087d5689b0b0fc1aef2e');
  assert.throws(() => authDigest('123456', 4, salt.subarray(0, 15)));
});

test('encodeWifi follows WifiAccessPointCommand.Set', () => {
  assert.equal(encodeWifi('home', 'secret').toString('hex'), `44${Buffer.from('home').toString('hex')}06${Buffer.from('secret').toString('hex')}`);
  // Open network: no password flag and no password-length byte.
  assert.equal(encodeWifi('cafe').toString('hex'), `04${Buffer.from('cafe').toString('hex')}`);
  assert.throws(() => encodeWifi('x'.repeat(33), 'pw'));
  assert.throws(() => encodeWifi('ok', 'x'.repeat(65)));
});

test('decodeNetworkAddress and decodeDeviceStatus', () => {
  const n = decodeNetworkAddress(Buffer.from('d8c0a8010a0a0101010808080808', 'hex').subarray(0, 13));
  assert.deepEqual(n, { dhcp: true, autoDns: true, prefix: 24, ip: '192.168.1.10', gateway: '10.1.1.1', dns: '8.8.8.8' });
  assert.equal(decodeDeviceStatus(Buffer.from([0x01])).setupDone, 1);
  assert.equal(decodeDeviceStatus(Buffer.from([0x01, 0x02])).raw, '0102');
});
