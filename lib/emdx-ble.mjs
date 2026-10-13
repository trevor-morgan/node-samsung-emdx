/**
 * Samsung EMDX e-paper Bluetooth setup protocol (the "SVCDeviceSetting" GATT
 * service used by Samsung's E-Paper app), reimplemented from the app's
 * com.samsung.android.ePaper.data.ble package.
 *
 * Frame layout (both directions):
 *   byte 0   (id << 6) | (fragment << 5) | (more << 4) | (op << 1) | (len >> 8)
 *   byte 1   len & 0xff            len = 1 (command id) + payload length
 *   byte 2   command id
 *   byte 3.. payload
 */
import bcrypt from 'bcryptjs';

import { BleBridge } from './ble-bridge.mjs';

export const SERVICE_UUID = '53564344-6576-6963-6553-657474696E67'; // "SVCDeviceSetting"
export const COMMAND_CHAR_UUID = '434D4444-6576-6963-6553-657474696E67'; // "CMDDeviceSetting"

/** BLEOpType */
export const Op = {
  REQUEST_WITH_RESPONSE: 0,
  REQUEST_RESPONSE: 1,
  CONTROL: 2,
  CONTROL_RESPONSE: 3,
  REQUEST_WITHOUT_RESPONSE: 4,
  AUTHORIZATION: 7,
};

/** BLECommandConstant */
export const Cmd = {
  START_AUTHORIZE: 1,
  CONFIRM_AUTHORIZE: 2,
  QUERY_AUTHORIZE: 3,
  ANSWER_AUTHORIZE: 4,
  DEVICE_STATUS: 16,
  NETWORK_TYPE: 17,
  NETWORK_ACCESS: 18,
  NETWORK_ACCESS_V6: 19,
  WIFI: 20,
  SCAN_ACCESS_POINT: 21,
  CLEAR_SAVED_ACCESS_POINT: 22,
  POE_ACTIVATION: 24,
  WIRED_AVAILABLE: 25,
};

/** AuthResultResponseBLE */
export const AuthResult = {
  0: 'SUCCESS',
  1: 'ALREADY_AUTHORIZED',
  128: 'DENIED',
  129: 'INVALID_SEQ',
  130: 'AUTH_FAILED',
  255: 'NO_RESPONSE',
};

/** Builds one unfragmented frame (PDU.f in the app). */
export function buildFrame({ op, cmd, payload = [], id = 0, fragment = 0, more = 0 }) {
  const data = Buffer.from(payload);
  const len = 1 + data.length;
  if (len > 0x1ff) throw new Error('payload too large for a single frame');
  const header = Buffer.from([
    ((id & 3) << 6) | ((fragment & 1) << 5) | ((more & 1) << 4) | ((op & 7) << 1) | ((len >> 8) & 1),
    len & 0xff,
  ]);
  return Buffer.concat([header, Buffer.from([cmd & 0xff]), data]);
}

/** StatusResponseBLE (status byte of non-authorization replies). */
export const Status = {
  0: 'SUCCESS',
  33: 'ERROR',
  36: 'PID_EXISTS',
  37: 'NOT_SUPPORTED',
  38: 'INVALID_DATA',
  39: 'API_ERROR',
  41: 'FRAGMENT_ERROR',
  63: 'COMMAND_DEFINED_ERROR',
};

/**
 * Parses a normal (non-authorization) reply:
 * [hdr0][hdr1][status & 0x3f][command id][data...].
 */
export function parseReply(bytes) {
  const b = Buffer.from(bytes);
  return { status: b[2] & 0x3f, cmd: b[3], data: b.subarray(4), raw: b };
}

/** Encodes the Wi-Fi credentials payload (WifiAccessPointCommand.Set). */
export function encodeWifi(ssid, password = '') {
  const ssidB = Buffer.from(ssid, 'utf8');
  const pwB = Buffer.from(password, 'utf8');
  if ([...ssid].length > 32 || ssidB.length > 63) throw new Error('SSID must be at most 32 characters');
  if ([...password].length > 64 || pwB.length > 255) throw new Error('Password must be at most 64 characters');
  if (!pwB.length) return Buffer.concat([Buffer.from([ssidB.length & 0x3f]), ssidB]);
  return Buffer.concat([Buffer.from([0x40 | (ssidB.length & 0x3f)]), ssidB, Buffer.from([pwB.length]), pwB]);
}

