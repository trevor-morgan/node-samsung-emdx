/**
 * Finds Samsung displays on the local network by probing the MDC control port
 * (TCP 1515) across this Mac's own IPv4 subnets (at most a /22 per interface,
 * the size eero and many home routers use).
 * Used when Bluetooth setup could not report the display's IP address.
 */
import net from 'node:net';
import os from 'node:os';

const ipToInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

/**
 * Lists candidate host addresses on this Mac's private IPv4 subnets.
 * @param {ReturnType<typeof os.networkInterfaces>} [interfaces] for testing
 */
export function localCandidates(interfaces = os.networkInterfaces()) {
  const hosts = new Set();
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const self = ipToInt(a.address);
      // Never scan more than the /22 around our own address.
      const mask = Math.max(ipToInt(a.netmask), ipToInt('255.255.252.0')) >>> 0;
      const network = (self & mask) >>> 0;
      const size = (~mask >>> 0) + 1;
      for (let i = 1; i < size - 1; i++) {
        const h = (network + i) >>> 0;
        if (h !== self) hosts.add(intToIp(h));
      }
    }
  }
  return [...hosts];
}

/** Resolves true if a TCP connection to host:port opens within timeoutMs. */
function probe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Returns the local hosts that accept connections on the MDC port. */
export async function findMdcHosts({ port = 1515, timeoutMs = 600, concurrency = 64 } = {}) {
  const queue = localCandidates();
  const found = [];
  const worker = async () => {
    while (queue.length) {
      const host = queue.shift();
      if (await probe(host, port, timeoutMs)) found.push(host);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => ipToInt(a) - ipToInt(b));
}
