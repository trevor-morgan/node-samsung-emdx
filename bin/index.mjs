#!/usr/bin/env node

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Device } from '@weejewel/samsung-mdc';
import express from 'express';
import getPort from 'get-port';
import getLocalIp from '@loxjs/node-local-ip';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
  .demandCommand()
  .parse();