// Real Exec seam over node:child_process (contracts §0.8). The single place real
// subprocesses are spawned; adapters/runner/proof inject this in production and a
// fake in tests. M2 is the first consumer (NodeExec ownership, M0 §0.10); M3/M6/M7
// reuse it. argv-array spawn (no shell) so issue/branch text can never be a shell
// injection vector; secrets ride in `env`, never argv.

import { type ChildProcess, spawn } from 'node:child_process';
import type { Exec, ExecOptions, ExecResult, SpawnHandle } from '../contracts/index.js';

function baseEnv(opts?: ExecOptions): NodeJS.ProcessEnv {
  // Start from the daemon env, overlay caller-provided (token, GITLAB_HOST, …).
  return opts?.env ? { ...process.env, ...opts.env } : process.env;
}

function launch(
  cmd: string,
  args: string[],
  opts: ExecOptions | undefined,
  inherit: boolean,
): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts?.cwd,
    env: baseEnv(opts),
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    signal: opts?.signal,
  });
}

export class NodeExec implements Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = launch(cmd, args, opts, false);
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts?.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      }
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      if (opts?.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
  }

  stream(
    cmd: string,
    args: string[],
    opts: ExecOptions & { onLine: (line: string) => void },
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = launch(cmd, args, opts, false);
      let stdout = '';
      let stderr = '';
      let buf = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      }
      child.stdout?.on('data', (d) => {
        stdout += d;
        buf += d;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          opts.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (buf.length > 0) opts.onLine(buf); // flush trailing partial line
        resolve({ code: code ?? -1, stdout, stderr });
      });
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
  }

  spawn(cmd: string, args: string[], opts?: ExecOptions): SpawnHandle {
    const child = launch(cmd, args, opts, false);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    const exited = new Promise<ExecResult>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    return {
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
      exited,
    };
  }

  attach(cmd: string, args: string[], opts?: ExecOptions): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = launch(cmd, args, opts, true); // inherit TTY — interactive, NOT the daemon path
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
  }
}
