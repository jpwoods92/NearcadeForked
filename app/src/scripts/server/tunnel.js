'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const which = require('which');

const { readEnv } = require('./env.js');
const { openBrowser } = require('./network-info.js');

// ── Binary path resolver ─────────────────────────────────────────────
const FALLBACK_PATHS = {
  cloudflared: [
    path.join(os.homedir(), 'cloudflared.exe'),
    path.join(os.homedir(), 'bin', 'cloudflared.exe'),
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'cloudflared'),
    path.join(os.homedir(), 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ],
  zrok: [
    path.join(os.homedir(), 'zrok', 'zrok.exe'),
    path.join(os.homedir(), 'bin', 'zrok.exe'),
    path.join(os.homedir(), 'zrok', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok2'),
  ],
  zrok2: [path.join(os.homedir(), 'zrok', 'zrok2'), path.join(os.homedir(), 'bin', 'zrok2')],
  playit: [
    path.join(os.homedir(), 'playit.exe'),
    path.join(os.homedir(), 'bin', 'playit.exe'),
    path.join(os.homedir(), 'playit'),
    path.join(os.homedir(), 'bin', 'playit'),
  ],
  ssh: ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe', '/usr/bin/ssh'],
};

function findBinaryPath(name) {
  return which(name)
    .then((p) => p)
    .catch(() => {
      const fallbacks = FALLBACK_PATHS[name] || [];
      for (const p of fallbacks) {
        if (fs.existsSync(p)) {
          console.log(`  [tunnel] Found ${name} at fallback path: ${p}`);
          return p;
        }
      }
      return null;
    });
}

function ensureExecutable(binPath) {
  if (!binPath) return;
  // System package paths are already executable and root-owned — chmod would EPERM.
  const sysPaths = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/sbin/', '/usr/sbin/'];
  if (sysPaths.some((p) => binPath.startsWith(p))) return;
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (e) {
    console.warn('[chmod]', binPath, e.message);
  }
}

function startTunnelCloudflared(port) {
  return new Promise((resolve) => {
    findBinaryPath('cloudflared').then((cloudflaredPath) => {
      if (!cloudflaredPath) {
        resolve({ error: 'NOT_FOUND', provider: 'cloudflared' });
        return;
      }
      ensureExecutable(cloudflaredPath);

      const cfToken = readEnv('CF_TOKEN');
      if (cfToken) {
        console.log('  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Token)...');
        // Force HTTP2 to bypass UDP/QUIC blocks on Linux
        const proc = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:' + port], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const url = (readEnv('CUSTOM_URL') || 'https://your-custom-domain.com').replace(/\/$/, '') + '/?v3';
        console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + url + '\x1b[0m');
        return resolve({ url, proc });
      }

      const cfName = readEnv('CF_TUNNEL_NAME');
      if (cfName) {
        console.log('  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Locally Managed)...');
        const proc = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', cfName], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const url = (readEnv('CUSTOM_URL') || 'https://your-custom-domain.com').replace(/\/$/, '') + '/?v3';
        console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + url + '\x1b[0m');
        return resolve({ url, proc });
      }

      console.log('  \x1b[33m~\x1b[0m Starting cloudflared tunnel...');
      console.log(
        '  \x1b[31m!\x1b[0m WARNING: Free Cloudflare tunnels (trycloudflare.com) are currently heavily restricted by Cloudflare.'
      );
      console.log(
        '  \x1b[31m!\x1b[0m If your URL returns a 404 Not Found, Cloudflare has blocked the connection at their edge.'
      );
      console.log(
        '  \x1b[31m!\x1b[0m If this happens, please use Zrok instead (\x1b[36mTUNNEL=zrok node server.js\x1b[0m).'
      );

      // CRITICAL FIX: Force HTTP2 and strictly bind to 127.0.0.1 to avoid IPv6 mismatches and QUIC drops
      const proc = spawn(
        cloudflaredPath,
        ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + port],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let done = false;
      const check = (data) => {
        const m = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !done) {
          done = true;
          const url = m[0] + '/?v3';
          console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + url + '\x1b[0m');
          resolve({ url: url, proc });
        }
      };
      proc.stderr.on('data', check);

      proc.on('error', () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
      proc.on('close', () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
    });
  });
}

