import { describe, expect, it } from 'vitest';
import type { RunnerInput } from '../src/contracts/index.js';
import { ClaudeRunner, assemblePrompt, buildClaudeArgs } from '../src/runner/claude-runner.js';
import {
  FakeStreamExec,
  type StreamScript,
  assistantLine,
  resultLine,
  resultText,
} from './helpers/fake-stream-exec.js';

function input(over: Partial<RunnerInput> = {}): RunnerInput {
  return {
    workspaceDir: '/ws/group__repo/42',
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
      recentComments: [
        {
          id: 'c1',
          author: { username: 'rev', id: '5' },
          body: 'please fix',
          createdAt: '2026-06-04T00:00:00Z',
        },
      ],
    },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    ...over,
  };
}

const fast = { stallTimeoutMs: 40, maxStallRetries: 1 };

const SYSTEM = '{"type":"system","subtype":"init"}';

function run(script: StreamScript, over: Partial<RunnerInput> = {}) {
  const exec = new FakeStreamExec(script);
  const runner = new ClaudeRunner(exec, fast);
  return { exec, result: runner.run(input(over)) };
}

// --- RUN-1/2: parse statuses ----------------------------------------------

describe('RUN-1/2 — parse done / needs_input / in_progress', () => {
  it('parses done', async () => {
    const { result } = run({
      lines: [SYSTEM, resultLine({ status: 'done', summary: 'Implemented OAuth' })],
    });
    expect(await result).toEqual({ status: 'done', summary: 'Implemented OAuth' });
  });

  it('parses needs_input', async () => {
    const { result } = run({
      lines: [SYSTEM, resultLine({ status: 'needs_input', summary: 'Which DB?' })],
    });
    expect((await result).status).toBe('needs_input');
  });

  it('parses in_progress', async () => {
    const { result } = run({
      lines: [SYSTEM, resultLine({ status: 'in_progress', summary: 'hit max turns' })],
    });
    expect((await result).status).toBe('in_progress');
  });
});

// --- RUN-3: argv + cold session -------------------------------------------

describe('RUN-3 — claude argv + cold session', () => {
  it('builds the stream-json argv with max-turns, permission-mode, cwd, stdin; no resume', async () => {
    const { exec, result } = run({
      lines: [SYSTEM, resultLine({ status: 'done', summary: 'ok' })],
    });
    await result;
    const call = exec.calls[0];
    expect(call?.cmd).toBe('claude');
    expect(call?.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--max-turns',
        '40',
        '--permission-mode',
        'acceptEdits',
      ]),
    );
    expect(call?.args.join(' ')).not.toMatch(/--(resume|continue)/); // cold session
    expect(call?.opts.cwd).toBe('/ws/group__repo/42');
    expect(call?.opts.input).toContain('# Agent operating protocol'); // prompt on stdin
    expect(call?.opts.input).toContain('CONTEXT'); // context reconstructed on stdin
  });

  it('assemblePrompt includes issue + comments; buildClaudeArgs has no resume flag', () => {
    const p = assemblePrompt(input());
    expect(p).toContain('Add OAuth');
    expect(p).toContain('please fix');
    expect(buildClaudeArgs(input())).not.toContain('--resume');
  });

  it('bypassPermissions emits --dangerously-skip-permissions, not --permission-mode (headless)', () => {
    const i = input();
    i.claude.permissionMode = 'bypassPermissions';
    const args = buildClaudeArgs(i);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('a non-bypass mode still passes --permission-mode verbatim', () => {
    const i = input();
    i.claude.permissionMode = 'acceptEdits';
    const args = buildClaudeArgs(i);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('appends the §10 status contract so emission never depends on the WORKFLOW author', () => {
    const p = assemblePrompt(input());
    // every prompt instructs the agent to end with the {status,summary} JSON the daemon parses
    expect(p).toContain('HOW TO REPORT');
    expect(p).toContain('"status":"needs_input"');
    expect(p).toContain('"status":"done"');
    expect(p).toMatch(/never push|daemon pushes/i); // agent commits; daemon pushes
  });
});

// --- RUN-4: malformed / truncated → safe in_progress ----------------------

describe('RUN-4 — malformed / truncated degrade safely', () => {
  it('result line without a status block → in_progress (not false done)', async () => {
    const noStatus = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'I finished but forgot to emit status',
    });
    const { result } = run({ lines: [SYSTEM, noStatus] });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no parseable/);
  });

  it('truncated stream (no result line, non-zero exit) → in_progress with exit code', async () => {
    const { result } = run({ lines: [SYSTEM, '{"type":"assistant"}'], code: 1 });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/exit 1/);
  });

  it('malformed tail line (not JSON) → still in_progress, never throws', async () => {
    const { result } = run({ lines: [SYSTEM, 'not json {{{'], code: 0 });
    expect((await result).status).toBe('in_progress');
  });
});

