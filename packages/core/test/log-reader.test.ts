import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogLine, RepoRef } from '../src/contracts/index.js';
import { FileLogReader } from '../src/logs/file-log-reader.js';
import { slugifyProject } from '../src/workspace/paths.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmpLogs(lines?: LogLine[]): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-logs-'));
  roots.push(root);
  if (lines) {
    const dir = join(root, slugifyProject(repo.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '42.ndjson'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  return root;
}
const line = (msg: string): LogLine => ({
  ts: '2026-06-04T00:00:00Z',
  repo: 'group/api',
  issueIid: 42,
  level: 'info',
  msg,
});

describe('FileLogReader — reads the gitignored ndjson cache (OD-2)', () => {
  it('returns recorded lines for an issue in order', async () => {
    const reader = new FileLogReader(tmpLogs([line('a'), line('b'), line('c')]));
    const got = await reader.readIssueLog(repo, 42);
    expect(got.map((l) => l.msg)).toEqual(['a', 'b', 'c']);
  });

  it('honors the limit by returning the newest N', async () => {
    const reader = new FileLogReader(tmpLogs([line('a'), line('b'), line('c')]));
    const got = await reader.readIssueLog(repo, 42, 2);
    expect(got.map((l) => l.msg)).toEqual(['b', 'c']);
  });

  it('returns [] when no log file exists (no crash)', async () => {
    const reader = new FileLogReader(tmpLogs());
    expect(await reader.readIssueLog(repo, 999)).toEqual([]);
  });
});
