// `maestro dashboard` — launch the web dashboard (packages/web/dist/main.js) as a child
// node process through the Exec.attach (TTY-inherited) seam, so logs land in the terminal
// and Ctrl-C stops it. The CLI stays a thin shell: no import of @maestro/web, just a
// spawn of its built entry. A missing build is a clear typed error, never a node ENOENT.

import type { Exec, ExecOptions, ExecResult, SpawnHandle } from '@maestro/core';
import { describe, expect, it } from 'vitest';
import { dashboard, defaultWebMain } from '../src/commands/dashboard.js';

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
    throw new Error('run must not be used by dashboard');
  }
  stream(): Promise<ExecResult> {
    throw new Error('stream must not be used by dashboard');
  }
  spawn(): SpawnHandle {
    throw new Error('spawn must not be used by dashboard');
  }
}

describe('dashboard (launch via Exec.attach)', () => {
  it('attaches node on the web entry and returns the exit code', async () => {
    const exec = new FakeExec();
    const code = await dashboard({
      exec,
      webMain: '/repo/packages/web/dist/main.js',
      exists: () => true,
    });
    expect(code).toBe(0);
    expect(exec.attachCalls).toHaveLength(1);
    const call = exec.attachCalls[0]!;
    expect(call.cmd).toBe(process.execPath);
    expect(call.args).toEqual(['/repo/packages/web/dist/main.js']);
  });

  it('throws a clear error and does NOT spawn when the web build is missing', async () => {
    const exec = new FakeExec();
    await expect(
      dashboard({ exec, webMain: '/nowhere/web/dist/main.js', exists: () => false }),
    ).rejects.toThrow(/pnpm build/);
    expect(exec.attachCalls).toHaveLength(0);
  });

  it('resolves the default web entry inside the monorepo sibling package', () => {
    expect(defaultWebMain().replace(/\\/g, '/')).toMatch(/packages\/web\/dist\/main\.js$/);
  });
});
