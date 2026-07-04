'use strict';
const os = require('os');
const net = require('net');
const https = require('https');

const open = (...args) => import('open').then(({ default: open }) => open(...args));

function getLanIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && !n.internal) return n.address;
  return "127.0.0.1";
}

function shouldRequirePin(ip, hasTunnelHeader = false) {
  // REQ 5: Arcade Mode PIN Stripping
  if (process.argv.includes('--arcade-worker')) return false;

  if (!ip) return true;
  if (ip.startsWith('192.168.') || ip.startsWith('::ffff:192.168.')) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    if (hasTunnelHeader || process.env.USING_TUNNEL === 'true') return true;
    return false;
  }
  if (ip.startsWith('100.')) return false;
  return true;
}

function getTailscaleIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && n.address.startsWith("100.")) return n.address;
  return null;
}

function findFreePort(start) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(start, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", () => findFreePort(start + 1).then(resolve));
  });
}

function openBrowser(url) {
  open(url).catch(() => { });
}

function getPublicIP() {
  return new Promise(resolve => {
    https.get("https://api.ipify.org", res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d.trim()));
    }).on("error", () => resolve(null));
  });
}

module.exports = {
  getLanIP,
  shouldRequirePin,
  getTailscaleIP,
  findFreePort,
  openBrowser,
  getPublicIP,
};
