import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PROVIDERS, getProviderFn, getTailscaleIP } = require('../../src/scripts/server/tunnel.js');

// PROVIDERS is the single source of truth server.js's boot-time auto-start
// and http.js's /api/start-tunnel + /api/tunnels/* routes all read from —
// see tunnel.js's "Provider catalog" section. These tests guard its shape
// so a typo'd id or missing field doesn't silently break provider lookup.

describe('PROVIDERS catalog', () => {
  it('has one entry per known provider id, each with the fields the API routes expect', () => {
    const expectedIds = [
      'zrok',
      'cloudflared',
      'playit',
      'localhostrun',
      'serveo',
      'vps',
      'bore',
      'ngrok',
      'frp',
      'tailscale-funnel',
      'tailscale-serve',
      'tailscale-mesh',
      'zerotier',
      'netmaker',
      'portforward',
      'wireguard-direct',
    ];
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(expectedIds.sort());

    for (const p of PROVIDERS) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.type).toBe('string');
      expect(typeof p.category).toBe('string');
      expect(typeof p.pricing).toBe('string');
      expect(typeof p.difficulty).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(Array.isArray(p.tags)).toBe(true);
      expect(typeof p.start).toBe('function');
      expect(typeof p.detect).toBe('function');
    }
  });

  it('has no duplicate ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getProviderFn', () => {
  it('resolves a provider id to its start() function', () => {
    const zrokEntry = PROVIDERS.find((p) => p.id === 'zrok');
    expect(getProviderFn('zrok')).toBe(zrokEntry.start);
  });

  it('returns null for an unknown provider id', () => {
    expect(getProviderFn('not-a-real-provider')).toBeNull();
  });
});

describe('getTailscaleIP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first IPv4 100.x.x.x address across interfaces', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ family: 'IPv4', address: '192.168.1.5' }],
      tailscale0: [{ family: 'IPv4', address: '100.64.0.7' }],
    });
    expect(getTailscaleIP()).toBe('100.64.0.7');
  });

  it('returns null when no interface has a tailscale-range address', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ family: 'IPv4', address: '192.168.1.5' }],
      lo: [{ family: 'IPv4', address: '127.0.0.1' }],
    });
    expect(getTailscaleIP()).toBeNull();
  });
});
