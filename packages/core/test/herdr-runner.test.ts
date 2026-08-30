import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Exec,
  ExecOptions,
  ExecResult,
  RunnerInput,
  SpawnHandle,
} from '../src/contracts/index.js';
import { HerdrRunner } from '../src/runner/herdr-runner.js';
import { FakeExec } from './helpers/fake-exec.js';

// --- fixtures ------------------------------------------------------------------
//
// FakeExec.on() matches the FIRST registered predicate that returns true (see
// helpers/fake-exec.ts) — so a test that needs to OVERRIDE a call's response (fail
// once then succeed, or fail every time) registers its own matcher for that call BEFORE
// any catch-all. `baseFake()` therefore only wires the calls NO test ever overrides:
// workspace resolution, the per-run orphan precheck, tab create, and teardown. Every
// other call (`agent start`, the dispatch `agent prompt --wait`, `agent wait`, `agent
// read`) is wired per-test.

function ok(result: unknown = {}): ExecResult {
  return { code: 0, stdout: JSON.stringify({ result }), stderr: '' };
}
function err(code: string, message = 'boom'): ExecResult {
  // verified live: herdr prints error JSON to STDERR (success JSON goes to stdout)
  return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code, message } }) };
}
/** Verified `agent wait` success envelope: the agent row nested under `agent`. */
function waitInfo(agentStatus: string): ExecResult {
  return ok({ agent: { agent_status: agentStatus }, type: 'agent_info' });
}
/** `agent read` prints raw terminal text to stdout — no JSON envelope (verified). */
function readOut(text: string): ExecResult {
  return { code: 0, stdout: text, stderr: '' };
}

const WS_ID = 'ws-1';
const PANE_ID = 'pane-1';
const TAB_ID = 'tab-1';

function tabCreatedResult(): ExecResult {
  return ok({
    root_pane: { pane_id: PANE_ID, tab_id: TAB_ID },
    tab: { tab_id: TAB_ID },
    type: 'tab_created',
  });
}

function baseFake(): FakeExec {
  return new FakeExec()
    .on(
      (c) => c.args[0] === 'workspace' && c.args[1] === 'list',
      ok({ workspaces: [{ workspace_id: WS_ID, label: 'maestro' }] }),
    )
    .on((c) => c.args[0] === 'pane' && c.args[1] === 'list', ok({ panes: [] }))
    .on((c) => c.args[0] === 'tab' && c.args[1] === 'create', tabCreatedResult())
    .on((c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('/exit'), ok({}))
    .on((c) => c.args[0] === 'tab' && c.args[1] === 'close', ok({ type: 'ok' }));
}

/** Adds a happy-path `agent start` + dispatch (`agent prompt --wait`) on top of a base
 *  fake, for tests that don't care about either and just need to reach the poll loop. */
function withHappyStartAndDispatch(fake: FakeExec): FakeExec {
  return fake
    .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
    .on(
      (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
      ok({}),
    );
}

const isPollWait = (c: { args: string[] }) =>
  c.args[0] === 'agent' && c.args[1] === 'wait' && !c.args.includes('--until');

/** Wraps a FakeExec to write .maestro/result.json — reading the nonce back out of
 *  .maestro/prompt.md, since HerdrRunner mints it internally — the instant the dispatch
 *  call fires. Stands in for "the fake agent did its work and reported status". */
class DispatchWritesResult implements Exec {
  constructor(
    private readonly inner: FakeExec,
    private readonly workspaceDir: string,
    private readonly write: (nonce: string) => void,
  ) {}

  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (args[0] === 'agent' && args[1] === 'prompt' && args.includes('--wait')) {
      const promptText = readFileSync(join(this.workspaceDir, '.maestro', 'prompt.md'), 'utf8');
      const nonce = /nonce":"([0-9a-f-]{36})"/.exec(promptText)?.[1] ?? '';
      this.write(nonce);
    }
    return this.inner.run(cmd, args, opts);
  }
  stream(
    cmd: string,
    args: string[],
    opts: ExecOptions & { onLine: (line: string) => void },
  ): Promise<ExecResult> {
    return this.inner.stream(cmd, args, opts);
  }
  spawn(cmd: string, args: string[], opts?: ExecOptions): SpawnHandle {
    return this.inner.spawn(cmd, args, opts);
  }
  attach(cmd: string, args: string[], opts?: ExecOptions): Promise<number> {
    return this.inner.attach(cmd, args, opts);
  }
}

function input(over: Partial<RunnerInput> = {}): RunnerInput {
  return {
    workspaceDir: '/unused', // overridden per-test with a real tmpdir
    promptBody: '# Agent operating protocol\nwork the next item',
    context: {
      issue: {
        iid: 42,
        id: '9042',
        title: 'Add OAuth',
        body: 'do it',
        state: 'open',
        assignees: [],
        labels: [],
        author: { username: 'r', id: '2' },
        webUrl: 'u',
      },
      recentComments: [],
    },
    claude: {
      command: 'claude',
      maxTurns: 40,
      permissionMode: 'acceptEdits',
      runTimeoutMs: 60_000,
    },
    ...over,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
});

/** Real tmpdir workspace with `.git/info/` seeded (workspace-manager.test.ts pattern). */
function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-herdr-'));
  roots.push(dir);
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  return dir;
}

