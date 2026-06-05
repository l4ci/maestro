import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult, RepoRef } from '../src/contracts/index.js';
import { WorkflowSource } from '../src/workflow/workflow-source.js';
import { slugifyProject } from '../src/workspace/paths.js';
import { FakeExec } from './helpers/fake-exec.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

const WORKFLOW =
  '---\nforge: gitlab\nproject: group/api\nbot_user: maestro-bot\n---\n# do the thing\n';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'maestro-wfsrc-'));
  dirs.push(d);
  return d;
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const ERR = (code: number, stderr = 'boom'): ExecResult => ({ code, stdout: '', stderr });

/** A fake that succeeds at init/remote/fetch and returns `show` blob (or a miss). */
function gitFake(show: ExecResult): FakeExec {
  return new FakeExec().on((c) => c.args.includes('show'), show).on(() => true, OK); // init / remote add / fetch
}

function src(cacheDir: string, fake: FakeExec, getEnv?: (k: string) => string | undefined) {
  return new WorkflowSource({
    cacheDir,
    exec: fake,
    tokenEnv: 'MAESTRO_GITLAB_TOKEN',
    getEnv: getEnv ?? (() => 'secret-xyz'),
  });
}

describe('WorkflowSource — fetch from default branch, cache locally (#5)', () => {
  it('fetches HEAD:WORKFLOW.md, writes through to the cache, returns the text', async () => {
    const cacheDir = tmpDir();
    const fake = gitFake({ code: 0, stdout: WORKFLOW, stderr: '' });
    const text = await src(cacheDir, fake).load(repo);

    expect(text).toBe(WORKFLOW);
    const cacheFile = join(cacheDir, slugifyProject(repo.project), 'WORKFLOW.md');
    expect(readFileSync(cacheFile, 'utf8')).toBe(WORKFLOW);

    // fetch targets the remote HEAD shallowly; token in env, never argv; remote URL plain
    const fetch = fake.calls.find((c) => c.args.includes('fetch'));
    expect(fetch?.args).toEqual(expect.arrayContaining(['--depth=1', 'origin', 'HEAD']));
    expect(fetch?.args.join(' ')).not.toContain('secret-xyz');
    expect(fetch?.opts?.env?.MAESTRO_GIT_TOKEN).toBe('secret-xyz');
    const remoteAdd = fake.calls.find((c) => c.args.includes('remote'));
    expect(remoteAdd?.args).toContain('https://gitlab.com/group/api.git');
    expect(remoteAdd?.args.join(' ')).not.toContain('secret-xyz');
    // reads the blob via `git show`, not a working-tree checkout
    expect(fake.calls.find((c) => c.args.includes('show'))?.args).toContain(
      'FETCH_HEAD:WORKFLOW.md',
    );
  });

  it('skips init/remote-add when the metadata repo already exists', async () => {
    const cacheDir = tmpDir();
    // first load initializes
    await src(cacheDir, gitFake({ code: 0, stdout: WORKFLOW, stderr: '' })).load(repo);
    // simulate a persisted bare repo by creating its HEAD marker
    const gitDir = join(cacheDir, slugifyProject(repo.project), '.workflow-src');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const fake = gitFake({ code: 0, stdout: WORKFLOW, stderr: '' });
    await src(cacheDir, fake).load(repo);
    expect(fake.calls.some((c) => c.args.includes('init'))).toBe(false);
    expect(fake.calls.some((c) => c.args.includes('remote'))).toBe(false);
    expect(fake.calls.some((c) => c.args.includes('fetch'))).toBe(true);
  });

  it('returns undefined when the default branch has no WORKFLOW.md (→ bootstrap)', async () => {
    const cacheDir = tmpDir();
    const text = await src(cacheDir, gitFake(ERR(128, 'path does not exist'))).load(repo);
    expect(text).toBeUndefined();
    // nothing cached when the remote authoritatively has no file
    expect(existsSync(join(cacheDir, slugifyProject(repo.project), 'WORKFLOW.md'))).toBe(false);
  });

  it('falls back to the cached copy on a transient fetch failure', async () => {
    const cacheDir = tmpDir();
    const cacheFile = join(cacheDir, slugifyProject(repo.project), 'WORKFLOW.md');
    mkdirSync(join(cacheDir, slugifyProject(repo.project)), { recursive: true });
    writeFileSync(cacheFile, WORKFLOW);

    const fake = new FakeExec()
      .on((c) => c.args.includes('fetch'), ERR(128, 'could not resolve host'))
      .on(() => true, OK);
    const text = await src(cacheDir, fake).load(repo);
    expect(text).toBe(WORKFLOW); // stale-but-present cache served
    expect(fake.calls.some((c) => c.args.includes('show'))).toBe(false); // never reached `show`
  });

  it('returns undefined on a transient fetch failure with no cache present', async () => {
    const cacheDir = tmpDir();
    const fake = new FakeExec().on((c) => c.args.includes('fetch'), ERR(128)).on(() => true, OK);
    expect(await src(cacheDir, fake).load(repo)).toBeUndefined();
  });

  it('does not rewrite the cache when the fetched content is unchanged', async () => {
    const cacheDir = tmpDir();
    const slugDir = join(cacheDir, slugifyProject(repo.project));
    const cacheFile = join(slugDir, 'WORKFLOW.md');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(cacheFile, WORKFLOW);
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(cacheFile, past, past);
    const before = statSync(cacheFile).mtimeMs;

    await src(cacheDir, gitFake({ code: 0, stdout: WORKFLOW, stderr: '' })).load(repo);
    expect(statSync(cacheFile).mtimeMs).toBe(before); // untouched → an fs.watcher stays quiet
  });

  it('overwrites the cache when the remote content changed', async () => {
    const cacheDir = tmpDir();
    const slugDir = join(cacheDir, slugifyProject(repo.project));
    const cacheFile = join(slugDir, 'WORKFLOW.md');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(cacheFile, '---\nforge: gitlab\nproject: group/api\nbot_user: old\n---\nold\n');

    const updated = WORKFLOW;
    const text = await src(cacheDir, gitFake({ code: 0, stdout: updated, stderr: '' })).load(repo);
    expect(text).toBe(updated);
    expect(readFileSync(cacheFile, 'utf8')).toBe(updated);
  });
});
