// Herdr-hosted agent runner (spec §8 amendment). Opt-in alternative to the headless
// ClaudeRunner/CodexRunner (run-cli.ts): instead of a cold `claude -p --output-format
// stream-json` subprocess, the agent runs as an interactive TUI inside its own herdr
// tab — a human can attach and watch mid-run while the daemon still drives the
// lifecycle (provision → prompt → wait → read result → teardown). Every run is still
// COLD (§2/§8): no session resume, a fresh tab per run, the tab torn down on every
// exit path. Herdr calls are all `Exec.run` (control-plane, no streaming); prompt +
// result files are read/written directly via node:fs (WorkspaceManager precedent —
// no injected fs seam).
//
// SAFE DEGRADE (absolute): any parse/spawn/herdr failure returns a SAFE `in_progress`
// (never a false `done`); herdr's own pane state `blocked` NEVER maps to the agent
// status `needs_input` — that only ever comes from the agent's own parsed JSON (§10).
//
// Herdr response shapes verified live against herdr 0.8.2: `agent wait` success wraps
// the row as {result:{agent:{agent_status},type:"agent_info"}}; slice expiry is exit 1 +
// {"error":{"code":"timeout"}}; `agent read` prints RAW terminal text (no JSON envelope);
// `tab create`/`workspace create` return {result:{root_pane:{pane_id},tab:{tab_id},
// workspace?:{workspace_id}}}; `agent send-keys <name> enter` clears a trust dialog.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  AgentResult,
  AgentStatus,
  Exec,
  ExecResult,
  Runner,
  RunnerInput,
} from '../contracts/index.js';
import {
  detectRateLimit,
  pickLastStatus,
  scrub,
  topLevelJsonObjects,
  tryParse,
} from './agent-status.js';
import { assemblePrompt } from './prompt.js';
import type { StallInfo } from './run-cli.js';

export interface HerdrRunnerConfig {
  /** Which agent herdr hosts in the tab (orthogonal to `runner: herdr` itself). */
  kind: 'claude' | 'codex';
  /** The herdr binary/path. Default 'herdr'. */
  command?: string;
  /** The herdr workspace this daemon's tabs live in (created if absent). Default 'maestro'. */
  workspaceLabel?: string;
  /** Env vars SET on the run's pane at tab create — the pane inherits the herdr SERVER's
   *  env, not the daemon's, so the agent account (CLAUDE_CONFIG_DIR) is selected here.
   *  Keys that appear in secretEnvKeys are ignored: blanking always wins (§13.1). */
  env?: Record<string, string>;
  /** Env var NAMES blanked in the pane via `--env KEY=` (§13.1) — the forge token_env(s). */
  secretEnvKeys?: string[];
  /** Reused from RunCliConfig's shape so daemon.ts's runnerCfg spreads straight in. Fired
   *  when the run-timeout ceiling is exceeded with no terminal status (the closest herdr
   *  analog to a headless-runner stall — HerdrRunner never retries mid-run, so willRetry
   *  is always false here). */
  onStall?: (info: StallInfo) => void;
}

interface ResolvedCfg {
  command: string;
  workspaceLabel: string;
  kind: 'claude' | 'codex';
  env: Record<string, string>;
  secretEnvKeys: string[];
  onStall?: (info: StallInfo) => void;
}

const RUN_NAME_PREFIX = 'm-';
const RUN_NAME_MAX_LEN = 48;
const DEFAULT_RUN_TIMEOUT_MS = 1_800_000; // mirrors WORKFLOW claude.run_timeout_seconds default
const POLL_SLICE_MS = 30_000; // observability + early blocked-detection, not one big wait
const DISPATCH_TIMEOUT_MS = 15_000; // "short" — just the prompt hand-off ack, not the run
const DISPATCH_RETRY_BACKOFF_MS = 1_000; // a just-started TUI may still be settling
const TRUST_DIALOG_MAX_ATTEMPTS = 3;
const TRUST_DIALOG_WAIT_MS = 10_000;
const START_MAX_ATTEMPTS = 5; // agent_pane_not_found races resolve within ~a second
const START_PANE_BACKOFF_MS = 500;
const READ_LINES = 200;