/** Decodes a NetworkAddress reply: mode/CIDR byte, then IP, gateway, DNS. */
export function decodeNetworkAddress(d) {
  const ip = o => (d.length >= o + 4 ? [...d.subarray(o, o + 4)].join('.') : null);
  return {
    dhcp: Boolean(d[0] & 0x80),
    autoDns: Boolean(d[0] & 0x40),
    prefix: d[0] & 0x3f,
    ip: ip(1),
    gateway: ip(5),
    dns: ip(9),
  };
}

/** Decodes the 1-byte DeviceStatus reply bit field. */
export function decodeDeviceStatus(d) {
  const b = d.length === 1 ? d[0] : 0;
  return {
    raw: d.toString('hex'),
    networkType: (b >> 7) & 1,
    bit6Connected: (b >> 6) & 1, // the app's naming of this bit is contradictory
    gateway: (b >> 5) & 1,
    internet: (b >> 4) & 1,
    wifiActivation: (b >> 3) & 1,
    setupDone: b & 1,
  };
}

/** Splits a received frame into its header fields, command id and payload. */
export function parseFrame(bytes) {
  const b = Buffer.from(bytes);
  const len = ((b[0] & 1) << 8) | b[1];
  return {
    id: b[0] >> 6,
    fragment: (b[0] >> 5) & 1,
    more: (b[0] >> 4) & 1,
    op: (b[0] >> 1) & 7,
    len,
    cmd: b[2],
    payload: b.subarray(3, 2 + len),
    raw: b,
  };
}

const BCRYPT_B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** bcrypt's base64 variant (encode raw bytes; used for the 16-byte salt). */
export function bcryptB64Encode(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += BCRYPT_B64[(acc >> bits) & 63];
    }
  }
  if (bits > 0) out += BCRYPT_B64[(acc << (6 - bits)) & 63];
  return out;
}

