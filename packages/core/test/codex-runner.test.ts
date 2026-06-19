import { describe, expect, it } from 'vitest';
import type { RunnerInput } from '../src/contracts/index.js';
import {
  CodexRunner,
  buildCodexArgs,
  extractCodexTexts,
  parseCodexResult,
} from '../src/runner/codex-runner.js';
import { FakeStreamExec, type StreamScript } from './helpers/fake-stream-exec.js';

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
      recentComments: [],
    },
    claude: { command: 'codex', maxTurns: 40, permissionMode: 'bypassPermissions' },
    ...over,
  };
}

const fast = { stallTimeoutMs: 40, maxStallRetries: 1 };
const THREAD_STARTED = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
const TURN_COMPLETED = JSON.stringify({ type: 'turn.completed', usage: {} });

/** A codex `--json` agent_message item.completed line carrying the given text. */
function agentMsg(text: string, id = 'item_0'): string {
  return JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message', text } });
}

function run(script: StreamScript, over: Partial<RunnerInput> = {}) {
  const exec = new FakeStreamExec(script);
  const runner = new CodexRunner(exec, fast);
  return { exec, result: runner.run(input(over)) };
}

describe('CODEX-1 — parse status from the final agent_message', () => {
  it('parses done', async () => {
    const { result } = run({
      lines: [
        THREAD_STARTED,
        agentMsg('Implemented it.\n{"status":"done","summary":"Implemented OAuth"}'),
        TURN_COMPLETED,
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'Implemented OAuth' });
  });

  it('parses needs_input', async () => {
    const { result } = run({
      lines: [agentMsg('{"status":"needs_input","summary":"Which DB?"}'), TURN_COMPLETED],
    });
    expect((await result).status).toBe('needs_input');
  });

  it('takes the LAST agent_message when several carry a status', async () => {
    const { result } = run({
      lines: [
        agentMsg('{"status":"in_progress","summary":"early"}', 'a'),
        agentMsg('{"status":"done","summary":"final"}', 'b'),
        TURN_COMPLETED,
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'final' });
  });

  it('carries plan-channel fields and survives a multi-line mrDescription with braces', async () => {
    const mrDescription = '## Plan\n```ts\nconst x = { a: 1 };\n```\n- [ ] do it';
    const { result } = run({
      lines: [
        agentMsg(JSON.stringify({ status: 'done', summary: 'ok', mrDescription })),
        TURN_COMPLETED,
      ],
    });
    const r = await result;
    expect(r.status).toBe('done');
    expect(r.mrDescription).toBe(mrDescription);
  });
});

describe('CODEX-2 — argv + stdin (cold exec)', () => {
  it('builds `exec - --json --skip-git-repo-check` with the bypass flag; prompt on stdin', async () => {
    const { exec, result } = run({
      lines: [agentMsg('{"status":"done","summary":"ok"}'), TURN_COMPLETED],
    });
    await result;
    const call = exec.calls[0];
    expect(call?.cmd).toBe('codex');
    expect(call?.args).toEqual([
      'exec',
      '-',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(call?.opts.cwd).toBe('/ws/group__repo/42');
    expect(call?.opts.input).toContain('# Agent operating protocol'); // prompt on stdin
    expect(call?.opts.input).toContain('HOW TO REPORT'); // §10 contract appended
  });

  it('a non-bypass permission mode maps to --sandbox workspace-write', () => {
    const i = input();
    i.claude.permissionMode = 'acceptEdits';
    const args = buildCodexArgs(i);
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('CODEX-3 — degrade safely', () => {
  it('no agent_message → safe in_progress', async () => {
    const { result } = run({ lines: [THREAD_STARTED, TURN_COMPLETED], code: 0 });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no agent message/);
  });

  it('agent_message without a status block → safe in_progress', async () => {
    const { result } = run({
      lines: [agentMsg('I finished but forgot the status'), TURN_COMPLETED],
    });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no parseable/);
  });

  it('extractCodexTexts returns agent_message texts in order, ignoring other items', () => {
    const lines = [
      THREAD_STARTED,
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'c', type: 'command_execution', text: 'ls' },
      }),
      agentMsg('first', 'a'),
      agentMsg('second', 'b'),
      'not json {{{',
    ];
    expect(extractCodexTexts(lines)).toEqual(['first', 'second']);
  });

  it('a usage/rate-limit message with no status marks the result for backoff (#47)', () => {
    const r = parseCodexResult(
      [JSON.stringify({ type: 'error', message: 'rate limit exceeded' })],
      1,
    );
    expect(r.status).toBe('in_progress');
    expect(r.rateLimit).toEqual({});
  });
});

describe('CODEX-4 — stall watchdog (inherited from runCli)', () => {
  it('two stalls → in_progress "stalled", two attempts made', async () => {
    const exec = new FakeStreamExec({ lines: [THREAD_STARTED], hang: true });
    const r = await new CodexRunner(exec, fast).run(input());
    expect(r).toEqual({ status: 'in_progress', summary: 'stalled' });
    expect(exec.calls).toHaveLength(2);
  });
});