function writesDone(fake: FakeExec, ws: string): DispatchWritesResult {
  return new DispatchWritesResult(fake, ws, (nonce) => {
    writeFileSync(
      join(ws, '.maestro', 'result.json'),
      JSON.stringify({ status: 'done', summary: 'ok', nonce }),
    );
  });
}

// --- HR-1: happy path ------------------------------------------------------------

describe('HR-1 — happy path: full argv sequence, call order, teardown', () => {
  it('resolves the workspace, creates a tab, starts + dispatches, reads the result, tears down', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake()).on(isPollWait, waitInfo('done'));
    const exec = new DispatchWritesResult(fake, ws, (nonce) => {
      writeFileSync(
        join(ws, '.maestro', 'result.json'),
        JSON.stringify({ status: 'done', summary: 'Implemented OAuth', nonce }),
      );
    });
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result).toEqual({ status: 'done', summary: 'Implemented OAuth' });

    const shape = fake.calls.map((c) => [c.args[0], c.args[1]]);
    expect(shape).toEqual([
      ['workspace', 'list'],
      ['pane', 'list'], // per-run orphan precheck
      ['tab', 'create'],
      ['agent', 'start'],
      ['agent', 'prompt'], // dispatch
      ['agent', 'wait'], // poll
      ['agent', 'prompt'], // teardown /exit
      ['tab', 'close'], // teardown
    ]);

    const tabCreateCall = fake.calls.find((c) => c.args[0] === 'tab' && c.args[1] === 'create');
    expect(tabCreateCall?.args).toEqual(
      expect.arrayContaining([
        '--workspace',
        WS_ID,
        '--cwd',
        ws,
        '--label',
        expect.stringMatching(/^m-/),
      ]),
    );

    // dispatch waits for a SUBMISSION ack (--until working), not turn completion — the
    // default idle|done|blocked match outruns the ack timeout on any real turn
    const dispatchCall = fake.calls.find(
      (c) => c.args[1] === 'prompt' && c.args.includes('--wait'),
    );
    expect(dispatchCall?.args.join(' ')).toContain('--until working');

    // result.json is consumed (deleted) after a successful parse
    expect(existsSync(join(ws, '.maestro', 'result.json'))).toBe(false);
    // .maestro/ is git-excluded idempotently
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toContain('.maestro/');
  });

  it('name charset is sanitized to lowercase [a-z0-9-], capped at 48 chars', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake()).on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });
    await runner.run(input({ workspaceDir: ws }));

    const startCall = fake.calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'start');
    const name = startCall?.args[2] ?? '';
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(48);
  });
});

// --- HR-2: result file missing → scrape fallback ---------------------------------