export class HerdrRunner implements Runner {
  readonly #exec: Exec;
  readonly #cfg: ResolvedCfg;
  #workspaceId: string | undefined; // cached per daemon process

  constructor(exec: Exec, cfg: HerdrRunnerConfig) {
    this.#exec = exec;
    this.#cfg = {
      command: cfg.command ?? 'herdr',
      workspaceLabel: cfg.workspaceLabel ?? 'maestro',
      kind: cfg.kind,
      env: cfg.env ?? {},
      secretEnvKeys: cfg.secretEnvKeys ?? [],
      ...(cfg.onStall ? { onStall: cfg.onStall } : {}),
    };
  }

  async run(input: RunnerInput): Promise<AgentResult> {
    const { workspaceDir } = input;
    const runTimeoutMs = input.claude.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const name = runName(workspaceDir);
    let tabId: string | undefined;

    try {
      const workspaceId = await this.#resolveWorkspaceId(workspaceDir);
      // Per-run orphan pre-check: a crash-left tab from a PRIOR run on this same
      // workspace dir would collide on the duplicate-name check below.
      await closeMatchingPanes(this.#exec, this.#cfg, workspaceId, (p) => p.cwd === workspaceDir);

      const nonce = randomUUID();
      writePromptArtifacts(workspaceDir, input, nonce);

      const created = await createTab(this.#exec, this.#cfg, workspaceId, workspaceDir, name);
      if (!created.ok) return { status: 'in_progress', summary: created.diagnostic };
      tabId = created.tabId;

      const started = await this.#startAgent(
        name,
        created.paneId,
        created.tabId,
        input.claude.permissionMode,
        workspaceId,
        workspaceDir,
      );
      if (!started.ok) return { status: 'in_progress', summary: started.diagnostic };

      const dispatched = await dispatch(this.#exec, this.#cfg, name);
      if (!dispatched.ok) return { status: 'in_progress', summary: dispatched.diagnostic };

      const polled = await this.#pollUntilTerminal(name, runTimeoutMs);
      if (!polled.ok) return { status: 'in_progress', summary: polled.diagnostic };

      return this.#readResult(name, workspaceDir, nonce);
    } catch (e) {
      return {
        status: 'in_progress',
        summary: `herdr runner error: ${scrub((e as Error).message)}`,
      };
    } finally {
      await teardown(this.#exec, this.#cfg, name, tabId);
    }
  }

  /** Startup bulk sweep (herdr mode only, correction #9): a fresh daemon start means
   *  Claims is empty, so any LIVE `m-*` agent in the configured workspace is an orphan
   *  left by a crash mid-run (the cold-per-run contract has no other way to leak a live
   *  tab). Best-effort — a sweep failure never blocks daemon boot. */
  async sweepOrphans(): Promise<void> {
    const listed = await runHerdr(this.#exec, this.#cfg, ['agent', 'list']);
    if (!listed.ok) return;
    const agents = asArray((listed.result as Record<string, unknown> | null)?.agents);
    if (agents.length === 0) return;

    const paneList = await runHerdr(this.#exec, this.#cfg, ['pane', 'list']);
    const panes = paneList.ok
      ? asArray((paneList.result as Record<string, unknown> | null)?.panes)
      : [];
    const paneInfo = new Map<string, { tabId: string; workspaceId: unknown }>();
    for (const p of panes) {
      const rec = p as Record<string, unknown>;
      if (typeof rec.pane_id === 'string' && typeof rec.tab_id === 'string') {
        paneInfo.set(rec.pane_id, { tabId: rec.tab_id, workspaceId: rec.workspace_id });
      }
    }

    const workspaceId = await this.#resolveWorkspaceId(process.cwd()).catch(() => undefined);
    const closed = new Set<string>();
    for (const a of agents) {
      const rec = a as Record<string, unknown>;
      if (typeof rec.name !== 'string' || !rec.name.startsWith(RUN_NAME_PREFIX)) continue;
      const info = typeof rec.pane_id === 'string' ? paneInfo.get(rec.pane_id) : undefined;
      if (!info || closed.has(info.tabId)) continue;
      if (workspaceId !== undefined && info.workspaceId !== workspaceId) continue;
      closed.add(info.tabId);
      await runHerdr(this.#exec, this.#cfg, ['tab', 'close', info.tabId]);
    }
  }

  /** Resolve (and cache) the configured herdr workspace id; create it if absent. `seedCwd`
   *  seeds a freshly-created workspace's --cwd — herdr requires one, but the workspace
   *  itself is shared across every run, so the workspaces ROOT (two levels above any one
   *  issue's dir) is the meaningful value, not any single run's own workspaceDir. */
  async #resolveWorkspaceId(seedCwd: string): Promise<string> {
    if (this.#workspaceId) return this.#workspaceId;

    const listed = await runHerdr(this.#exec, this.#cfg, ['workspace', 'list']);
    if (listed.ok) {
      const workspaces = asArray((listed.result as Record<string, unknown> | null)?.workspaces);
      const match = workspaces.find(
        (w) => (w as Record<string, unknown>).label === this.#cfg.workspaceLabel,
      ) as Record<string, unknown> | undefined;
      if (typeof match?.workspace_id === 'string') {
        this.#workspaceId = match.workspace_id;
        return this.#workspaceId;
      }
    }

    const root = dirname(dirname(seedCwd)) || seedCwd;
    const created = await runHerdr(this.#exec, this.#cfg, [
      'workspace',
      'create',
      '--cwd',
      root,
      '--label',
      this.#cfg.workspaceLabel,
      '--no-focus',
    ]);
    if (!created.ok) {
      throw new Error(
        `cannot resolve/create herdr workspace '${this.#cfg.workspaceLabel}': ${created.message}`,
      );
    }
    const obj = created.result as Record<string, unknown> | null;
    const nested = obj?.workspace as Record<string, unknown> | undefined;
    const id = nested?.workspace_id ?? obj?.workspace_id;
    if (typeof id !== 'string') {
      throw new Error(`herdr workspace create returned no workspace_id: ${JSON.stringify(obj)}`);
    }
    this.#workspaceId = id;
    return id;
  }

  /** §8 step 6: start the agent in the pane. Three verified-live failure modes, each
   *  with its own recovery:
   *  - `agent_pane_not_found`: a fresh tab's pane registers asynchronously — back off
   *    briefly and retry the same start (a real race, seen ~1s after tab create).
   *  - `agent_not_ready`: the agent LAUNCHED but sits blocked on the folder-trust
   *    dialog. It is already registered under `name`, so a restart would only hit
   *    agent_name_taken — nudge the dialog instead; recovery success IS started.
   *  - `agent_name_taken` naming OUR OWN pane: the agent is already live (a prior
   *    recovery landed it) — success. Any other collision: sweep stale tabs on this
   *    workspace dir (excluding our own tab) and retry once. */
  async #startAgent(
    name: string,
    paneId: string,
    tabId: string,
    permissionMode: string,
    workspaceId: string,
    workspaceDir: string,
  ): Promise<{ ok: true } | { ok: false; diagnostic: string }> {
    const flags = agentStartFlags(this.#cfg.kind, permissionMode);
    const startArgs = [
      'agent',
      'start',
      name,
      '--kind',
      this.#cfg.kind,
      '--pane',
      paneId,
      '--',
      ...flags,
    ];

    let swept = false;
    for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt++) {
      const r = await runHerdr(this.#exec, this.#cfg, startArgs);
      if (r.ok) return { ok: true };

      if (r.code === 'agent_pane_not_found') {
        await sleep(START_PANE_BACKOFF_MS);
        continue;
      }
      if (r.code === 'agent_not_ready') {
        if (await this.#recoverTrustDialog(name)) return { ok: true };
        return { ok: false, diagnostic: 'herdr: agent blocked on a startup dialog; nudge failed' };
      }
      if (r.code === 'agent_name_taken') {
        if (r.message.includes(paneId)) return { ok: true }; // it's OUR agent, already live
        if (swept) {
          return { ok: false, diagnostic: `herdr: agent name still taken — ${r.message}` };
        }
        swept = true;
        await closeMatchingPanes(
          this.#exec,
          this.#cfg,
          workspaceId,
          (p) => p.cwd === workspaceDir && p.tab_id !== tabId, // NEVER our own tab
        );
        continue;
      }
      return { ok: false, diagnostic: `herdr: agent start failed (${r.code}): ${r.message}` };
    }
    return { ok: false, diagnostic: 'herdr: agent start failed — pane never became ready' };
  }

  /** Nudge the folder-trust dialog blocking a launched agent (agent_not_ready). Verified
   *  live: the dialog's DEFAULT selection is "No, exit" — plain Enter would QUIT claude —
   *  so send `down enter` to select "Yes, I trust this folder". Bounded, best-effort;
   *  success = the agent reaching idle (it stays registered under `name` throughout). */
  async #recoverTrustDialog(name: string): Promise<boolean> {
    for (let i = 0; i < TRUST_DIALOG_MAX_ATTEMPTS; i++) {
      await readPaneText(this.#exec, this.#cfg, name); // diagnostics breadcrumb in the journal
      await runHerdr(this.#exec, this.#cfg, ['agent', 'send-keys', name, 'down', 'enter']);
      const waited = await runHerdr(this.#exec, this.#cfg, [
        'agent',
        'wait',
        name,
        '--until',
        'idle',
        '--timeout',
        String(TRUST_DIALOG_WAIT_MS),
      ]);
      if (waited.ok && herdrAgentStatus(waited.result) === 'idle') return true;
    }
    return false;
  }

  /** §8 step 8: poll in slices (not one big wait) so a stall is diagnosable and a
   *  `blocked` agent is caught early. `timeout` on a slice means "still working, keep
   *  polling" (verified: exit 1 + {"error":{"code":"timeout",...}} at slice expiry); any
   *  OTHER error code is a real failure. */
  async #pollUntilTerminal(
    name: string,
    runTimeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; diagnostic: string }> {
    const deadline = Date.now() + runTimeoutMs;
    while (Date.now() < deadline) {
      const sliceMs = Math.max(1, Math.min(POLL_SLICE_MS, deadline - Date.now()));
      const r = await runHerdr(this.#exec, this.#cfg, [
        'agent',
        'wait',
        name,
        '--timeout',
        String(sliceMs),
      ]);
      if (r.ok) {
        const status = herdrAgentStatus(r.result);
        if (status === 'idle' || status === 'done' || status === 'blocked') return { ok: true };
        continue; // 'working' (or an unrecognized status) — keep polling
      }
      if (r.code === 'timeout') continue; // slice expired mid-work — keep polling
      return { ok: false, diagnostic: `herdr: agent wait failed (${r.code}): ${r.message}` };
    }
    this.#cfg.onStall?.({ attempt: 0, willRetry: false, timeoutMs: runTimeoutMs });
    return {
      ok: false,
      diagnostic: `herdr: run-timeout ceiling exceeded (${runTimeoutMs}ms) with no terminal status`,
    };
  }

  /** §8 step 9: mirrors parseAgentResult's precedence exactly — the daemon-authored
   *  result file wins, the pane transcript is the diagnostics-only fallback, a rate-limit
   *  signal in that fallback is still surfaced (#47), and every failure is a safe
   *  `in_progress` (never a false `done`). */
  async #readResult(name: string, workspaceDir: string, nonce: string): Promise<AgentResult> {
    const resultPath = join(workspaceDir, '.maestro', 'result.json');
    let text: string | null = null;
    try {
      text = readFileSync(resultPath, 'utf8');
    } catch {
      text = null;
    }
    if (text) {
      const fromFile = parseResultFile(text, nonce);
      if (fromFile) {
        try {
          rmSync(resultPath, { force: true });
        } catch {
          // best-effort cleanup; a leftover file is cleared by the next run's stale-result guard
        }
        return fromFile;
      }
    }

    const scraped = await readPaneText(this.#exec, this.#cfg, name);

    const status = pickLastStatus([scraped]);
    if (status) return status;

    const limit = detectRateLimit(scraped);
    if (limit) {
      return {
        status: 'in_progress',
        summary: 'herdr usage/rate limit reached; daemon backs off (#47)',
        rateLimit: limit,
      };
    }
    return {
      status: 'in_progress',
      summary: 'herdr: no result.json and no parseable {status} in pane transcript; will retry',
    };
  }
}

// --- module-level helpers (pure or exec-only; no `this`) --------------------

type HerdrOutcome = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** Run one herdr CLI call and normalize BOTH shapes it returns (verified live): success
 *  is exit 0 + `{result:...}` on STDOUT; failure is exit 1 + `{"error":{"code","message"}}`
 *  on STDERR (both streams are tried — the error-code special cases downstream depend on
 *  it). Never rejects — a spawn failure or unparseable output becomes `ok:false` with its
 *  own code, so every call site can degrade the same way. Error messages are scrubbed
 *  once here (§13.1) so every consumer downstream is already safe to surface. */
async function runHerdr(exec: Exec, cfg: ResolvedCfg, args: string[]): Promise<HerdrOutcome> {
  let res: ExecResult;
  try {
    res = await exec.run(cfg.command, args);
  } catch (e) {
    return { ok: false, code: 'spawn_error', message: scrub((e as Error).message) };
  }
  for (const stream of [res.stdout, res.stderr]) {
    const parsed = tryParse(stream.trim()) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') continue;
    if ('result' in parsed) return { ok: true, result: parsed.result };
    const err = parsed.error as Record<string, unknown> | undefined;
    if (err && typeof err.code === 'string') {
      return {
        ok: false,
        code: err.code,
        message: scrub(typeof err.message === 'string' ? err.message : ''),
      };
    }
  }
  return {
    ok: false,
    code: res.code === 0 ? 'unparseable_output' : 'exit_nonzero',
    message: scrub(
      `herdr ${args.join(' ')} exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 500)}`,
    ),
  };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `agent read` is the ONE herdr call that prints RAW terminal text to stdout (verified),
 *  not the {result}/{error} JSON envelope — so it bypasses runHerdr. Best-effort: any
 *  failure reads as an empty transcript and the caller degrades safely. */
async function readPaneText(exec: Exec, cfg: ResolvedCfg, name: string): Promise<string> {
  try {
    const res = await exec.run(cfg.command, [
      'agent',
      'read',
      name,
      '--source',
      'recent-unwrapped',
      '--lines',
      String(READ_LINES),
    ]);
    return res.code === 0 ? res.stdout : '';
  } catch {
    return '';
  }
}

/** §8 step 1: `m-<repo-slug>-<iid>` collapsed to herdr's (unverified, safe-subset) name
 *  charset — lowercase `[a-z0-9-]`, capped at 48 chars. */
function runName(workspaceDir: string): string {
  const raw = `${RUN_NAME_PREFIX}${basename(dirname(workspaceDir))}-${basename(workspaceDir)}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (slug || `${RUN_NAME_PREFIX}run`).slice(0, RUN_NAME_MAX_LEN);
}

/** §8 step 6 argv: mirrors buildClaudeArgs/buildCodexArgs MINUS every print-mode flag
 *  (`-p`/`--output-format`/`--max-turns`/`exec - --json` — herdr hosts an interactive
 *  TUI, not a piped one-shot). bypassPermissions maps the same way headless does; other
 *  modes pass through verbatim (claude) or fall back to the codex sandbox default. */
function agentStartFlags(kind: 'claude' | 'codex', permissionMode: string): string[] {
  if (kind === 'codex') {
    return permissionMode === 'bypassPermissions'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write'];
  }
  return permissionMode === 'bypassPermissions'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', permissionMode];
}

/** §8 step 3 (per-run precheck) and the duplicate-name retry inside #startAgent: close
 *  every tab whose pane matches `predicate` in the given workspace. Best-effort. */
async function closeMatchingPanes(
  exec: Exec,
  cfg: ResolvedCfg,
  workspaceId: string,
  predicate: (pane: Record<string, unknown>) => boolean,
): Promise<void> {
  const listed = await runHerdr(exec, cfg, ['pane', 'list']);
  if (!listed.ok) return;
  const panes = asArray((listed.result as Record<string, unknown> | null)?.panes);
  const closedTabs = new Set<string>();
  for (const p of panes) {
    const rec = p as Record<string, unknown>;
    if (rec.workspace_id !== workspaceId || !predicate(rec)) continue;
    const tabId = rec.tab_id;
    if (typeof tabId !== 'string' || closedTabs.has(tabId)) continue;
    closedTabs.add(tabId);
    await runHerdr(exec, cfg, ['tab', 'close', tabId]);
  }
}

/** §8 step 5: create the run's tab. The pane inherits the herdr SERVER's env (verified),
 *  so two overlays ride tab create: cfg.env sets what the server env lacks — above all
 *  the agent account, CLAUDE_CONFIG_DIR — and `--env <KEY>=` (empty value, verified)
 *  blanks every configured secret, per §13.1: the persisted git credential helper would
 *  otherwise expand $<token_env> from the server's env. Blanking wins over cfg.env. */
async function createTab(
  exec: Exec,
  cfg: ResolvedCfg,
  workspaceId: string,
  workspaceDir: string,
  name: string,
): Promise<{ ok: true; paneId: string; tabId: string } | { ok: false; diagnostic: string }> {
  const envArgs = [
    ...Object.entries(cfg.env)
      .filter(([k]) => !cfg.secretEnvKeys.includes(k))
      .flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...cfg.secretEnvKeys.flatMap((k) => ['--env', `${k}=`]),
  ];
  const r = await runHerdr(exec, cfg, [
    'tab',
    'create',
    '--workspace',
    workspaceId,
    '--cwd',
    workspaceDir,
    '--label',
    name,
    ...envArgs,
    '--no-focus',
  ]);
  if (!r.ok) return { ok: false, diagnostic: `herdr: tab create failed (${r.code}): ${r.message}` };

  const obj = r.result as Record<string, unknown> | null;
  const rootPane = obj?.root_pane as Record<string, unknown> | undefined;
  const tab = obj?.tab as Record<string, unknown> | undefined;
  const paneId = rootPane?.pane_id;
  const tabId = tab?.tab_id ?? rootPane?.tab_id;
  if (typeof paneId !== 'string' || typeof tabId !== 'string') {
    return { ok: false, diagnostic: 'herdr: tab create returned no pane_id/tab_id' };
  }
  return { ok: true, paneId, tabId };
}

/** §8 step 7: static dispatch pointer (AM-7 — issue text never rides argv). The real
 *  instructions + context live in .maestro/prompt.md, written to disk beforehand. */
const DISPATCH_POINTER =
  'Read .maestro/prompt.md in this working directory and follow it exactly, including the ' +
  'result-file instructions at the end of it.';

async function dispatch(
  exec: Exec,
  cfg: ResolvedCfg,
  name: string,
): Promise<{ ok: true } | { ok: false; diagnostic: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // --until working makes --wait a SUBMISSION ack. Without it, --wait's default match
    // (idle|done|blocked) is turn COMPLETION — a real multi-minute turn outruns any sane
    // ack timeout, the dispatch reads as failed, and teardown kills a healthy working
    // agent ~15s in (observed live on the first real daemon run). The completion states
    // stay listed so an instant turn (or an immediate dialog) still matches.
    const r = await runHerdr(exec, cfg, [
      'agent',
      'prompt',
      name,
      DISPATCH_POINTER,
      '--wait',
      '--until',
      'working',
      '--until',
      'idle',
      '--until',
      'done',
      '--until',
      'blocked',
      '--timeout',
      String(DISPATCH_TIMEOUT_MS),
    ]);
    if (r.ok) return { ok: true };
    if (r.code === 'agent_blocked') {
      // NEVER map herdr's blocked to the agent status needs_input — that only ever
      // comes from the agent's own parsed JSON (§10).
      return { ok: false, diagnostic: `herdr: agent_blocked on dispatch — ${r.message}` };
    }
    if (r.code === 'agent_prompt_stalled' && attempt === 0) {
      await sleep(DISPATCH_RETRY_BACKOFF_MS);
      continue;
    }
    return { ok: false, diagnostic: `herdr: dispatch failed (${r.code}): ${r.message}` };
  }
  return { ok: false, diagnostic: 'herdr: dispatch failed after retry' };
}

/** §8 step 10 (finally; best-effort — never throws, teardown always runs). */
async function teardown(
  exec: Exec,
  cfg: ResolvedCfg,
  name: string,
  tabId: string | undefined,
): Promise<void> {
  await runHerdr(exec, cfg, ['agent', 'prompt', name, '/exit']); // no --wait
  if (tabId) await runHerdr(exec, cfg, ['tab', 'close', tabId]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §8 step 4: mkdir `.maestro/`, write the prompt + nonce, idempotently git-exclude it,
 *  and clear any stale result.json from a prior run (stale-result guard). */
function writePromptArtifacts(workspaceDir: string, input: RunnerInput, nonce: string): void {
  const maestroDir = join(workspaceDir, '.maestro');
  mkdirSync(maestroDir, { recursive: true });
  writeFileSync(join(maestroDir, 'prompt.md'), buildPromptFile(input, nonce));
  ensureGitExclude(workspaceDir);
  rmSync(join(maestroDir, 'result.json'), { force: true });
}

function buildPromptFile(input: RunnerInput, nonce: string): string {
  return `${assemblePrompt(input)}

--- RESULT FILE (required, in addition to your final message) ---
Write that SAME final JSON object to a file at .maestro/result.json in this working directory, with one extra field added: "nonce":"${nonce}" — copy it EXACTLY. Example:
  {"status":"done","summary":"...","nonce":"${nonce}"}
`;
}

function ensureGitExclude(workspaceDir: string): void {
  const excludePath = join(workspaceDir, '.git', 'info', 'exclude');
  let text = '';
  try {
    text = readFileSync(excludePath, 'utf8');
  } catch {
    // missing (or no .git/info yet) is fine — treated as empty
  }
  if (text.includes('.maestro/')) return;
  if (!existsSync(dirname(excludePath))) mkdirSync(dirname(excludePath), { recursive: true });
  const next = text.length && !text.endsWith('\n') ? `${text}\n.maestro/\n` : `${text}.maestro/\n`;
  writeFileSync(excludePath, next);
}

/** Parse .maestro/result.json content: the LAST top-level JSON object whose nonce matches
 *  wins (string-aware span scan — mirrors extractStatus in agent-status.ts, which can't
 *  be reused as-is because it knows nothing about the nonce field). A wrong/missing nonce
 *  is treated exactly like a missing file — the caller falls through to the pane scrape. */
function parseResultFile(text: string, nonce: string): AgentResult | null {
  for (const span of topLevelJsonObjects(text).reverse()) {
    const obj = tryParse(span) as Record<string, unknown> | null;
    if (!obj || obj.nonce !== nonce || !isAgentStatus(obj.status)) continue;
    const out: AgentResult = {
      status: obj.status,
      summary: typeof obj.summary === 'string' ? obj.summary : '',
    };
    if (typeof obj.mrDescription === 'string' && obj.mrDescription.trim()) {
      out.mrDescription = obj.mrDescription;
    }
    if (typeof obj.planComment === 'string' && obj.planComment.trim()) {
      out.planComment = obj.planComment;
    }
    const rev = obj.review as { verdict?: unknown; findings?: unknown } | undefined;
    if (rev && (rev.verdict === 'pass' || rev.verdict === 'fail')) {
      out.review = {
        verdict: rev.verdict,
        ...(typeof rev.findings === 'string' && rev.findings.trim()
          ? { findings: rev.findings }
          : {}),
      };
    }
    return out;
  }
  return null;
}

function isAgentStatus(s: unknown): s is AgentStatus {
  return s === 'done' || s === 'needs_input' || s === 'in_progress';
}

/** `agent wait` success (verified): {result:{agent:{agent_status:"idle"|…},type:"agent_info"}}.
 *  Anything unrecognized → undefined → the poll loop keeps polling (safe degrade). */
function herdrAgentStatus(result: unknown): string | undefined {
  const agent = (result as Record<string, unknown> | null)?.agent as
    | Record<string, unknown>
    | undefined;
  return typeof agent?.agent_status === 'string' ? agent.agent_status : undefined;
}
