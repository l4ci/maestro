// M8 Part C — self-managed wrapper (§12). The maestro repo watches itself via one
// seeded watchlist entry; a config-edit MR, once merged, is picked up by the EXISTING
// validate-before-reload store (M1 ConfigStore + M5 WatchedConfig). No admin path, no
// privileged mutation — these tests compose already-built units and prove the path.

import { describe, expect, it, vi } from 'vitest';
import { ConfigStore, parseConfig } from '../src/config/load-config.js';
import type { Logger } from '../src/daemon/ports.js';
import { WatchedConfig, deriveWatchSet } from '../src/daemon/reload.js';

// A self-watch seed: maestro is in its own watchlist (the §12 entry).
const SELF_WATCH = `defaults:
  bot_user: maestro-bot
  concurrency:
    global_max: 2
forges:
  github:
    host: github.com
    token_env: MAESTRO_GITHUB_TOKEN
repos:
  - url: github.com/maestro-org/maestro
`;

function store(text = SELF_WATCH): ConfigStore {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error}`);
  return new ConfigStore(parsed.value);
}

function fakeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// --- Slice 7: merged config edit is picked up by hot-reload ----------------

describe('Slice 7 — a merged config edit is loaded by validate-before-reload', () => {
  it('appending a repo (the agent edits config, human merges) extends the watch set', () => {
    const log = fakeLog();
    const watched = new WatchedConfig(store(), log);
    expect(watched.watchSet.map((r) => r.url)).toEqual(['github.com/maestro-org/maestro']);

    const merged = `${SELF_WATCH}  - url: github.com/org/new-service\n`;
    expect(watched.reload(merged)).toBe(true);

    expect(watched.watchSet.map((r) => r.url)).toEqual([
      'github.com/maestro-org/maestro',
      'github.com/org/new-service',
    ]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('bumping concurrency.global_max is reflected in the current config (M5 slot source)', () => {
    const watched = new WatchedConfig(store(), fakeLog());
    const bumped = SELF_WATCH.replace('global_max: 2', 'global_max: 5');
    expect(watched.reload(bumped)).toBe(true);
    expect(watched.config.defaults.concurrency.global_max).toBe(5);
  });

  it('the reload entry point is the same ConfigStore.reload any file-watch event drives', () => {
    const s = store();
    const before = s.current.repos.length;
    const r = s.reload(`${SELF_WATCH}  - url: github.com/org/extra\n`);
    expect(r.ok).toBe(true);
    expect(s.current.repos.length).toBe(before + 1);
    expect(deriveWatchSet(s.current).map((x) => x.url)).toContain('github.com/org/extra');
  });
});

// --- Slice 8: validate-before-reload rejects a bad merge, daemon survives ---

describe('Slice 8 — a malformed merged config is rejected; last-good survives', () => {
  it('a negative concurrency is rejected, config unchanged, error logged (no throw)', () => {
    const log = fakeLog();
    const watched = new WatchedConfig(store(), log);
    const bad = SELF_WATCH.replace('global_max: 2', 'global_max: -1');

    // The §12 safety claim: a self-managed bad merge must NOT brick the daemon.
    expect(() => watched.reload(bad)).not.toThrow();
    expect(watched.reload(bad)).toBe(false);
    expect(watched.config.defaults.concurrency.global_max).toBe(2); // last-good intact
    expect(log.error).toHaveBeenCalled();
  });

  it('a missing required field is rejected and the watch set is unchanged', () => {
    const watched = new WatchedConfig(store(), fakeLog());
    const bad = 'forges: {}\nrepos: []\n'; // no defaults.bot_user
    expect(watched.reload(bad)).toBe(false);
    expect(watched.watchSet.map((r) => r.url)).toEqual(['github.com/maestro-org/maestro']);
  });
});
