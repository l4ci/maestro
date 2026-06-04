# Maestro — M3: Workspace Manager & Claude Runner

- **Milestone:** M3 — per-issue workspace lifecycle + the Claude agent runner.
- **Source of truth:** `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked)
  — §6 (`claude` front matter), §8 (workspace manager + claude runner components),
  §9 (operating protocol → prompt body), §10 (runner↔agent contract),
  §13 (host-workspace tradeoff, stall detection), §13.1 (prompt injection),
  §14 (disk cap + LRU).
- **Frozen contracts:** `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md`
  — §0.8 (`Exec` seam + clone-auth resolution), §0.9 (`Runner`, `RunnerInput`,
  `AgentResult`, `AgentStatus`), §0.2 (`Issue`/`MergeRequest`/`Comment` carried in
  `RunnerInput.context`), §0.5 (cleanup is daemon-driven; manager only evicts),
  §0.6 (`workspaces.disk_cap`, `workspaces.cleanup`).
- **Depends on:** M0 (frozen contracts). Nothing else — M3 consumes only the `Exec`
  seam and the §0.9 runner types; it does **not** import the forge adapter (M2),
  the reconciler (M1), or the daemon (M5).
- **Decisions one-liner:** workspace manager is the *only* place a path under
  `workspaces/` is created/clone/branched/evicted (the future-container seam); the
  runner is a thin, deterministic translator from `RunnerInput` → one `claude -p
  --output-format stream-json` invocation via `Exec.stream` → `AgentResult`, with a
  cold session every run and a stall-timeout kill.

---

## Goal

Two independently-testable `core` units, both built TDD against the frozen seams:

1. **Workspace manager** — given a `RepoRef` + issue iid, materialize a per-issue
   clone under `workspaces/<repo-slug>/<iid>/`, create/check-out the work branch,
   reuse the dir if it already exists, evict it on demand, and keep total disk under
   `workspaces.disk_cap` via LRU. Every filesystem path it produces is provably
   inside the configured `workspaces.root` (§13 path-escape guard). Clone auth comes
   from `process.env[token_env]` via a credential helper, never an embedded remote
   URL (contracts §0.8).

2. **Claude runner** — the `Runner` interface (contracts §0.9). One `RunnerInput`
   → one `claude -p --output-format stream-json` call through `Exec.stream` →
   parse the final stream-json `result` line → `AgentResult {status, summary}`
   (§10). Cold session each run. Stall detection: no agent events past a timeout →
   kill + retry once (§13). Honors `claude.command` / `maxTurns` / `permissionMode`
   from `RunnerInput`.

Both ship with the fake `Exec` injected; **no test in M3 touches `git`, `claude`,
the network, or a real disk path outside a tmpdir.**

---

## Scope

**In**
- `WorkspaceManager` class + its interface, in `packages/core/src/workspace/`.
- Per-issue dir layout, clone-new, reuse-existing, branch create/checkout.
- Path-escape guard: a single `resolveWorkspacePath(root, repo, iid)` helper that is
  the only way a path is built, with rejection of any input that escapes `root`.
- LRU disk accounting + eviction at `disk_cap`; `evict(dir)` primitive.
- Tokenized clone auth via `Exec` env + `GIT_*` credential-helper invocation
  (contracts §0.8), token sourced from `process.env[token_env]`.
- `ClaudeRunner implements Runner`, in `packages/core/src/runner/`.
- stream-json line parsing → `AgentResult`; malformed/truncated handling.
- Stall-timeout watchdog → kill + single retry.
- `claude` argv assembly from `RunnerInput.claude` (command, max_turns, permission_mode).

**Out (and where it lives)**
- *Deciding* when to clean up / which issues are terminal → **daemon, M5** via the
  cleanup sweep (contracts §0.5). M3 exposes `evict`; M5 calls it. The manager
  **never** lists issues or calls the forge adapter.
- The `cleanup` reconciler intent → **M1**. M3 only provides the eviction mechanism.
- Building the prompt body / operating protocol text → **M0 template + M5 assembly**.
  M3 takes `promptBody` as an opaque string in `RunnerInput`.
- Feeding review feedback into the agent → reconciler/daemon (M1/M5); M3 just
  receives `context.recentComments`.
- Proof generation, MR/label mutation → M4 / adapter.
- Real container isolation → deferred (§17). M3 keeps the seam clean for it.
- `concurrency` slot accounting → daemon (M5, §14). The manager enforces *disk*,
  not *concurrency*.

---

## TDD slices

Each slice: write the named failing test first, then the minimal impl. All
filesystem tests use an OS tmpdir as `workspaces.root`; all subprocess behavior
goes through an injected fake `Exec` that records `(cmd, args, opts)` calls and
returns scripted `ExecResult` / streamed lines.

### Workspace manager

**WS-1 — `resolveWorkspacePath` confines to root (path-escape guard).**
Test `rejects-path-escape`: feed hostile `RepoRef.project` / issue identifiers —
`'../../etc'`, `'..%2f..'`, absolute `'/etc/passwd'`, `'a/../../b'`, embedded NUL,
and a symlink-style `'foo/../../..'`. The helper must (a) slugify the repo into a
single safe path segment, (b) coerce iid to an integer, (c) `path.resolve` the
result and assert `resolved === root || resolved.startsWith(root + path.sep)`,
throwing `WorkspacePathError` otherwise. Positive test `confines-normal`: a normal
`group/repo` + iid `42` resolves to `<root>/group__repo/42` and passes. **This is
the §13 mitigation and the highest-priority slice — write it first.**
Impl: pure helper, no I/O, the single chokepoint every other method calls.

**WS-2 — clone-new.** Test `clones-when-absent`: dir does not exist → manager calls
`Exec.run('git', ['clone', ...])` with `cwd` = parent, target path from WS-1, then
returns a handle whose `.dir` is inside root. Assert the clone happened exactly once
and the remote URL passed on `argv` contains **no token** (slice WS-6 asserts the
token path positively). Impl: `ensureWorkspace(repo, iid, fromRef)` → if absent,
clone.

**WS-3 — reuse-existing.** Test `reuses-when-present`: dir already exists with a
`.git` → manager does **not** clone; instead it fetches/resets to `fromRef`
(`git fetch` + `git checkout`/`git reset --hard <fromRef>` — pick the minimal
idempotent reset) and returns the same dir. Assert zero `git clone` calls. Impl:
existence check in `ensureWorkspace` branches to reuse.

**WS-4 — branch create/checkout.** Test `creates-work-branch`: after clone/reuse,
`prepareBranch(handle, branchName)` runs `git checkout -B <branchName> <fromRef>`
(create-or-reset, idempotent on re-run). Test `branch-idempotent`: calling twice
yields the same checked-out branch with no error. Assert branch name is passed
verbatim (the reconciler owns naming; M3 does not invent it). Impl: `prepareBranch`.

**WS-5 — LRU disk-cap eviction (§14).** Test `evicts-lru-over-cap`: configure a tiny
`disk_cap`; create three workspace dirs with recorded access times and known sizes
summing over cap → manager's `enforceDiskCap()` evicts the **least-recently-used**
dirs (oldest `lastAccess`) until total ≤ cap, never evicting the dir requested this
tick (pass an `inUse` set). Test `noop-under-cap`: under cap → zero evictions. Test
`access-updates-recency`: `ensureWorkspace`/`prepareBranch` bump `lastAccess` so a
just-touched dir is evicted last. Impl: `du`-style size walk (or `Exec.run('du',…)`
behind the seam — prefer a Node `fs` walk for determinism in tests), an in-memory
recency map keyed by dir, eviction loop calling the WS-7 `evict`. Sizes/atimes are
injected via the fake fs/tmpdir so the test is deterministic.

**WS-6 — clone auth via tokenized credential helper (§0.8).** Test
`clone-uses-token-from-env-not-argv`: given `token_env: 'MAESTRO_GITLAB_TOKEN'` and
`process.env.MAESTRO_GITLAB_TOKEN = 'secret-xyz'`, the clone passes the token via
`ExecOptions.env` + a `git -c credential.helper=...` / `GIT_ASKPASS`-style mechanism
(see Open dependency OD-1 for the exact helper choice), and **asserts**: (a)
`'secret-xyz'` appears nowhere in the recorded `args` array; (b) the committed-style
remote URL is plain `https://<host>/<project>.git` with no userinfo; (c) the token
*does* reach the subprocess via `opts.env`. Test `missing-token-fails-clear`:
`process.env[token_env]` unset → throws a typed `MissingTokenError` naming the env
var (not the value). Impl: `buildCloneAuth(repo, tokenEnv)` returning `{ env, args }`
consumed by WS-2.

