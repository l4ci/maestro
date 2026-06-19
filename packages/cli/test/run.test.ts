// Part D — `run <issue> --attach` launches the CONFIGURED INTERACTIVE agent (claude or
// codex) in the issue workspace via the Exec.attach (TTY-inherited) seam. It must NOT
// touch the headless runner path: no `-p`, no `--output-format`, no `stream-json`, and
// no runner is constructed.

import type { Exec, ExecOptions, ExecResult, SpawnHandle } from '@maestro/core';
import { describe, expect, it } from 'vitest';
import { attach } from '../src/commands/run.js';

interface AttachCall {
  cmd: string;
  args: string[];
  opts: ExecOptions | undefined;
}

class FakeExec implements Exec {
  readonly attachCalls: AttachCall[] = [];
  attach(cmd: string, args: string[], opts?: ExecOptions): Promise<number> {
    this.attachCalls.push({ cmd, args, opts });
    return Promise.resolve(0);
  }
  run(): Promise<ExecResult> {
    throw new Error('run must not be used by --attach');
  }
  stream(): Promise<ExecResult> {
    throw new Error('stream must not be used by --attach');
  }
  spawn(): SpawnHandle {
    throw new Error('spawn must not be used by --attach');
  }
}

describe('attach (D1 — interactive launch in workspace)', () => {
  it('resolves the workspace and attaches the configured agent there, returning the exit code', async () => {
    const exec = new FakeExec();
    const code = await attach(42, {
      exec,
      agentCommand: 'claude',
      resolveWorkspace: (iid) => `/root/g__r/${iid}`,
    });
    expect(code).toBe(0);
    expect(exec.attachCalls).toHaveLength(1);
    const call = exec.attachCalls[0]!;
    expect(call.cmd).toBe('claude');
    expect(call.opts?.cwd).toBe('/root/g__r/42');
  });

  it('uses the configured agentCommand — codex is passed through correctly', async () => {
    const exec = new FakeExec();
    await attach(42, {
      exec,
      agentCommand: 'codex',
      resolveWorkspace: () => '/root/g__r/42',
    });
    expect(exec.attachCalls[0]!.cmd).toBe('codex');
  });
});

describe('attach (D2 — never the headless runner path)', () => {
  it('argv carries no -p / --output-format / stream-json', async () => {
    const exec = new FakeExec();
    await attach(42, { exec, agentCommand: 'claude', resolveWorkspace: () => '/root/g__r/42' });
    const args = exec.attachCalls[0]!.args;
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--output-format');
    expect(args.some((a) => a.includes('stream-json'))).toBe(false);
  });
});

describe('attach (D3 — missing workspace is a clear error)', () => {
  it('throws a clear error and does NOT spawn when no workspace exists', async () => {
    const exec = new FakeExec();
    await expect(
      attach(42, { exec, agentCommand: 'claude', resolveWorkspace: () => undefined }),
    ).rejects.toThrow(/workspace/i);
    expect(exec.attachCalls).toHaveLength(0);
  });
});
