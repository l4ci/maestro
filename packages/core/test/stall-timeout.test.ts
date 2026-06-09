// Per-repo stall timeout + stall observability (issue: false-positive stall kills
// during long no-event tool calls like `pnpm install`). The stall window is now a
// per-run value (from WORKFLOW.md claude.stall_timeout_seconds) and each kill is
// surfaced via the onStall callback so the daemon can log it.

import { describe, expect, it } from 'vitest';
import type { RunnerInput } from '../src/contracts/index.js';
import { WorkflowSchema } from '../src/contracts/workflow-schema.js';
import { ClaudeRunner } from '../src/runner/claude-runner.js';
import { FakeStreamExec } from './helpers/fake-stream-exec.js';

const SYSTEM = '{"type":"system","subtype":"init"}';

function input(over: Partial<RunnerInput['claude']> = {}): RunnerInput {
  return {
    workspaceDir: '/tmp/ws',
    promptBody: 'do the thing',
    context: {
      issue: {
        iid: 1,
        id: '1',
        title: 't',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        author: { id: '2', username: 'a' },
        webUrl: 'u',
      },
      recentComments: [],
    },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits', ...over },
  };
}

describe('claude.stall_timeout_seconds (WORKFLOW schema)', () => {
  it('defaults to 120', () => {
    expect(WorkflowSchema.shape.claude.parse({}).stall_timeout_seconds).toBe(120);
  });
  it('parses an override', () => {
    expect(
      WorkflowSchema.shape.claude.parse({ stall_timeout_seconds: 300 }).stall_timeout_seconds,
    ).toBe(300);
  });
});

describe('per-input stall timeout + onStall observability', () => {
  it('honors input.claude.stallTimeoutMs over the construction default, and reports each stall', async () => {
    const stalls: Array<{ attempt: number; willRetry: boolean; timeoutMs: number }> = [];
    const exec = new FakeStreamExec({ lines: [SYSTEM], hang: true });
    // construction default is the real 120_000 — if per-input did not win, this test
    // would hang far past its 5s budget. The 40ms per-input value makes it deterministic.
    const runner = new ClaudeRunner(exec, { maxStallRetries: 1, onStall: (i) => stalls.push(i) });
    const r = await runner.run(input({ stallTimeoutMs: 40 }));
    expect(r).toEqual({ status: 'in_progress', summary: 'stalled' });
    expect(exec.calls).toHaveLength(2); // killed + retried once
    expect(stalls).toEqual([
      { attempt: 0, willRetry: true, timeoutMs: 40 },
      { attempt: 1, willRetry: false, timeoutMs: 40 },
    ]);
  });

  it('does not fire onStall when the run completes', async () => {
    const stalls: unknown[] = [];
    const exec = new FakeStreamExec({
      lines: [
        SYSTEM,
        '{"type":"result","subtype":"success","result":"{\\"status\\":\\"done\\",\\"summary\\":\\"ok\\"}"}',
      ],
    });
    const runner = new ClaudeRunner(exec, { stallTimeoutMs: 40, onStall: (i) => stalls.push(i) });
    expect((await runner.run(input())).status).toBe('done');
    expect(stalls).toEqual([]);
  });
});
