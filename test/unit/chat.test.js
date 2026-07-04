import { describe, it, expect, beforeEach } from 'vitest';
import { loadHost, loadViewer } from '../helpers/browser-shims.js';

// Characterization tests (REFACTOR_PLAN.md Phase 0) for the chat functions
// duplicated between src/scripts/host.js and src/scripts/viewer.js. These
// pin down CURRENT behavior — including the divergence between the two
// copies — so Phase 5 (extracting a shared scripts/chat.js) can be verified
// against a known-good baseline instead of guessing at intended behavior.

describe('host.js chat functions', () => {
  let host;

  beforeEach(() => {
    host = loadHost();
  });

  it('log() writes a timestamped line into #log and mirrors it into #lastLogLine', () => {
    host.log('Stream started', 'ok');
    const lines = document.getElementById('log').querySelectorAll('.ll');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('Stream started');
    expect(document.getElementById('lastLogLine').textContent).toBe('Stream started');
  });

  it('appendChat() has no dedup guard — an identical message repeated immediately appends twice', () => {
    host.appendChat('Host', 'hello', true);
    host.appendChat('Host', 'hello', true);
    const messages = document.getElementById('chatLog').querySelectorAll('.cmsg');
    expect(messages).toHaveLength(2);
  });

  it('appendChat() marks the sender\'s own messages with the "me" class', () => {
    host.appendChat('Host', 'hi there', true);
    const cname = document.querySelector('#chatLog .cname');
    expect(cname.className).toContain('me');
    expect(cname.textContent).toBe('Host');
  });

  it('sendChat() is a no-op when there is no open websocket (does not throw, does not post)', () => {
    document.getElementById('chatMsg').value = 'never sent';
    expect(() => host.sendChat()).not.toThrow();
    expect(document.getElementById('chatLog').children).toHaveLength(0);
    // Guard only clears the input on a successful send, so the draft stays.
    expect(document.getElementById('chatMsg').value).toBe('never sent');
  });
});

describe('viewer.js chat functions', () => {
  let viewer;

  beforeEach(() => {
    viewer = loadViewer();
  });

  it('appendChat() suppresses an identical "me" message repeated within 1 second', () => {
    viewer.appendChat('Guest', 'hello', true);
    viewer.appendChat('Guest', 'hello', true);
    const messages = document.getElementById('chatLog').querySelectorAll('.cmsg');
    // Unlike host.js, viewer.js's copy has a dedup guard for rapid repeats.
    expect(messages).toHaveLength(1);
  });

  it('appendChat() does not dedup messages from other people, even if text matches', () => {
    viewer.appendChat('Guest', 'hello', true);
    viewer.appendChat('Host', 'hello', false);
    const messages = document.getElementById('chatLog').querySelectorAll('.cmsg');
    expect(messages).toHaveLength(2);
  });

  it('sendChat() is a no-op when there is no open websocket (does not throw, does not post)', () => {
    document.getElementById('chatMsg').value = 'never sent';
    expect(() => viewer.sendChat()).not.toThrow();
    expect(document.getElementById('chatLog').children).toHaveLength(0);
  });
});