**WS-7 — eviction primitive + terminal cleanup hook (§0.5).** Test `evict-removes-dir`:
`evict(dir)` recursively removes the dir (after the WS-1 guard re-validates `dir` is
inside root — defense in depth) and clears it from the recency map; re-`evict` of a
missing dir is a no-op (idempotent). Test `evict-rejects-outside-root`: `evict('/tmp/x')`
where `/tmp/x` is outside `root` → throws `WorkspacePathError`, removes nothing.
Impl: `evict(dir)`. **Contract tie:** this is the mechanism the daemon's cleanup
sweep (§0.5) calls when `getIssueState` returns `closed`/`missing`; the *manager
evicts, the daemon decides*. M3 ships only `evict` + `enforceDiskCap`; no
issue-state logic here.

### Claude runner

The fake `Exec.stream` is constructed from a **recorded fixture**: an array of
stream-json lines (one JSON object per line, as `claude -p --output-format
stream-json` emits) that the fake replays through `opts.onLine`, then resolves an
`ExecResult`. Capture/author at least: a `done` transcript, a `needs_input`
transcript, an `in_progress`/max-turns transcript, a malformed-tail transcript, and
a truncated (process-killed) transcript. (See OD-2 on fixture provenance.)

**RUN-1 — parse `done`.** Test `parses-done-result`: fixture ends with a final
result line carrying the agent's `{status:'done', summary:'...'}` payload → runner
returns exactly that `AgentResult`. Assert `status==='done'` and `summary` is the
agent-emitted string. Impl: `ClaudeRunner.run` invokes `Exec.stream`, accumulates
lines, on completion extracts the final `result` and parses the §10 status object.

