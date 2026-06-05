import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeartbeatWriter, heartbeatPath, readHeartbeat } from '../src/daemon/heartbeat.js';

// The daemon writes a liveness file each tick; the SEPARATE web process reads it so a dead
// daemon stops looking like a healthy board (#40). The write must be atomic (tmp+rename) and
// the read must degrade to undefined — never throw — on a missing or corrupt file.

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'maestro-hb-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('HeartbeatWriter / readHeartbeat round-trip (#40)', () => {
  it('writes a heartbeat the reader recovers verbatim', () => {
    const root = tmp();
    const beat = {
      lastTickAt: 1_700_000_000_000,
      activeWorkers: 1,
      maxWorkers: 2,
      tickIntervalMs: 1000,
    };
    new HeartbeatWriter(root).write(beat);
    expect(readHeartbeat(root)).toEqual(beat);
  });

  it('creates the logs root on first write (fresh install with no logs/ yet)', () => {
    const root = join(tmp(), 'does', 'not', 'exist', 'yet');
    new HeartbeatWriter(root).write({
      lastTickAt: 1,
      activeWorkers: 0,
      maxWorkers: 1,
      tickIntervalMs: 1000,
    });
    expect(readHeartbeat(root)?.maxWorkers).toBe(1);
  });

  it('a later write overwrites the prior heartbeat (last tick wins)', () => {
    const root = tmp();
    const w = new HeartbeatWriter(root);
    w.write({ lastTickAt: 1, activeWorkers: 0, maxWorkers: 2, tickIntervalMs: 1000 });
    w.write({ lastTickAt: 2, activeWorkers: 2, maxWorkers: 2, tickIntervalMs: 1000 });
    const got = readHeartbeat(root);
    expect(got?.lastTickAt).toBe(2);
    expect(got?.activeWorkers).toBe(2);
  });

  it('leaves no .tmp file behind after a write (rename, not copy)', () => {
    const root = tmp();
    new HeartbeatWriter(root).write({
      lastTickAt: 1,
      activeWorkers: 0,
      maxWorkers: 1,
      tickIntervalMs: 1000,
    });
    // The atomic swap renames the tmp onto the target; only the final file remains.
    expect(() => readFileSync(`${heartbeatPath(root)}.${process.pid}.tmp`, 'utf8')).toThrow();
  });
});

describe('readHeartbeat degrades, never throws (#40)', () => {
  it('returns undefined when no heartbeat file exists (daemon never ran)', () => {
    expect(readHeartbeat(tmp())).toBeUndefined();
  });

  it('returns undefined on a corrupt (non-JSON) file', () => {
    const root = tmp();
    writeFileSync(heartbeatPath(root), 'not json at all', 'utf8');
    expect(readHeartbeat(root)).toBeUndefined();
  });

  it('returns undefined on a JSON object missing required numeric fields', () => {
    const root = tmp();
    writeFileSync(heartbeatPath(root), JSON.stringify({ lastTickAt: 'soon' }), 'utf8');
    expect(readHeartbeat(root)).toBeUndefined();
  });
});
