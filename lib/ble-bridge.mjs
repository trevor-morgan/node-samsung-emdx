/**
 * Node side of the macOS Bluetooth bridge (macos/EMDXBridge).
 *
 * macOS only grants Bluetooth to app bundles, so we launch EMDXBridge.app with
 * `open` and exchange line-based messages through two files in a temp dir:
 * we append commands to `commands.txt`, the app writes events to `events.txt`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_APP = path.join(ROOT, 'macos', 'build', 'EMDXBridge.app');

/** Turns a bridge failure event into an instruction the user can act on. */
export function explainBridgeError(event) {
  if (/Peer removed pairing information/i.test(event)) {
    return 'This Mac still holds an old Bluetooth pairing with the display, which the display has already '
      + 'discarded. Open System Settings > Bluetooth, click the (i) next to the Samsung display, choose '
      + '"Forget This Device", then run this again.';
  }
  if (event.startsWith('NOTFOUND')) {
    return 'The display was not found over Bluetooth. Wake it and put it in pairing mode (hold its '
      + 'Bluetooth button until the blue light blinks), then run this again.';
  }
  if (/permission denied/i.test(event)) {
    return 'Bluetooth access was denied. Allow EMDXBridge in System Settings > Privacy & Security > Bluetooth.';
  }
  if (/bluetooth is off/i.test(event)) return 'Bluetooth is turned off on this Mac.';
  return `Bluetooth: ${event.replace(/^ERR /, '')}`;
}

export class BleBridge {
  /**
   * @param {object} [opts]
   * @param {string} [opts.nameFilter] substring of the display's Bluetooth name
   * @param {boolean} [opts.debug] print raw bridge traffic to stderr
   */
  constructor({ nameFilter = 'EMDX', debug = false } = {}) {
    this.nameFilter = nameFilter;
    this.debug = debug;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdx-ble-'));
    this.cmdPath = path.join(this.dir, 'commands.txt');
    this.evtPath = path.join(this.dir, 'events.txt');
    this.errPath = path.join(this.dir, 'stderr.txt');
    fs.writeFileSync(this.cmdPath, '');
    fs.writeFileSync(this.evtPath, '');
    this.offset = 0;
    this.partial = '';
    this.events = [];
    this.waiters = [];
    this.listeners = new Set();
    this.exited = false;
  }

  /**
   * Launches the bridge app and resolves once it is connected to the display.
   * The generous default timeout leaves time to answer macOS's one-time
   * Bluetooth permission prompt for EMDXBridge.
   */
  async start(timeoutMs = 120000) {
    if (!fs.existsSync(BRIDGE_APP)) {
      throw new Error(`Bluetooth helper not built. Run: ${path.join(ROOT, 'scripts', 'build-macos-bridge.sh')}`);
    }
    this.proc = spawn('open', ['-W', '-n', '--stdout', this.evtPath, '--stderr', this.errPath,
      BRIDGE_APP, '--args', this.cmdPath, this.nameFilter], { stdio: 'ignore' });
    this.proc.on('exit', () => { this.exited = true; this.#poll(); });
    this.timer = setInterval(() => this.#poll(), 20);
    const ready = await this.waitFor(e => /^(READY|NOTFOUND|ERR)/.test(e), timeoutMs);
    if (!ready.startsWith('READY')) throw new Error(explainBridgeError(ready));
    const m = ready.match(/mtu=(\d+)/);
    this.mtu = m ? Number(m[1]) : 20;
    return ready;
  }

  /** Reads newly appended event lines and dispatches them. */
  #poll() {
    let data;
    try {
      const fd = fs.openSync(this.evtPath, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > this.offset) {
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        this.offset = size;
        data = buf.toString('utf8');
      }
      fs.closeSync(fd);
    } catch { return; }
    if (!data) return;
    this.partial += data;
    let nl;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, nl).trim();
      this.partial = this.partial.slice(nl + 1);
      if (!line) continue;
      if (this.debug) console.error(`  [ble] < ${line}`);
      for (const fn of this.listeners) fn(line);
      const i = this.waiters.findIndex(w => w.match(line));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(line);
      } else {
        this.events.push(line);
      }
    }
  }

  /** Resolves with the first (queued or future) event line matching `match`. */
  waitFor(match, timeoutMs = 10000) {
    const i = this.events.findIndex(match);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(this.exited ? 'Bluetooth helper exited' : 'Timed out waiting for the display'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Subscribes to every incoming event line; returns an unsubscribe function. */
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #send(line) {
    if (this.debug) console.error(`  [ble] > ${line}`);
    fs.appendFileSync(this.cmdPath, `${line}\n`);
  }

  /** Enables indications/notifications on a characteristic. */
  async subscribe(uuid) {
    this.#send(`sub ${uuid}`);
    const e = await this.waitFor(l => l.startsWith(`SUB ${uuid.toUpperCase()}`) || l.startsWith('ERR'));
    if (!e.endsWith(' ok')) throw new Error(`Bluetooth subscribe failed: ${e}`);
  }

  /** Writes bytes (with response) and waits for the write acknowledgement. */
  async write(uuid, bytes) {
    this.#send(`write ${uuid} ${Buffer.from(bytes).toString('hex')}`);
    const e = await this.waitFor(l => l.startsWith(`WROTE ${uuid.toUpperCase()}`) || l.startsWith('ERR'));
    if (!e.endsWith(' ok')) throw new Error(`Bluetooth write failed: ${e}`);
  }

  /** Disconnects and stops the helper app (killing it if it does not exit). */
  async close() {
    if (!this.exited) {
      this.#send('quit');
      await this.waitFor(l => l.startsWith('DISCONNECTED'), 5000).catch(() => {});
      // After disconnecting, the helper removes the session's Bluetooth bond
      // before exiting; give it time to finish.
      await new Promise(resolve => {
        if (this.exited || !this.proc) return resolve();
        const t = setTimeout(resolve, 5000);
        this.proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    if (!this.exited) {
      // e.g. still waiting on the macOS Bluetooth permission prompt
      spawnSync('pkill', ['-f', `EMDXBridge ${this.cmdPath}`]);
    }
    clearInterval(this.timer);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
