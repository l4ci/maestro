// FakeExec — a programmable transcript matcher implementing the §0.8 Exec seam for
// hermetic adapter tests. Keyed on (cmd, args-shape) → recorded ExecResult. Records
// every call so tests can assert command shape, count (idempotency), and order.
//
// The adapter's api() convention these matchers assume:
//   exec.run('glab', ['api', '<path+query>', '-X', '<METHOD>', ...('--input','-')], { env, input })
// token rides in env (GITLAB_TOKEN), never argv.

import type { Exec, ExecOptions, ExecResult, SpawnHandle } from '../../src/contracts/index.js';

export interface RecordedCall {
  cmd: string;
  args: string[];
  opts: ExecOptions | undefined;
}

type Matcher = { pred: (c: RecordedCall) => boolean; result: ExecResult };

function methodOf(args: string[]): string {
  const i = args.indexOf('-X');
  return i !== -1 && args[i + 1] ? (args[i + 1] as string) : 'GET';
}

function pathOf(args: string[]): string {
  const i = args.indexOf('api');
  return i !== -1 && args[i + 1] ? (args[i + 1] as string) : '';
}

export class FakeExec implements Exec {
  readonly calls: RecordedCall[] = [];
  readonly #matchers: Matcher[] = [];

  /** Generic matcher. First match wins. */
  on(pred: (c: RecordedCall) => boolean, result: ExecResult): this {
    this.#matchers.push({ pred, result });
    return this;
  }

  /** Convenience: match a `glab api` call by method + path substring → JSON body. */
  onApi(method: string, pathSub: string, jsonBody: unknown): this {
    return this.on(
      (c) =>
        c.args.includes('api') && methodOf(c.args) === method && pathOf(c.args).includes(pathSub),
      { code: 0, stdout: JSON.stringify(jsonBody), stderr: '' },
    );
  }

  /** Convenience: match a `glab api` call → non-zero exit (error / 404 body). */
  onApiError(method: string, pathSub: string, code: number, stderr: string): this {
    return this.on(
      (c) =>
        c.args.includes('api') && methodOf(c.args) === method && pathOf(c.args).includes(pathSub),
      { code, stdout: '', stderr },
    );
  }

  /** Calls matching a method + path substring (for count/order assertions). */
  callsTo(method: string, pathSub: string): RecordedCall[] {
    return this.calls.filter(
      (c) =>
        c.args.includes('api') && methodOf(c.args) === method && pathOf(c.args).includes(pathSub),
    );
  }

  /** Calls matching a method + a precise path regex (when substrings would collide). */
  callsMatching(method: string, re: RegExp): RecordedCall[] {
    return this.calls.filter(
      (c) => c.args.includes('api') && methodOf(c.args) === method && re.test(pathOf(c.args)),
    );
  }

  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const call: RecordedCall = { cmd, args, opts };
    this.calls.push(call);
    const m = this.#matchers.find((x) => x.pred(call));
    if (!m) {
      return Promise.reject(
        new Error(
          `FakeExec: no matcher for ${cmd} ${methodOf(args)} ${pathOf(args)} :: ${args.join(' ')}`,
        ),
      );
    }
    return Promise.resolve(m.result);
  }

  stream(): Promise<ExecResult> {
    throw new Error('FakeExec.stream not used in M2');
  }
  spawn(): SpawnHandle {
    throw new Error('FakeExec.spawn not used in M2');
  }
  attach(): Promise<number> {
    throw new Error('FakeExec.attach not used in M2');
  }
}