/** bcrypt's base64 variant decode (the app's `z()` helper). */
export function bcryptB64Decode(str) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of str) {
    acc = ((acc << 6) | BCRYPT_B64.indexOf(ch)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * Answer to the display's authorization challenge: bcrypt(PIN, salt, cost),
 * keep the 31-character hash part, decode it to 23 bytes.
 */
export function authDigest(pin, cost, salt) {
  if (salt.length !== 16) throw new Error(`unexpected salt length ${salt.length}`);
  const setting = `$2b$${String(cost).padStart(2, '0')}$${bcryptB64Encode(salt).slice(0, 22)}`;
  const hash = bcrypt.hashSync(String(pin), setting);
  return bcryptB64Decode(hash.slice(-31));
}

/** A Bluetooth session with one EMDX display. */
export class EmdxBle {
  constructor({ nameFilter, debug = false } = {}) {
    this.bridge = new BleBridge({ nameFilter, debug });
    this.debug = debug;
  }

  /**
   * Connects and enables indications on the command characteristic. The
   * display's characteristic has no CCCD descriptor (Samsung's app only enables
   * indications locally), so a failed subscription is expected and ignored.
   * Outside Bluetooth pairing mode the display only exposes its OCF service, so
   * a missing setup service gets an actionable error.
   */
  async connect() {
    const ready = await this.bridge.start();
    const services = (ready.match(/services=(\S*)/)?.[1] ?? '').split(',');
    if (!services.includes(SERVICE_UUID)) {
      throw new Error('The display is not in Bluetooth pairing mode (its setup service is missing). '
        + 'Hold the Bluetooth button on the display until the blue light blinks, then run this again.');
    }
    await this.bridge.subscribe(COMMAND_CHAR_UUID).catch(e => {
      if (this.debug) console.error(`  [ble] subscribe skipped: ${e.message}`);
    });
    return ready.replace(/^READY /, '').replace(/ services=\S*/, '');
  }

  /** Waits for the next indication on the command characteristic. */
  async nextFrame(timeoutMs = 10000) {
    const line = await this.bridge.waitFor(l => l.startsWith(`RX ${COMMAND_CHAR_UUID}`), timeoutMs);
    return parseFrame(Buffer.from(line.split(' ')[2], 'hex'));
  }

  /** Sends one frame and returns the first reply frame. */
  async request(frame, timeoutMs = 10000) {
    await this.bridge.write(COMMAND_CHAR_UUID, frame);
    return this.nextFrame(timeoutMs);
  }

  /**
   * Runs the PIN challenge/response. Returns the AuthResult name; 'SUCCESS'
   * or 'ALREADY_AUTHORIZED' mean the session may send settings commands.
   */
  async authorize(pin) {
    const start = await this.request(buildFrame({ op: Op.AUTHORIZATION, cmd: Cmd.START_AUTHORIZE }));
    if (start.payload.length === 1) return AuthResult[start.payload[0]] ?? `UNKNOWN(${start.payload[0]})`;
    const version = (start.payload[0] >> 5) & 7;
    const cost = start.payload[0] & 31;
    const salt = start.payload.subarray(1);
    if (this.debug) console.error(`  [auth] version=${version} cost=${cost} salt=${salt.toString('hex')}`);
    const digest = authDigest(pin, cost, salt);
    const answer = await this.request(buildFrame({ op: Op.AUTHORIZATION, cmd: Cmd.ANSWER_AUTHORIZE, payload: digest }));
    const code = answer.payload[0];
    return AuthResult[code] ?? `UNKNOWN(${code})`;
  }

  /**
   * Sends a settings command (op REQUEST_WITH_RESPONSE) and returns the reply
   * data. Throws with the display's status name when it is not SUCCESS.
   */
  async command(cmd, payload = [], timeoutMs = 20000) {
    await this.bridge.write(COMMAND_CHAR_UUID, buildFrame({ op: Op.REQUEST_WITH_RESPONSE, cmd, payload }));
    for (;;) {
      const line = await this.bridge.waitFor(l => l.startsWith(`RX ${COMMAND_CHAR_UUID}`), timeoutMs);
      const reply = parseReply(Buffer.from(line.split(' ')[2], 'hex'));
      if (this.debug) console.error(`  [cmd 0x${cmd.toString(16)}] status=${reply.status} data=${reply.data.toString('hex')}`);
      if (reply.cmd !== cmd) continue; // stray reply to an earlier command
      if (reply.status !== 0) {
        const err = new Error(`Display rejected command 0x${cmd.toString(16)}: ${Status[reply.status] ?? reply.status}`);
        err.status = reply.status;
        throw err;
      }
      return reply.data;
    }
  }

  async deviceStatus() { return decodeDeviceStatus(await this.command(Cmd.DEVICE_STATUS)); }

  async networkAddress() { return decodeNetworkAddress(await this.command(Cmd.NETWORK_ACCESS)); }

  /** Returns the SSID currently configured on the display ('' if none). */
  async configuredSsid() {
    const d = await this.command(Cmd.WIFI);
    const n = d.length ? d[0] & 0x3f : 0;
    return d.subarray(1, 1 + n).toString('utf8');
  }

  async poeEnabled() {
    const d = await this.command(Cmd.POE_ACTIVATION);
    return d[0] !== 0;
  }

  /**
   * Joins a Wi-Fi network using DHCP, mirroring the app's onboarding order:
   * PoE off, wait 3 s, network type Wi-Fi, credentials, DHCP.
   */
  async joinWifi(ssid, password, log = () => {}) {
    try {
      await this.command(Cmd.POE_ACTIVATION, [0]);
      log('Wired (PoE) mode off');
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      log(`PoE setting skipped (${e.message})`);
    }
    await this.command(Cmd.NETWORK_TYPE, [1]);
    log('Network type set to Wi-Fi');
    // The display may only answer once it has tried the network, so allow a minute.
    await this.command(Cmd.WIFI, encodeWifi(ssid, password), 60000);
    log(`Wi-Fi credentials sent for "${ssid}"`);
    const d = await this.command(Cmd.NETWORK_ACCESS, [0xc0, ...new Array(12).fill(0)], 60000);
    log('Automatic IP address (DHCP) selected');
    return decodeNetworkAddress(d);
  }

  /** Polls the display's IPv4 address until it is non-zero or time runs out. */
  async waitForIp(timeoutMs = 90000, intervalMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.networkAddress();
      if (last.ip && last.ip !== '0.0.0.0') return last;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return last;
  }

  async close() {
    await this.bridge.close();
  }
}