describe('HR-2 — result file missing falls back to scraping the pane transcript', () => {
  it('recovers a status via agent read when .maestro/result.json was never written', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake())
      .on(isPollWait, waitInfo('idle'))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'read',
        readOut('{"status":"needs_input","summary":"Which DB?"}'),
      );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result).toEqual({ status: 'needs_input', summary: 'Which DB?' });
  });
});

// --- HR-3: malformed / nonce-mismatched result file -------------------------------

describe('HR-3 — a malformed or nonce-mismatched result file is treated as missing', () => {
  it('malformed JSON in result.json → falls to the scrape fallback → in_progress', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake())
      .on(isPollWait, waitInfo('idle'))
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'read', readOut('no status here'));
    const exec = new DispatchWritesResult(fake, ws, () => {
      writeFileSync(join(ws, '.maestro', 'result.json'), 'not json {{{');
    });
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
  });

  it('a wrong nonce is treated as missing, never trusted', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake())
      .on(isPollWait, waitInfo('idle'))
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'read', readOut('still nothing'));
    const exec = new DispatchWritesResult(fake, ws, () => {
      writeFileSync(
        join(ws, '.maestro', 'result.json'),
        JSON.stringify({ status: 'done', summary: 'sneaky', nonce: 'wrong-nonce-value' }),
      );
    });
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
    expect(result.summary).not.toBe('sneaky');
  });
});

// --- HR-4: poll ceiling ------------------------------------------------------------

describe('HR-4 — poll ceiling exceeded → in_progress, teardown still ran', () => {
  it('a run-timeout slice that only ever times out degrades safely and tears down', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake()).on(
      isPollWait,
      err('timeout', 'timed out waiting for agent status'),
    );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(
      input({ workspaceDir: ws, claude: { ...input().claude, runTimeoutMs: 40 } }),
    );
    expect(result.status).toBe('in_progress');
    expect(result.summary).toMatch(/run-timeout|ceiling/i);

    expect(
      fake.calls.some(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('/exit'),
      ),
    ).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === 'tab' && c.args[1] === 'close')).toBe(true);
  });
});

// --- HR-5: agent_not_ready trust-dialog recovery + exhaustion --------------------

describe('HR-5 — agent_not_ready (folder-trust dialog) recovery', () => {
  it('nudges the dialog (down+enter — Enter alone would pick "No, exit") and proceeds WITHOUT restarting', async () => {
    const ws = tmpWorkspace();
    const fake = baseFake()
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'start',
        err('agent_not_ready', 'blocked during startup'),
      )
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'send-keys', ok({ type: 'ok' }))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'wait' && c.args.includes('--until'),
        waitInfo('idle'),
      )
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        ok({}),
      )
      .on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('done');

    // the agent is already registered under its name after agent_not_ready — a restart
    // would only hit agent_name_taken, so exactly ONE start ever fires
    const starts = fake.calls.filter((c) => c.args[0] === 'agent' && c.args[1] === 'start');
    expect(starts).toHaveLength(1);
    const nudge = fake.calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'send-keys');
    expect(nudge?.args.slice(-2)).toEqual(['down', 'enter']);
  });

  it('a nudge that never reaches idle → in_progress, teardown still ran', async () => {
    const ws = tmpWorkspace();
    const fake = baseFake()
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'start',
        err('agent_not_ready', 'blocked during startup'),
      )
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'send-keys', ok({ type: 'ok' }))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'wait' && c.args.includes('--until'),
        err('timeout', 'timed out waiting for agent status'),
      );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
    expect(result.summary).toMatch(/startup dialog/);
    expect(fake.calls.some((c) => c.args[0] === 'tab' && c.args[1] === 'close')).toBe(true);
  });

  it('agent_pane_not_found (fresh-tab pane registration race) backs off and retries the start', async () => {
    const ws = tmpWorkspace();
    let startAttempts = 0;
    const fake = baseFake()
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'start' && startAttempts++ < 2,
        err('agent_pane_not_found', `agent target pane ${PANE_ID} not found`),
      )
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        ok({}),
      )
      .on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('done');
    const starts = fake.calls.filter((c) => c.args[0] === 'agent' && c.args[1] === 'start');
    expect(starts).toHaveLength(3); // two raced rejections + the one that landed
  });

  it('agent_name_taken naming OUR OWN pane means the agent is already live — success', async () => {
    const ws = tmpWorkspace();
    const fake = baseFake()
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'start',
        err('agent_name_taken', `already used; candidates: pane_id=${PANE_ID} status=Idle`),
      )
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        ok({}),
      )
      .on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('done');
  });
});

