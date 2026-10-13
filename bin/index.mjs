#!/usr/bin/env node

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';

import { Device } from '@weejewel/samsung-mdc';
import express from 'express';
import getPort from 'get-port';
import getLocalIp from '@loxjs/node-local-ip';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import path from 'path';
import { fileURLToPath } from 'url';

import { findMdcHosts } from '../lib/discover.mjs';
import { EmdxBle } from '../lib/emdx-ble.mjs';
import { ask, askHidden } from '../lib/prompt.mjs';

/** Returns this machine's IPv4 address on the same subnet as `host`, if any. */
function localIpFor(host) {
  const toInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if (((toInt(a.address) & mask) >>> 0) === ((toInt(host) & mask) >>> 0)) return a.address;
    }
  }
  return null;
}

/**
 * The panel only displays PNG. Returns a PNG path for `image`, converting other
 * formats with macOS `sips` into a temporary file.
 */
function preparePng(image) {
  if (/\.png$/i.test(image)) return image;
  if (process.platform !== 'darwin') throw new Error('The display only accepts PNG images; please convert the image to PNG.');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emdx-png-')), 'image.png');
  execFileSync('sips', ['-s', 'format', 'png', image, '--out', out], { stdio: 'ignore' });
  return out;
}

/** Explains a failed PIN handshake. */
function pinRejected(result) {
  return result === 'AUTH_FAILED'
    ? 'The display rejected the PIN. Use the 6-digit code shown on the display right now; '
      + 'it changes each time the display enters Bluetooth pairing mode.'
    : `The display did not accept the PIN (${result}).`;
}