**RUN-2 — parse `needs_input` and `in_progress`.** Test `parses-needs-input` and
`parses-in-progress`: corresponding fixtures → `AgentResult.status` is
`'needs_input'` / `'in_progress'` respectively. Asserts the full `AgentStatus` union
(§0.9) is handled. (Daemon mapping — `needs_input`→`blocked`, `done`→handoff — is
M5, **out of M3 scope**; M3 only returns the typed result.)

**RUN-3 — argv + cold-session assembly.** Test `builds-claude-argv`: given
`RunnerInput.claude = {command:'claude', maxTurns:40, permissionMode:'acceptEdits'}`
and `workspaceDir`, assert the recorded `Exec.stream` call uses `cmd === 'claude'`,
`args` includes `-p`, `--output-format`, `stream-json`, the max-turns flag, the
permission-mode flag, and `opts.cwd === workspaceDir`. Test `cold-session-no-resume`:
assert **no** session-resume/continue flag is ever present — every run is cold
(§2, §8). The prompt body + context are passed as input (via `opts.input` /
stdin or a `-` prompt arg — see OD-3). Impl: `buildClaudeArgs(input)`. **No invented
flag names beyond what OD-3 resolves.**

**RUN-4 — malformed / truncated output.** Test `handles-malformed-tail`: a fixture
whose final line is not valid JSON, or has no recognizable `status` → runner does
**not** throw to the caller; it returns `{status:'in_progress', summary:<diagnostic>}`
so the daemon safely retries next tick (statelessness — §3). Test
`handles-truncated-output`: stream ends with **no** result line at all (e.g. process
exited non-zero) → same safe `in_progress` fallback, and the non-zero `ExecResult.code`
is surfaced in `summary` (never the raw stderr if it could contain secrets — scrub).
Rationale: a parse failure is indistinguishable from "agent didn't finish"; treating
it as `in_progress` is the only choice that can't lose work or false-signal `done`.

**RUN-5 — stall-timeout kill (§13).** Test `kills-on-stall`: fake `Exec.stream`
emits two lines then goes silent (never resolves) past `stallTimeoutMs` → runner
aborts the subprocess (via an abort signal / `Exec` kill path — see OD-4) and the
attempt ends. Test `retries-once-after-stall`: first attempt stalls → runner kills +
starts **one** fresh cold attempt; if the second also stalls → returns
`{status:'in_progress', summary:'stalled'}` (do NOT loop forever — the daemon
re-runs next tick). Test `no-stall-when-events-flow`: lines arriving within the
window reset the watchdog and the run completes normally. Impl: a watchdog timer
reset on each `onLine`; on expiry, abort + retry-once.

