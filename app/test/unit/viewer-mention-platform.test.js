import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadViewer } from '../helpers/browser-shims.js';
import { platIcon } from '../../src/scripts/chat.js';

// New pure-logic pieces added while hand-porting upstream v3.0.3 (see
// REFACTOR_PLAN.md sync phases 8-9): platform detection + badge icons for
// the chat mention/platform-badge feature, and the @-mention autocomplete's
// roster-filtering logic.

function mockNavigator({ userAgent, platform, maxTouchPoints, screenWidth, screenHeight }) {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(navigator, 'platform', { value: platform ?? '', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints ?? 0, configurable: true });
  Object.defineProperty(screen, 'width', { value: screenWidth ?? 1920, configurable: true });
  Object.defineProperty(screen, 'height', { value: screenHeight ?? 1080, configurable: true });
}

describe('detectViewerPlatform()', () => {
  let viewer;

  beforeEach(() => {
    // viewer.js also has its own top-level detectSteamDeck() IIFE that reads
    // these same navigator/screen properties at *module load* time and calls
    // document.documentElement.requestFullscreen() (unimplemented in jsdom)
    // if they look like a Steam Deck. Reset to inert values before each
    // loadViewer() so a previous test's mocked values can't leak into that
    // unrelated code path and throw.
    mockNavigator({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Test' });
    viewer = loadViewer();
  });

  it('detects mobile user agents', () => {
    mockNavigator({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' });
    expect(viewer.detectViewerPlatform()).toBe('Mobile');
  });

  it('detects a Steam Deck by platform + touch + its native 1280x800 resolution', () => {
    mockNavigator({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/Firefox',
      platform: 'Linux x86_64',
      maxTouchPoints: 1,
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(viewer.detectViewerPlatform()).toBe('Steam Deck');
  });

  it('does not misdetect a plain Linux desktop with a 1280x800 window as a Steam Deck (no touch)', () => {
    mockNavigator({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/Firefox',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(viewer.detectViewerPlatform()).toBe('Linux');
  });

  it('detects Windows', () => {
    mockNavigator({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(viewer.detectViewerPlatform()).toBe('Windows');
  });

  it('detects macOS', () => {
    mockNavigator({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    expect(viewer.detectViewerPlatform()).toBe('macOS');
  });

  it('detects Linux', () => {
    mockNavigator({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(viewer.detectViewerPlatform()).toBe('Linux');
  });

  it('falls back to empty string for an unrecognized user agent', () => {
    mockNavigator({ userAgent: 'SomeExoticBrowser/1.0' });
    expect(viewer.detectViewerPlatform()).toBe('');
  });
});

describe('platIcon()', () => {
  it('returns an SVG string for each known platform', () => {
    for (const name of ['Mobile', 'Steam Deck', 'Windows', 'macOS', 'Linux', 'PC']) {
      expect(platIcon(name)).toContain('<svg');
    }
  });

  it('returns an empty string for an unknown platform name', () => {
    expect(platIcon('Toaster')).toBe('');
  });

  it('returns an empty string for an empty/undefined name', () => {
    expect(platIcon('')).toBe('');
    expect(platIcon(undefined)).toBe('');
  });
});

describe('@-mention autocomplete (_showMentionDropdown)', () => {
  let viewer;
  let input;

  beforeEach(() => {
    // See the comment in the detectViewerPlatform() describe block above —
    // same reset, needed for the same reason.
    mockNavigator({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Test' });
    viewer = loadViewer();
    input = document.getElementById('chatMsg');
    window._rosterList = [
      { id: 'v1', name: 'Alice' },
      { id: 'v2', name: 'Alexander' },
      { id: 'v3', name: 'Bob' },
    ];
  });

  afterEach(() => {
    delete window._rosterList;
  });

  function typeAndShow(text) {
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    viewer._showMentionDropdown(input);
  }

  it('filters the roster by the partial name after "@", case-insensitively', () => {
    typeAndShow('hey @al');
    const dd = document.getElementById('mentionDD');
    expect(dd.style.display).toBe('block');
    const names = Array.from(dd.querySelectorAll('.m-item')).map((el) => el.textContent);
    expect(names).toEqual(['Alice', 'Alexander']);
  });

  it('strips a trailing " N" gamepad-slot suffix before matching', () => {
    window._rosterList = [{ id: 'v1_1', name: 'Alice 2' }];
    typeAndShow('@alice');
    const dd = document.getElementById('mentionDD');
    expect(dd.querySelector('.m-item').textContent).toBe('Alice');
  });

  it('shows "Host" plus the full roster when "@" has no partial text yet', () => {
    typeAndShow('@');
    const dd = document.getElementById('mentionDD');
    const names = Array.from(dd.querySelectorAll('.m-item')).map((el) => el.textContent);
    expect(names).toEqual(['Host', 'Alice', 'Alexander', 'Bob']);
  });

  it('hides the dropdown when nothing matches the partial text', () => {
    typeAndShow('@zzz');
    const dd = document.getElementById('mentionDD');
    // No dd is created at all the first time nothing matches.
    expect(dd === null || dd.style.display === 'none').toBe(true);
  });

  it('does not trigger on an "@" in the middle of a word', () => {
    typeAndShow('foo@bar');
    const dd = document.getElementById('mentionDD');
    expect(dd === null || dd.style.display === 'none').toBe(true);
  });

  it('_applyMention() inserts "@name " at the cursor and hides the dropdown', () => {
    typeAndShow('hey @al');
    viewer._applyMention(input, 'Alice');
    expect(input.value).toBe('hey @Alice ');
    expect(document.getElementById('mentionDD').style.display).toBe('none');
  });

  it('_hideMentionDropdown() is a no-op when no dropdown has ever been shown', () => {
    expect(() => viewer._hideMentionDropdown()).not.toThrow();
  });
});