// --- RUN-4b: transcript fallback (#4) --------------------------------------

describe('RUN-4b — recover status from the transcript when the final message omits it', () => {
  it('recovers a status the agent emitted in an assistant message, not the result line', async () => {
    // Real-Claude failure mode (#4): the contract lands mid-turn, the final result has none.
    const { result } = run({
      lines: [
        SYSTEM,
        assistantLine('Working on it.\n{"status":"needs_input","summary":"Which DB?"}'),
        resultText('All done here, thanks!'),
      ],
    });
    expect(await result).toEqual({ status: 'needs_input', summary: 'Which DB?' });
  });

  it('the result-line status wins over an earlier assistant status (done-safe precedence)', async () => {
    const { result } = run({
      lines: [
        SYSTEM,
        assistantLine('{"status":"in_progress","summary":"midway"}'),
        resultLine({ status: 'done', summary: 'finished' }),
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'finished' });
  });

  it('takes the LAST status block when several assistant messages carry one', async () => {
    const { result } = run({
      lines: [
        SYSTEM,
        assistantLine('{"status":"in_progress","summary":"early"}'),
        assistantLine('{"status":"done","summary":"final answer"}'),
        resultText('wrapping up'),
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'final answer' });
  });

  it('no status anywhere in the transcript → safe in_progress', async () => {
    const { result } = run({
      lines: [SYSTEM, assistantLine('just thinking out loud'), resultText('no status here')],
    });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no parseable/);
  });
});

// --- RUN-5: stall watchdog -------------------------------------------------

describe('RUN-5 — stall watchdog kills + retries once', () => {
  it('two stalls → in_progress "stalled" (no infinite loop), two attempts made', async () => {
    const exec = new FakeStreamExec({ lines: [SYSTEM], hang: true });
    const runner = new ClaudeRunner(exec, fast);
    const r = await runner.run(input());
    expect(r).toEqual({ status: 'in_progress', summary: 'stalled' });
    expect(exec.calls).toHaveLength(2); // one retry after the first stall
  });

  it('events flowing within the window complete normally', async () => {
    const { result } = run({ lines: [SYSTEM, resultLine({ status: 'done', summary: 'ok' })] });
    expect((await result).status).toBe('done');
  });
});

// --- RUN-6: no secret leakage ---------------------------------------------

describe('RUN-6 — secrets never in argv or summary', () => {
  it('no token-shaped value in the claude argv', async () => {
    const { exec, result } = run({
      lines: [SYSTEM, resultLine({ status: 'done', summary: 'ok' })],
    });
    await result;
    expect(exec.calls[0]?.args.join(' ')).not.toMatch(/glpat-|ghp_/);
  });

  it('scrubs token shapes out of an error summary', async () => {
    const { result } = run({ rejectWith: 'fatal: auth failed glpat-SECRETVALUE123', lines: [] });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).not.toContain('glpat-SECRETVALUE123');
    expect(r.summary).toContain('glpat-***');
  });
});
