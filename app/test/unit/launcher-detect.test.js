import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildUrl, PROTOCOLS, LAUNCHERS, detect, detectGames } = require('../../src/sidecar/launcher-detect.js');

describe('buildUrl', () => {
  it('builds a protocol URL for each known launcher', () => {
    expect(buildUrl('steam', 730)).toBe('steam://rungameid/730');
    expect(buildUrl('heroic', 'some-app-name')).toBe('heroic://launch/some-app-name');
  });

  it('throws for an unknown launcher id', () => {
    expect(() => buildUrl('not-a-launcher', 1)).toThrow(/Unknown launcher/);
  });
});

describe('PROTOCOLS / LAUNCHERS', () => {
  it('has a protocol entry for every launcher id', () => {
    for (const l of LAUNCHERS) {
      expect(PROTOCOLS[l.id]).toBeTruthy();
    }
  });
});

describe('detect / detectGames', () => {
  it('detect() returns an array without throwing on this platform', () => {
    expect(Array.isArray(detect())).toBe(true);
  });

  it('detectGames() returns an array (never throws, even with no launchers installed)', () => {
    const games = detectGames();
    expect(Array.isArray(games)).toBe(true);
  });
});