// --- HR-6: agent_blocked on dispatch ----------------------------------------------

describe('HR-6 — agent_blocked on dispatch never maps to needs_input', () => {
  it('degrades to in_progress (herdr blocked ≠ agent needs_input, §10)', async () => {
    const ws = tmpWorkspace();
    const fake = baseFake()
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        err('agent_blocked', 'nothing sent'),
      );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
  });
});

// --- HR-7: duplicate name → sweep + retry -----------------------------------------

describe('HR-7 — agent_name_taken by a FOREIGN pane re-sweeps stale tabs and retries', () => {
  it('closes the stale tab but NEVER the current run’s own tab, then completes', async () => {
    const ws = tmpWorkspace();
    let startAttempts = 0;
    let paneLists = 0;
    const ownPane = { pane_id: PANE_ID, tab_id: TAB_ID, workspace_id: WS_ID, cwd: ws };
    const stalePane = { pane_id: 'pane-stale', tab_id: 'tab-stale', workspace_id: WS_ID, cwd: ws };
    const fake = new FakeExec()
      .on(
        (c) => c.args[0] === 'workspace' && c.args[1] === 'list',
        ok({ workspaces: [{ workspace_id: WS_ID, label: 'maestro' }] }),
      )
      // precheck (before the tab exists) sees nothing; the mid-run re-sweep sees BOTH
      // our own live pane and a stale one on the same cwd
      .on(
        (c) => c.args[0] === 'pane' && c.args[1] === 'list' && paneLists++ === 0,
        ok({ panes: [] }),
      )
      .on((c) => c.args[0] === 'pane' && c.args[1] === 'list', ok({ panes: [ownPane, stalePane] }))
      .on((c) => c.args[0] === 'tab' && c.args[1] === 'create', tabCreatedResult())
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'start' && startAttempts++ === 0,
        err('agent_name_taken', 'already used; candidates: pane_id=pane-stale status=Idle'),
      )
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        ok({}),
      )
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('/exit'),
        ok({}),
      )
      .on(isPollWait, waitInfo('idle'))
      .on((c) => c.args[0] === 'tab' && c.args[1] === 'close', ok({ type: 'ok' }));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('done');

    const closes = fake.calls
      .filter((c) => c.args[0] === 'tab' && c.args[1] === 'close')
      .map((c) => c.args[2]);
    expect(closes).toContain('tab-stale'); // the stale tab was swept
    // our own tab is closed exactly once — by teardown, never by the mid-run sweep
    expect(closes.filter((id) => id === TAB_ID)).toHaveLength(1);
  });
});

// --- HR-8: mid-sequence throw still tears down ------------------------------------

describe('HR-8 — an unexpected throw mid-sequence still tears down (finally)', () => {
  it('a filesystem failure before the tab exists still calls teardown, never a tab close', async () => {
    const ws = tmpWorkspace();
    // Force mkdirSync(.maestro, {recursive:true}) to throw ENOTDIR: a FILE sits where the
    // directory needs to go.
    writeFileSync(join(ws, '.maestro'), 'not a directory');

    const fake = baseFake();
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
    expect(
      fake.calls.some(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('/exit'),
      ),
    ).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === 'tab' && c.args[1] === 'close')).toBe(false); // no tab was ever created
  });
});

// --- HR-9: rate-limit text in scrape -----------------------------------------------

describe('HR-9 — a usage/rate-limit signal in the scrape fallback is surfaced (#47)', () => {
  it('populates rateLimit when no status is found but the transcript reads as rate-limited', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake())
      .on(isPollWait, waitInfo('idle'))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'read',
        readOut('Claude AI usage limit reached|1764000000'),
      );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
    expect(result.rateLimit).toEqual({ resetAt: 1764000000000 });
  });
});

