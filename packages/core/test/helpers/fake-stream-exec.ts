// FakeStreamExec — replays scripted stream-json lines through Exec.stream for the
// runner tests. Supports a `hang` mode (emit lines then never resolve until the
// caller's AbortSignal fires) to drive the stall watchdog deterministically.

import type { Exec, ExecOptions, ExecResult, SpawnHandle } from '../../src/contracts/index.js';

export interface StreamScript {
  lines: string[];
  hang?: boolean; // after emitting, wait for abort instead of resolving
  code?: number; // exit code when not hanging
  rejectWith?: string; // reject immediately (non-abort stream error)
}

interface StreamCall {
  cmd: string;
  args: string[];
  opts: ExecOptions & { onLine: (line: string) => void };
}

export class FakeStreamExec implements Exec {
  readonly calls: StreamCall[] = [];
  readonly #script: StreamScript;

  constructor(script: StreamScript) {
    this.#script = script;
  }

  stream(
    cmd: string,
    args: string[],
    opts: ExecOptions & { onLine: (line: string) => void },
  ): Promise<ExecResult> {
    this.calls.push({ cmd, args, opts });
    const script = this.#script;
    return new Promise<ExecResult>((resolve, reject) => {
      if (script.rejectWith !== undefined) {
        setTimeout(() => reject(new Error(script.rejectWith)), 0);
        return;
      }
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }
      let i = 0;
      const emit = () => {
        if (i < script.lines.length) {
          opts.onLine(script.lines[i++] as string);
          setTimeout(emit, 1);
        } else if (!script.hang) {
          resolve({ code: script.code ?? 0, stdout: script.lines.join('\n'), stderr: '' });
        }
        // hang: stop emitting, await abort
      };
      setTimeout(emit, 1);
    });
  }

  run(): Promise<ExecResult> {
    throw new Error('FakeStreamExec.run not used');
  }
  spawn(): SpawnHandle {
    throw new Error('FakeStreamExec.spawn not used');
  }
  attach(): Promise<number> {
    throw new Error('FakeStreamExec.attach not used');
  }
}

/** Build a stream-json `result` line whose result text carries the agent status. */
export function resultLine(statusJson: object, prefix = 'Final summary.\n'): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `${prefix}${JSON.stringify(statusJson)}`,
  });
}