**RUN-6 — env / token passing (no leak).** Test `passes-env-not-argv`: any tokens
the daemon supplies for the run (e.g. forge token for the agent's own git ops) are
passed via `ExecOptions.env` only; assert no token value appears in `args`. Test
`no-secret-in-summary`: the returned `AgentResult.summary` is the agent's emitted
summary (or a scrubbed diagnostic), never echoed env/stderr containing a token.
Impl: thread `input.env?`/scrubbing through `run`. **Note:** §0.9 `RunnerInput` does
not currently carry an `env` field — see OD-5; until resolved, M3 passes only the
minimal `cwd` + `claude` config and relies on the inherited process env scoped by
the daemon. Flag, don't invent.

---

## Exit gate (checklist)

- [ ] `WorkspaceManager` and `ClaudeRunner` exist in `packages/core/src/` and are
      exported; `ClaudeRunner` is declared `implements Runner` (§0.9) with **no**
      change to the frozen `Runner`/`RunnerInput`/`AgentResult` shapes.
- [ ] Every workspace path flows through `resolveWorkspacePath`; WS-1 escape tests
      (`..`, absolute, NUL, encoded traversal) all reject. No path is constructed by
      string concatenation anywhere else in the module.
- [ ] clone-new, reuse-existing, branch create/checkout, LRU eviction at `disk_cap`,
      and `evict` (idempotent + outside-root rejection) all green.
- [ ] Clone auth: token sourced from `process.env[token_env]`, passed via `Exec`
      env/credential-helper, asserted absent from `argv`; missing-token throws typed.
- [ ] Runner parses `done` / `needs_input` / `in_progress`; malformed + truncated →
      safe `in_progress` fallback (never false `done`).
- [ ] Stall watchdog kills + retries once; no infinite loop; healthy stream unaffected.
- [ ] `claude` argv carries `-p --output-format stream-json` + max-turns +
      permission-mode + `cwd`; **no resume flag** (cold session proven).
- [ ] No token value appears in any recorded `argv`, log line, or `AgentResult.summary`
      across the whole suite (a grep-style assertion in a shared test helper).
- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean; M3 adds **zero**
      entries to the §0.10 contract change log (if it needs one, an Open dependency
      below must be resolved first and the log updated then — not silently).

---

## Cross-cutting (QA + Security)

- **§13 host-workspace tradeoff — primary M3 mitigation surface.** The path-escape
  guard (WS-1/WS-7) is *the* code-level mitigation the spec names ("never escape
  `workspaces/`"). It must be the single chokepoint and defense-in-depth (validate
  on create **and** on evict). This is the seam where container isolation later
  drops in (§17) — keep `WorkspaceManager`'s interface free of host-fs assumptions
  beyond `dir: string` so a container-backed impl can satisfy the same contract.
- **Secrets only via `Exec` env (§0.8 / §0.11).** Tokens are read from
  `process.env[token_env]` at the edge and handed to subprocesses via
  `ExecOptions.env` or a credential helper — never `argv`, never a committed remote
  URL, never a log line, never `AgentResult.summary`. A shared test helper asserts
  no known secret value appears in any recorded call or returned string; this is the
  one place the §13.1 secrets audit looks.
- **No token in logs/argv** — enforced by WS-6, RUN-6, and the suite-wide grep
  assertion above. Error types (`MissingTokenError`) name the env var, never the value.
- **Prompt-injection risk surface (§13.1) — flagged, not solved here.** The
  `RunnerInput.context` (issue body + comments) is attacker-controlled on public
  repos and the runner feeds it straight to `claude` acting with the bot's
  credentials. M3 **does not** mitigate prompt injection — that is the deferred
  container isolation (§17) plus public-repo-opt-in policy (M8). M3's only obligation
  is to (a) not *amplify* the blast radius — keep secrets out of the workspace env
  the agent sees, honor the supplied `permissionMode` verbatim (don't widen it), and
  (b) document this in the module header. Full mitigation = M8 / deferred containers.
- **QA:** all M3 tests are hermetic — tmpdir + fake `Exec`, no network, no real
  `git`/`claude`. Fixtures are checked-in recorded stream-json transcripts. The
  stall test must use fake timers (vitest) so it is fast and deterministic.

---

## Open dependencies

Genuine gaps where the frozen contracts / spec under-specify an M3 detail. Each is
*non-blocking for writing the tests* (the test asserts the behavior; the impl detail
is pinned here) but must be resolved before the impl lands. **No guessing in code —
resolve here first.**

- **OD-1 — exact git credential-helper invocation.** Contracts §0.8 says clone auth
  uses "a tokenized credential helper … M3 specifies the exact credential-helper
  invocation per forge," but the mechanism is left to M3.
  *Why it matters:* WS-6 asserts the token reaches git via env, not argv, and the
  remote URL stays plain — but the precise helper differs (`git -c
  credential.helper='!f(){ echo "username=oauth2"; echo "password=$TOKEN"; };f'`
  vs `GIT_ASKPASS` script vs `http.extraHeader=Authorization: Bearer`).
  *Proposed fix:* use per-clone `git -c credential.helper=` with the token read from
  `opts.env` (no temp file on disk, no userinfo in URL). GitLab/GitHub both accept
  `oauth2:<token>` over HTTPS. Pin this and record it in §0.8; if it forces a
  contract note, add a §0.10 change-log row.

- **OD-2 — stream-json fixture provenance & exact `result` shape.** Spec §10 gives
  the *payload* (`{status, summary}`) but not the *envelope* — i.e. which
  stream-json line type carries it (a final `{"type":"result", ...}` object? nested
  under `result`/`subtype`?) and how the agent is instructed to emit the status.
  *Why it matters:* RUN-1/2/4 parse "the final result line"; the field path must be
  exact or parsing is guesswork.
  *Proposed fix:* capture one real `claude -p --output-format stream-json` run during
  M3 kickoff, commit the transcript as the canonical fixture, and pin the field path
  (likely the terminal `type==='result'` object's text/`result` field, from which we
  extract the agent's JSON status block per §9's "emit done"). Confirm whether the
  agent prints the §10 JSON in its final message text vs a structured field. Blocks
  RUN-1 impl, not the test names.

- **OD-3 — how prompt + context reach `claude -p`.** §0.9 `RunnerInput` carries
  `promptBody` + `context`, but §10/§0.8 don't pin whether these go on stdin
  (`ExecOptions.input`), as a positional prompt arg, or a temp prompt file.
  *Why it matters:* RUN-3 asserts argv; the prompt-delivery channel changes both
  argv and whether `opts.input` is used.
  *Proposed fix:* pass the assembled prompt on **stdin** via `ExecOptions.input`
  (avoids argv length limits and keeps issue text — possibly large/attacker-shaped —
  off the process table). Pin in this plan.

- **OD-4 — process-kill / abort path on the `Exec` seam.** §0.8 `Exec.stream` has
  no documented cancellation primitive; RUN-5 needs to kill a stalled subprocess.
  *Why it matters:* without a kill hook the stall watchdog can detect but not stop.
  *Proposed fix:* extend `ExecOptions` with an optional `signal?: AbortSignal`
  (standard `child_process` support). This is a **contract amendment to §0.8** —
  add a §0.10 change-log row when adopted. The fake `Exec` honors the signal so
  RUN-5 stays hermetic. Flagged as the one likely contract edit in M3.

- **OD-5 — agent-run env (`RunnerInput` has no `env`).** §0.9 `RunnerInput` carries
  `workspaceDir`, `promptBody`, `context`, `claude` — but no `env`. The agent may
  need a scoped forge token to push commits, yet RUN-6's security stance is "no
  secrets in the workspace the agent sees" (§13.1).
  *Why it matters:* whether/which credentials the agent subprocess gets is a security
  decision, not an M3 invention.
  *Proposed fix:* leave `RunnerInput` unchanged in M3. The runner passes only `cwd`
  + `claude` config and inherits the daemon-scoped process env (the daemon decides
  what's in it). If the agent needs git push creds, resolve via the credential
  helper reused from OD-1 (so the agent pushes without a token in its env), and
  decide in M4/M5 — **do not add an `env` field to the frozen `RunnerInput` in M3**.

---

### Final note on contract fidelity

M3 implements `Runner`/`RunnerInput`/`AgentResult`/`AgentStatus` (§0.9) and the
`Exec` seam (§0.8) **exactly as frozen**. The only candidate contract amendment is
OD-4 (`AbortSignal` on `ExecOptions`); if adopted, it gets a §0.10 change-log entry
at implementation time. No other type is redefined, and the workspace manager
introduces only new module-local types (`WorkspaceHandle`, `WorkspacePathError`,
`MissingTokenError`) that no other milestone's contract depends on.