function startTunnelVps(port, vpsHost) {
  return new Promise((resolve) => {
    if (!vpsHost || vpsHost.trim() === '') {
      console.log('  \x1b[31m~\x1b[0m VPS Host missing. Check your .env or GUI settings.');
      return resolve(null);
    }

    findBinaryPath('ssh').then((sshPath) => {
      if (!sshPath) {
        resolve(null);
        return;
      }

      console.log(`  \x1b[33m~\x1b[0m Clearing ghost ports on VPS...`);

      const killCmd = spawn(sshPath, [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        vpsHost,
        `fuser -k ${port}/tcp || true`,
      ]);

      killCmd.on('close', () => {
        console.log(`  \x1b[33m~\x1b[0m Starting VPS Reverse SSH Tunnel to ${vpsHost}...`);

        const proc = spawn(
          sshPath,
          [
            '-v',
            '-N',
            '-T',
            '-o',
            'ExitOnForwardFailure=yes',
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'ServerAliveInterval=15',
            '-o',
            'ServerAliveCountMax=3',
            '-R',
            `0.0.0.0:${port}:127.0.0.1:${port}`,
            vpsHost,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const customEnvUrl = readEnv('CUSTOM_URL');
        let url =
          customEnvUrl && customEnvUrl.trim() !== ''
            ? customEnvUrl.trim().replace(/\/$/, '')
            : `http://${vpsHost.split('@').pop().trim()}:${port}`;

        // CRITICAL FIX: Append /?v3 for Discord Integration
        url += '/?v3';

        let done = false;

        proc.stderr.on('data', (data) => {
          const out = data.toString();
          if ((out.includes('remote forward success') || out.includes('Forwarding address')) && !done) {
            done = true;
            console.log('  \x1b[32m✓\x1b[0m VPS Tunnel URL: \x1b[1m' + url + '\x1b[0m');
            resolve({ url, proc });
          }
        });

        proc.on('error', () => {
          if (!done) {
            done = true;
            resolve(null);
          }
        });
        proc.on('close', () => {
          if (!done) {
            done = true;
            resolve(null);
          }
        });
      });
    });
  });
}

function startTunnelPlayit(port) {
  return new Promise((resolve) => {
    findBinaryPath('playit')
      .then((playitPath) => {
        if (!playitPath) {
          resolve(null);
          return;
        }
        ensureExecutable(playitPath);

        console.log('  \x1b[33m~\x1b[0m Starting playit tunnel...');
        const proc = spawn(playitPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let done = false;
        const check = (data) => {
          const str = data.toString();
          const claim = str.match(/https:\/\/playit\.gg\/claim\/[a-z0-9\-]+/i);
          if (claim) {
            console.log('  \x1b[33m!\x1b[0m playit first-run — visit: \x1b[1m' + claim[0] + '\x1b[0m');
            openBrowser(claim[0]);
          }
          const url =
            str.match(/https?:\/\/[a-z0-9\-]+\.at\.playit\.gg(?::\d+)?/i) ||
            str.match(/https?:\/\/[a-z0-9\-]+\.playit\.gg(?::\d+)?/i);
          if (url && !done) {
            done = true;
            resolve({ url: url[0], proc });
            console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + url[0] + '\x1b[0m');
          }
        };
        proc.stdout.on('data', check);
        proc.stderr.on('data', check);
        proc.on('close', () => {
          if (!done) resolve(null);
        });
        setTimeout(() => {
          if (!done) {
            done = true;
            resolve(null);
            console.log('  \x1b[33m!\x1b[0m playit timeout');
          }
        }, 45000);
      })
      .catch(() => resolve(null));
  });
}

function startTunnelLocalhostRun(port) {
  return new Promise((resolve) => {
    findBinaryPath('ssh')
      .then((sshPath) => {
        if (!sshPath) {
          resolve(null);
          return;
        }

        console.log('  \x1b[33m~\x1b[0m Starting localhost.run tunnel (SSH)...');
        const proc = spawn(
          sshPath,
          [
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'LogLevel=ERROR',
            '-o',
            'ServerAliveInterval=30',
            '-R',
            '80:localhost:' + port,
            'nokey@localhost.run',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let done = false;
        const check = (data) => {
          const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.(?:lhr\.life|localhost\.run)/);
          if (m && !done) {
            done = true;
            resolve({ url: m[0], proc });
            console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + m[0] + '\x1b[0m');
          }
        };
        proc.stdout.on('data', check);
        proc.stderr.on('data', check);
        proc.on('close', (c) => {
          if (!done) {
            resolve(null);
            console.log('  \x1b[33m!\x1b[0m localhost.run closed (code ' + c + ')');
          }
        });
        setTimeout(() => {
          if (!done) {
            done = true;
            proc.kill();
            resolve(null);
            console.log('  \x1b[33m!\x1b[0m localhost.run timeout — port 22 may be blocked');
          }
        }, 25000);
      })
      .catch(() => resolve(null));
  });
}

function startTunnelServeo(port) {
  return new Promise((resolve) => {
    findBinaryPath('ssh')
      .then((sshPath) => {
        if (!sshPath) {
          resolve(null);
          return;
        }

        console.log('  \x1b[33m~\x1b[0m Starting serveo.net tunnel (SSH)...');
        const proc = spawn(
          sshPath,
          [
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'UserKnownHostsFile=/dev/null',
            '-o',
            'LogLevel=ERROR',
            '-o',
            'ServerAliveInterval=30',
            '-R',
            '80:localhost:' + port,
            'serveo.net',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let done = false;
        const check = (data) => {
          const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.serveo\.net/);
          if (m && !done) {
            done = true;
            resolve({ url: m[0], proc });
            console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + m[0] + '\x1b[0m');
          }
        };
        proc.stdout.on('data', check);
        proc.stderr.on('data', check);
        proc.on('close', (c) => {
          if (!done) {
            resolve(null);
            console.log('  \x1b[33m!\x1b[0m serveo closed (code ' + c + ')');
          }
        });
        setTimeout(() => {
          if (!done) {
            done = true;
            proc.kill();
            resolve(null);
            console.log('  \x1b[33m!\x1b[0m serveo timeout — port 22 may be blocked');
          }
        }, 25000);
      })
      .catch(() => resolve(null));
  });
}

function startTunnelZrok(port, retries = 3) {
  return new Promise(async (resolve) => {
    const zrokPath =
      (await findBinaryPath('zrok')
        .then((p) => p)
        .catch(() => null)) ||
      (await findBinaryPath('zrok2')
        .then((p) => p)
        .catch(() => null)) ||
      (function () {
        const cfgBin = path.join(os.homedir(), '.config', 'Nearcade', 'bin');
        const candidates = [
          path.join(cfgBin, 'zrok2'),
          path.join(cfgBin, 'zrok'),
          '/usr/bin/zrok2',
          '/usr/bin/zrok',
          '/usr/local/bin/zrok',
          path.join(os.homedir(), 'bin/zrok'),
          './zrok',
          path.join(os.homedir(), 'zrok', 'zrok.exe'),
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
        return null;
      })();

    if (!zrokPath) {
      resolve({ error: 'NOT_FOUND', provider: 'zrok' });
      return;
    }
    ensureExecutable(zrokPath);

    console.log(`  \x1b[33m~\x1b[0m Starting zrok public share (${zrokPath})... (Retries left: ${retries})`);
    const args = ['share', 'public', 'http://localhost:' + port, '--backend-mode', 'proxy', '--headless'];
    const proc = spawn(zrokPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const check = (data) => {
      const out = data.toString();
      const m = out.match(/(https:\/\/)?([a-z0-9\-]+\.shares?\.zrok\.io)/i);
      if (m && !done) {
        done = true;
        const url = m[1] ? m[0] : 'https://' + m[2];
        process.env.USING_TUNNEL = 'true';
        resolve({ url, proc });
        console.log('  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m' + url + '\x1b[0m');
      }
    };
    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
    proc.on('close', (c) => {
      if (!done) {
        console.log('  \x1b[33m!\x1b[0m zrok share failed or closed (code ' + c + ')');
        if (retries > 0) {
          console.log('  \x1b[33m~\x1b[0m Retrying Zrok tunnel in 3 seconds...');
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
        }
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill();
        if (retries > 0) {
          console.log('  \x1b[33m~\x1b[0m Zrok timeout. Retrying in 3 seconds...');
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
          console.log('  \x1b[33m!\x1b[0m zrok share timeout.');
        }
      }
    }, 20000);
  }).catch(() => null);
}

async function startTunnel(port) {
  const forced = (process.env.TUNNEL || '').toLowerCase();
  if (forced === 'zrok') return startTunnelZrok(port);
  if (forced === 'vps') return startTunnelVps(port, process.env.VPS_HOST);
  if (forced === 'cloudflared') return startTunnelCloudflared(port);
  if (forced === 'playit') return startTunnelPlayit(port);
  if (forced === 'localhostrun') return startTunnelLocalhostRun(port);
  if (forced === 'serveo') return startTunnelServeo(port);
  // Auto: try cloudflared → zrok → playit → SSH providers
  const cf = await startTunnelCloudflared(port);
  if (cf) return cf;
  const z = await startTunnelZrok(port);
  if (z) return z;
  const pl = await startTunnelPlayit(port);
  if (pl) return pl;
  console.log('  \x1b[33m~\x1b[0m Trying localhost.run and serveo in parallel...');
  const ssh = await Promise.any(
    [startTunnelLocalhostRun(port), startTunnelServeo(port)].map((p) => p.then((r) => r || Promise.reject()))
  ).catch(() => null);
  if (ssh) return ssh;
  console.log('  \x1b[33m!\x1b[0m All tunnels failed. Options:');
  console.log(
    '    cloudflared  : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  );
  console.log('    serveo/lhr   : outbound SSH (port 22) may be blocked by your router/ISP');
  console.log('    TUNNEL=cloudflared  node server.js   # force a specific provider');
  return null;
}

module.exports = {
  findBinaryPath,
  ensureExecutable,
  startTunnelCloudflared,
  startTunnelVps,
  startTunnelPlayit,
  startTunnelLocalhostRun,
  startTunnelServeo,
  startTunnelZrok,
  startTunnel,
};