// --- HR-10: secretEnvKeys blank the pane env on tab create ------------------------

describe('HR-10 — pane env on tab create: cfg.env sets, secretEnvKeys blank (§13.1)', () => {
  it('every configured secret env key rides tab create as an empty --env value', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake()).on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, {
      kind: 'claude',
      secretEnvKeys: ['MAESTRO_GITLAB_TOKEN', 'MAESTRO_GITHUB_TOKEN'],
    });

    await runner.run(input({ workspaceDir: ws }));

    const tabCreateCall = fake.calls.find((c) => c.args[0] === 'tab' && c.args[1] === 'create');
    expect(tabCreateCall?.args.join(' ')).toContain('--env MAESTRO_GITLAB_TOKEN=');
    expect(tabCreateCall?.args.join(' ')).toContain('--env MAESTRO_GITHUB_TOKEN=');
  });

  it('cfg.env rides tab create (account selection), and blanking wins over cfg.env', async () => {
    const ws = tmpWorkspace();
    const fake = withHappyStartAndDispatch(baseFake()).on(isPollWait, waitInfo('idle'));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, {
      kind: 'claude',
      env: { CLAUDE_CONFIG_DIR: '/home/bot/.claude-bot', MAESTRO_GITLAB_TOKEN: 'oops' },
      secretEnvKeys: ['MAESTRO_GITLAB_TOKEN'],
    });

    await runner.run(input({ workspaceDir: ws }));

    const joined = fake.calls
      .find((c) => c.args[0] === 'tab' && c.args[1] === 'create')
      ?.args.join(' ');
    expect(joined).toContain('--env CLAUDE_CONFIG_DIR=/home/bot/.claude-bot');
    expect(joined).toContain('--env MAESTRO_GITLAB_TOKEN='); // blanked …
    expect(joined).not.toContain('MAESTRO_GITLAB_TOKEN=oops'); // … never the cfg.env value
  });
});

// --- HR-11: dispatch stall retries once --------------------------------------------

describe('HR-11 — agent_prompt_stalled retries once before degrading', () => {
  it('one stall is retried; a second failure degrades to in_progress', async () => {
    const ws = tmpWorkspace();
    const fake = baseFake()
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        err('agent_prompt_stalled', 'no state change in 5s'),
      );
    const runner = new HerdrRunner(fake, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('in_progress');
    const dispatches = fake.calls.filter(
      (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
    );
    expect(dispatches).toHaveLength(2); // the initial attempt + one retry after backoff
  });
});

// --- HR-12: workspace create fallback ----------------------------------------------

describe('HR-12 — no matching herdr workspace creates one', () => {
  it('creates the configured workspace when workspace list has no label match', async () => {
    const ws = tmpWorkspace();
    const fake = new FakeExec()
      .on((c) => c.args[0] === 'workspace' && c.args[1] === 'list', ok({ workspaces: [] }))
      .on(
        (c) => c.args[0] === 'workspace' && c.args[1] === 'create',
        ok({ workspace: { workspace_id: WS_ID, label: 'maestro' } }),
      )
      .on((c) => c.args[0] === 'pane' && c.args[1] === 'list', ok({ panes: [] }))
      .on((c) => c.args[0] === 'tab' && c.args[1] === 'create', tabCreatedResult())
      .on((c) => c.args[0] === 'agent' && c.args[1] === 'start', ok({}))
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('--wait'),
        ok({}),
      )
      .on(
        (c) => c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args.includes('/exit'),
        ok({}),
      )
      .on(isPollWait, waitInfo('idle'))
      .on((c) => c.args[0] === 'tab' && c.args[1] === 'close', ok({ type: 'ok' }));
    const exec = writesDone(fake, ws);
    const runner = new HerdrRunner(exec, { kind: 'claude' });

    const result = await runner.run(input({ workspaceDir: ws }));
    expect(result.status).toBe('done');
    expect(fake.calls.some((c) => c.args[0] === 'workspace' && c.args[1] === 'create')).toBe(true);
  });
});
