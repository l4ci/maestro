// Shared subprocess exec seam (spec §0.8, amended AM-4/AM-6/AM-7/AM-8). All glab/
// gh/git/claude/proof work goes through this so adapters/runner are unit-testable
// without real binaries. Secrets flow only via ExecOptions.env, never argv/logs.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string; // stdin — how prompt+context reach `claude` (AM-7); keeps issue text off argv
  signal?: AbortSignal; // cooperative cancel — backs the runner stall-kill (AM-4)
}

export interface SpawnHandle {
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<ExecResult>;
}

export interface Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** streaming variant for `claude -p --output-format stream-json` (§10) */
  stream(
    cmd: string,
    args: string[],
    opts: ExecOptions & { onLine: (line: string) => void },
  ): Promise<ExecResult>;
  /** spawn-and-hold for processes that never exit on their own — e.g. WORKFLOW
   *  `start_command` (`npm run dev`) during playwright proof (AM-6, M4). */
  spawn(cmd: string, args: string[], opts?: ExecOptions): SpawnHandle;
  /** TTY-inherited interactive launch for `maestro run <issue> --attach` (AM-8, M6).
   *  NOT the daemon path. Resolves with the child exit code. */
  attach(cmd: string, args: string[], opts?: ExecOptions): Promise<number>;
}