yargs(hideBin(process.argv))
  .command({
    command: 'show-image',
    describe: 'Show an image on Samsung EMDX display',
    builder: yargs => yargs
      .option('image', {
        type: 'string',
        describe: 'Path to the image file',
        required: true,
      })
      .option('host', {
        required: true,
        type: 'string',
        describe: 'IP address',
      })
      .option('mac', {
        required: false,
        type: 'string',
        describe: 'MAC address',
      })
      .option('pin', {
        required: true,
        type: 'string',
        describe: 'e.g. 000000',
      })
      .option('local-ip', {
        required: false,
        type: 'string',
        describe: 'Local IP address to use for the server (default: this Mac\'s address on the display\'s subnet)',
      })
      .option('timeout', {
        type: 'number',
        default: 120,
        describe: 'Seconds to wait for the display to download the image',
      }),
    handler: async (argv) => {
      const { host, mac, pin } = argv;
      const localIp = argv.localIp ?? localIpFor(host) ?? getLocalIp();
      const png = preparePng(argv.image);

      const port = await getPort({
        port: 3000,
      });

      // The panel only accepts PNG and treats `id`/`file_id` as a change token:
      // deriving it from the image bytes makes re-pushing the same picture a no-op,
      // while a new picture always gets a new file name (reused names are ignored).
      const bytes = await fs.promises.readFile(png);
      const fileId = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32).toUpperCase();
      const fileName = `${fileId}.png`;
      const createTime = new Date().toISOString().replace('T', ' ').slice(0, 19);

      console.log('🔄 Starting HTTP server...');
      await new Promise((resolve, reject) => {
        const app = express()
          .get('/content.json', (req, res) => {
            console.log('🔄 Serving /content.json...');

            res.header('Content-Type', 'application/json');
            // Samsung's parser requires every "/" escaped as "\/" and file_size as a string.
            res.send(JSON.stringify({
              schedule: [
                {
                  start_date: '1970-01-01',
                  stop_date: '2999-12-31',
                  start_time: '00:00:00',
                  contents: [
                    {
                      image_url: `http://${localIp}:${port}/${fileName}`,
                      file_id: fileId,
                      file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
                      duration: 91326, // magic constant used by Samsung's app
                      file_size: `${bytes.length}`,
                      file_name: fileName,
                    },
                  ],
                },
              ],
              name: 'node-samsung-emdx',
              version: 1,
              create_time: createTime,
              id: fileId,
              program_id: 'com.samsung.ios.ePaper',
              content_type: 'ImageContent',
              deploy_type: 'MOBILE'
            }).replaceAll('/', '\\/'));

            req.once('close', () => {
              console.log('✅ Served /content.json');
              console.log('');
            });
          })
          .get(`/${fileName}`, (req, res) => {
            console.log(`🔄 Serving the image...`);
            res.type('png').send(bytes);

            req.once('close', () => {
              console.log(`✅ Served the image; the display will now repaint (this takes a little while on e-paper)`);
              console.log('');

              process.exit(0);
            });
          })
          .listen(port, err => {
            if (err) return reject(err);
            return resolve();
          });
      });
      console.log(`✅ HTTP server listening at http://${localIp}:${port}`);
      console.log('');

      const device = new Device({
        host,
        mac,
        pin,
      });

      if (mac) {
        console.log('🔄 Waking up device...');
        await device.wakeup();
        // The panel needs a few seconds to rejoin Wi-Fi after the magic packet.
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('✅ Device woken up');
        console.log('');
      }

      console.log('🔄 Connecting...');
      await device.connect();
      console.log('✅ Connected');
      console.log('');

      const url = `http://${localIp}:${port}/content.json`;
      console.log(`🔄 Setting content to ${url}...`);
      await device.setContentDownload({ url });
      await device.disconnect();
      console.log('✅ Content set; waiting for the display to download it...');
      console.log('');

      setTimeout(() => {
        console.error(`❌ The display did not download the image within ${argv.timeout} s. `
          + 'It may be asleep (pass --mac to wake it) or unable to reach this Mac at ' + localIp + '.');
        process.exit(1);
      }, argv.timeout * 1000).unref?.();
    },
  })
  .command({
    command: 'ble-status',
    describe: 'Read a display\'s setup status over Bluetooth (macOS)',
    builder: yargs => yargs
      .option('pin', { type: 'string', describe: '6-digit PIN shown on the display' })
      .option('name', { type: 'string', default: 'EMDX', describe: 'Part of the display\'s Bluetooth name' })
      .option('debug', { type: 'boolean', default: false }),
    handler: async (argv) => {
      const pin = argv.pin ?? await ask('PIN shown on the display: ');
      const session = new EmdxBle({ nameFilter: argv.name, debug: argv.debug });
      try {
        console.log(`🔄 Connecting over Bluetooth...`);
        console.log(`✅ Connected to ${await session.connect()}`);
        const auth = await session.authorize(pin);
        if (!['SUCCESS', 'ALREADY_AUTHORIZED'].includes(auth)) throw new Error(pinRejected(auth));
        console.log('✅ PIN accepted');
        console.log('Wi-Fi network:', (await session.configuredSsid()) || '(none)');
        console.log('Network:', await session.networkAddress());
        console.log('Status:', await session.deviceStatus());
      } finally {
        await session.close();
      }
    },
  })
  .command({
    command: 'setup',
    describe: 'Join a display to your Wi-Fi over Bluetooth (macOS), like Samsung\'s E-Paper app',
    builder: yargs => yargs
      .option('pin', { type: 'string', describe: '6-digit PIN shown on the display\'s setup screen' })
      .option('ssid', { type: 'string', describe: 'Wi-Fi network name' })
      .option('name', { type: 'string', default: 'EMDX', describe: 'Part of the display\'s Bluetooth name' })
      .option('debug', { type: 'boolean', default: false }),
    handler: async (argv) => {
      const pin = argv.pin ?? await ask('PIN shown on the display: ');
      if (!/^\d{6}$/.test(pin)) throw new Error('The PIN must be the 6 digits shown on the display.');
      const ssid = argv.ssid ?? await ask('Wi-Fi network name (SSID): ');
      if (!ssid) throw new Error('A Wi-Fi network name is required.');
      // The password is never taken as an argument, so it stays out of shell history.
      const password = process.env.EMDX_WIFI_PASSWORD ?? await askHidden(`Password for "${ssid}" (hidden, leave empty for an open network): `);

      const session = new EmdxBle({ nameFilter: argv.name, debug: argv.debug });
      try {
        console.log('🔄 Connecting over Bluetooth...');
        console.log(`✅ Connected to ${await session.connect()}`);
        const auth = await session.authorize(pin);
        if (!['SUCCESS', 'ALREADY_AUTHORIZED'].includes(auth)) throw new Error(pinRejected(auth));
        console.log('✅ PIN accepted');

        await session.joinWifi(ssid, password, msg => console.log(`✅ ${msg}`));
        console.log('🔄 Waiting for the display to join the network...');
        let ip = null;
        try {
          const net = await session.waitForIp();
          if (net?.ip && net.ip !== '0.0.0.0') ip = net.ip;
        } catch (e) {
          // The display may drop Bluetooth once it switches to Wi-Fi.
          console.log(`⚠️  Bluetooth ended before the display reported its address (${e.message}).`);
        }
        if (!ip) {
          console.log('🔄 Looking for the display on this Mac\'s network (Samsung control port 1515)...');
          const hosts = await findMdcHosts();
          if (hosts.length === 1) ip = hosts[0];
          else if (hosts.length > 1) console.log(`Found several Samsung-control hosts: ${hosts.join(', ')}`);
        }
        if (!ip) {
          throw new Error('The display did not show up on the network. Check the Wi-Fi password and that this '
            + 'Mac is on the same network, then run setup again (2.4 GHz networks are the most reliable).');
        }
        console.log(`✅ Display is on Wi-Fi at ${ip}`);
        console.log('');
        console.log('Show an image with:');
        console.log(`  node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs')} show-image --host ${ip} --pin <PIN> --image <file.jpg>`);
      } finally {
        await session.close();
      }
    },
  })
  .demandCommand()
  .fail((msg, err, y) => {
    // Show usage only for argument mistakes; runtime failures get one clear line.
    if (err) console.error(`❌ ${err.message}`);
    else { y.showHelp(); console.error(`\n${msg}`); }
    process.exit(1);
  })
  .parse();