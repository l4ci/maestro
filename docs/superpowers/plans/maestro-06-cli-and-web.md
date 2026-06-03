# Maestro — M6: CLI & Web Shells (thin over `core`)

- **Milestone:** M6 — `packages/cli` (commands + daemon entry + `run --attach`) and `packages/web` (read-only dashboard + add-repo form).
- **Source pointers:** spec `docs/superpowers/specs/2026-06-03-maestro-design.md` §4 (topology, `dist/daemon.js`), §5 (`maestro add` appends + commits; token_env names only), §7 (lifecycle states the views render), §8 (CLI/Web are thin shells over core; `run --attach` = interactive claude, *not* the daemon path), §11/§16 (`add` triggers label/board setup, reuses the standard onboarding lifecycle), §14 (systemd `ExecStart=node …/dist/daemon.js`). Contracts `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md` §0.2 (forge model), §0.3 (`ForgeAdapter` discovery + `ensureLabels`/`ensureBoard`/`createIssue`), §0.4 (`LifecycleState`, `reconcile`), §0.6 (`ConfigSchema`), §0.7 (`LabelNames`), §0.8 (`Exec` seam — the git/forge injection point).
- **Depends on:** M0 (frozen contracts) · M1 (loaders, `reconcile`, `resolveRepoSettings`) · M2 (GitLab adapter: discovery + setup) · M3 (`Exec` real impl; workspace dir for `--attach`) · M4 (handoff — only as a state the views *read*, never invoked) · **M5 (daemon loop)** — M6's `dist/daemon.js` entry is a one-line shell over M5's exported daemon `main`; M5 also owns the logs-cache writer M6 reads. M5's plan does not exist yet → see Open dependencies OD-1/OD-2.
- **Decisions one-liner:** Both packages are thin — every byte of real logic (config append, forge reads, state derivation, setup) lives in `core` and is injected through the §0.8 `Exec` seam so CLI/web tests run hermetically with a fake forge + fake git; the web is read-only except for the single `add`-repo path that calls the *same* core routine as `maestro add`; commit-by-default stages an **explicit path** (`maestro.config.yaml`) only — never `.env`, never `git add -A`.

---

## Goal

Ship two thin shells over `core`:

1. **CLI (`packages/cli`)** — `maestro add <url>`, `status`, `list`, `logs`; the daemon entry `dist/daemon.js` (§14 systemd target); and `maestro run <issue> --attach`, which launches an **interactive** `claude` in that issue's workspace for a human to drive — explicitly **not** the headless daemon path (§8). `add` appends a repo entry to `maestro.config.yaml`, commits by default (`--no-commit` to opt out), and triggers §11 label/board setup by reusing the core adapter — no special code path.
2. **Web (`packages/web`)** — a read-only dashboard rendering per-repo / per-issue lifecycle state derived **live** from the forge (via the adapter) plus the gitignored `logs/` cache, and an add-repo form whose POST calls the same core `add` routine.

Both build their views by reading the forge through the adapter and the logs cache — consistent with statelessness (§3): there is no DB; the dashboard is a projection of GitLab + `logs/`.

All command logic is **pure data-assembly functions** in/under `core` (or a thin CLI-local layer that only marshals argv → core calls); the HTTP layer and argv layer are dumb adapters tested separately from the data assembly.

---

## Scope

**In:**
- CLI argument parsing for `add` / `status` / `list` / `logs` / `run --attach` (a small declarative parser; one command table, no business logic in it).
- `add`: resolve+validate the URL → infer forge (`inferForge`, M1) → append a `repos[]` entry to `maestro.config.yaml` preserving formatting/comments → invoke §11 setup via the adapter (`ensureLabels` + `ensureBoard?` + the §16 bootstrap `createIssue` when no WORKFLOW.md) → commit by default (`--no-commit` opts out), staging `maestro.config.yaml` **explicitly**.
- `status` / `list` / `logs`: render a **core-produced snapshot** (a view assembled by core from `listAssignedOpenIssues`/`getSnapshot` + the logs cache); CLI only formats it to text.
- `run <issue> --attach`: resolve the issue's workspace dir (M3 manager), spawn an **interactive** `claude` there with TTY/interactive flags and **no** `-p`/`--output-format stream-json`; prove it does not route through the daemon/headless runner.
- `dist/daemon.js` entry: a shell that imports and calls M5's daemon entrypoint; built by tsup alongside `dist/cli.js` (§0.1 build target).
- Web: a thin HTTP server exposing read-only GET views over the same core view-assembly functions, plus one POST `/repos` that calls the identical core `add` routine the CLI uses.
- Pure view-assembly functions tested independently of HTTP and of argv.

**Out (other milestones / deferred):**
- The daemon **loop** itself — tick scheduling, slot accounting, cleanup sweep, calling `reconcile`/runner/handoff — is **M5**. M6 only provides the `dist/daemon.js` *entry shell* and consumes M5's exported `main`.
- The logs-cache **writer** (what the daemon appends per tick) — **M5** owns the format + write path; M6 only **reads** it (OD-2).
- Any forge mutation from the web beyond the `add`/onboarding path — the dashboard is strictly read-only (§8).
- Pixel/visual styling, CSS frameworks, client-side JS richness — out. The web is a minimal server-rendered read-only view; tests target data assembly, not rendering. (Frontend polish is non-goal for v1.)
- GitHub adapter (M7); the CLI/web are forge-agnostic via the adapter, so they need no GitHub-specific code.
- Auth/authz on the web server (it's a local-dev dashboard, §14 "run maestro locally"). Flagged in Cross-cutting; hardening is M8.

---

## TDD slices

Convention: each slice is a named **failing** vitest test first, then minimal impl. All forge/git/claude I/O goes through an injected **fake `Exec`** (§0.8) and/or an injected **fake `ForgeAdapter`** (§0.3); no test touches a real binary, network, or `git`. The config-append slices use an **OS tmpdir** holding a real `maestro.config.yaml` to prove formatting/staging on actual bytes. No test starts a real HTTP listener except the one wiring slice (W-3), which binds `127.0.0.1:0`.

### Part A — CLI argument parsing (`packages/cli/src/parse.ts`)

**A1 — command table dispatch.**
Test `routes each verb to its handler`: parsing `['add','gitlab.com/g/r']`, `['status']`, `['list']`, `['logs','42']`, `['run','42','--attach']` yields a typed `ParsedCommand` discriminated union with the right `kind` and captured positionals. Unknown verb → a typed `{kind:'help'}` (or usage error), never a throw with a stacktrace. Green: a small hand-rolled parser over a command spec table (no heavy dep; keep it thin).

**A2 — flag parsing: `--no-commit`, `--attach`.**
Test `parses boolean flags`: `add` defaults `commit:true`; `--no-commit` → `commit:false`. `run 42 --attach` → `attach:true`; `run 42` without `--attach` → a usage error (attach is the only supported `run` mode in v1; see Open dependency OD-3 on whether non-attach `run` exists). Green: flag handling in the parser.

**A3 — bad input is a clean usage error, not a crash.**
Test `missing required positional yields usage`: `add` with no URL → typed usage error naming the missing arg; exit-code mapping (usage → nonzero) asserted at the boundary. Green: validation in parse; the `main` wrapper maps a usage error to a nonzero exit without printing a stacktrace.

### Part B — `add` (config append + commit toggle + setup) (`packages/cli/src/commands/add.ts` → calls `core`)

The real work lives in a **core** routine `addRepo(input, deps)` where `deps = { exec, adapterFor, configPath }`; the CLI command is a marshaller. The web POST calls the same `addRepo`. (If `addRepo`'s home is core vs a shared cli/web module is an Open dependency — OD-4 — but its *signature and behavior* are pinned here.)

**B1 — appends a `repos[]` entry, preserving the file.**
Test `appends repo to maestro.config.yaml without clobbering`: a tmpdir config with existing `defaults`/`forges`/two `repos` + a trailing comment → `addRepo({url:'gitlab.com/g/new'})` appends a third repo entry; re-parse via `ConfigSchema` (M1 loader) round-trips and now contains the new url; existing entries + the comment survive. Assert it does **not** rewrite via naive `JSON→YAML` dump that drops comments (use a comment-preserving YAML edit, or append-in-place — pin the approach in impl; the test enforces comment survival). Green: load text → locate/append under `repos:` → write.

**B2 — idempotent: adding an already-watched url is a no-op (or clear error).**
Test `adding a duplicate url does not double-append`: config already lists `gitlab.com/g/r`; `addRepo` for the same url leaves `repos` length unchanged and returns a typed `{added:false, reason:'already-watched'}` (not a throw). Pins idempotency consistent with the rest of the system (§13). Green: dedupe check before append.

**B3 — forge inference + validation rejects garbage.**
Test `rejects an unparseable / unknown-host url`: a url whose host matches no `forges.*` entry → typed error, **no** file mutation, **no** adapter call. Reuses `inferForge` (M1). Green: validate before any write/side-effect.

**B4 — triggers §11 setup via the adapter (labels + board + bootstrap issue).**
Test `add invokes label/board setup through the adapter`: inject a **fake `ForgeAdapter`**; `addRepo` calls `ensureLabels(repo, labelNames(forge).…)` and, for GitLab, `ensureBoard?(repo, orderedLabels)` exactly once each; for a repo with **no WORKFLOW.md** it also calls `createIssue` with the §16 "Let's define my workflow" bootstrap issue assigned to the bot. Assert label set comes from `labelNames(forge)` (§0.7) — no hardcoded strings. Assert `ensureBoard` is **not** called when `manage_board:false` or forge is GitHub (undefined method, §0.3). Green: after append, resolve forge → get adapter → run setup. **The setup path reuses M2's adapter verbatim; no M6-special onboarding code (§16).**

**B5 — commit by default stages ONLY the config path.**
Test `commits with an explicit path, default on`: inject a fake `Exec`; `addRepo({commit:true})` runs `git add maestro.config.yaml` (the explicit path, relative to repo root) then `git commit -m <imperative ≤72-char subject>`. **Assert the staged arg list contains exactly `maestro.config.yaml` and NOT `.`, `-A`, `.env`, or any wildcard.** Assert the commit subject is imperative mood and ≤72 chars (e.g. `Add <project> to maestro watchlist`) and carries **no `Co-Authored-By`** trailer. Green: two `Exec.run('git', …)` calls behind a `commitConfig(exec, path, subject)` helper.

**B6 — `--no-commit` skips git entirely.**
Test `no-commit makes zero git calls`: `addRepo({commit:false})` appends the file but the fake `Exec` records **zero** `git` invocations. Green: gate the commit helper on the flag.

**B7 — secrets never enter the committed change.**
Test `commit never stages .env and config carries only token_env name`: the appended entry references the forge by `token_env` **name** (already in `forges:`); `addRepo` writes no token value into `maestro.config.yaml`; the staged path set excludes `.env`. Cross-checks §5/§0.11 at the CLI boundary. Green: assertion-only over B1/B5 behavior (no new code if B1/B5 correct).

### Part C — `status` / `list` / `logs` rendering (`packages/cli/src/commands/{status,list,logs}.ts`)

These render a **core view snapshot**. The snapshot shape is **not in M0** → OD-2. Tests therefore drive a `renderX(view)` pure formatter against a **fake view object** matching the proposed shape; the *assembly* of that view from the adapter+logs is pinned in Part E and gated on OD-2.

**C1 — `list` renders per-repo lifecycle counts.**
Test `list renders one row per watched repo with state tallies`: feed a fake view = repos each with a count per `LifecycleState` (`new`/`in-progress`/`in-review`/`blocked`); the formatter emits one line per repo with the tallies. Assert state labels match the §0.2 `LifecycleState` union (no invented state names). Green: pure `renderList(view): string`.

**C2 — `status <issue>` renders one issue's derived lifecycle.**
Test `status shows derived state for an issue`: fake view for a single issue carrying its derived `LifecycleState`, MR url, draft flag, approval flag, and last log line → formatter prints them. The **derivation** reuses core (the same state-derivation the reconciler uses, §0.4 rule 2) — the CLI must not re-implement state logic (assert by having the view carry an already-derived `state`, produced by a core helper — OD-5). Green: pure `renderStatus(view): string`.

**C3 — `logs <issue>` tails the gitignored logs cache.**
Test `logs renders recent cache lines for an issue`: feed a fake logs reader returning N recorded lines for issue 42 → formatter prints them newest-last (or as recorded). Missing log → a clear "no logs yet" message, not an error. Green: pure `renderLogs(lines): string`; the **reader** is injected (OD-2 pins the cache format/owner = M5).

**C4 — empty/edge rendering.**
Test `renders gracefully with zero repos / zero issues`: empty view → a friendly "nothing watched / nothing in flight" line, never a crash or a blank panic. Green: guard the formatters.

### Part D — `run <issue> --attach` spawns INTERACTIVE claude (`packages/cli/src/commands/run.ts`)

**D1 — resolves the issue workspace and spawns interactive claude.**
Test `attach spawns claude in the issue workspace with a TTY`: inject a fake workspace resolver (M3) returning `<root>/g__r/42` and a fake spawn seam; `run 42 --attach` spawns `claude` with `cwd === <that dir>` and **interactive** flags (inherit stdio / allocate a TTY — pin the exact mechanism in impl, e.g. `stdio: 'inherit'` via a dedicated interactive-spawn path, since the headless `Exec` seam is built for captured/`stream` output, see OD-6). Green: an `attach(issueIid, deps)` that resolves the dir then spawns interactively.

**D2 — `--attach` does NOT go through the headless daemon/runner path.**
Test `attach never invokes the headless runner`: assert the spawn argv contains **no** `-p`, **no** `--output-format`, **no** `stream-json`, and that the `ClaudeRunner` (§0.9, M3) is **not** constructed/called. This is the §8 guarantee ("interactive mode can't be daemon-driven"; `--attach` is local-dev only). Green: `attach` uses the interactive-spawn path exclusively; a test double for `ClaudeRunner` records zero calls.

**D3 — missing workspace is a clear error, not a silent claude launch.**
Test `attach fails clearly when no workspace exists`: resolver reports the issue has no live workspace → typed error telling the user to let the daemon start the issue first (or that the issue isn't in progress); claude is **not** spawned. Green: guard before spawn.

### Part E — Web data assembly (pure) (`packages/web/src/views/*.ts`)

Pure functions that turn `(adapter, configStore, logsReader)` into serializable view objects. **No HTTP here.** These are the same assembly functions the CLI Part C formatters consume (shared in core/a shared module — OD-4/OD-5).

**E1 — `assembleDashboard` projects forge + logs into a view.**
Test `assembles a read-only dashboard view from adapter + logs`: inject a fake adapter whose `listAssignedOpenIssues`/`getSnapshot` return canned §0.2 issues/MRs, and a fake logs reader; `assembleDashboard(deps)` returns a view with per-repo issues, each carrying a **core-derived** `LifecycleState` and the latest log line. Assert it makes **only read** adapter calls (`listAssignedOpenIssues`, `getSnapshot`, `getIssueState`) and **zero** mutating calls — the read-only guarantee, proven by a call recorder. Green: assembly fn.

**E2 — derived state matches reconciler state derivation.**
Test `dashboard state equals core state derivation`: for a snapshot the reconciler would call `in-review`, the view shows `in-review`. Pins that the dashboard and the daemon agree (both read the same core derivation, §0.4) — no divergent web-only state machine. Green: reuse the core derivation helper (OD-5).

**E3 — assembly tolerates a repo the forge can't reach.**
Test `a failing adapter call degrades to an error tile, not a 500`: one repo's adapter call rejects → that repo's view entry carries an `error` marker; other repos still render. Pins resilience (the dashboard is a best-effort projection, §3). Green: per-repo try/catch in assembly.

### Part F — Web HTTP layer (thin) (`packages/web/src/server.ts`)

**F1 — GET routes call assembly and serialize, never mutate.**
Test `GET / and /repos/:id return assembled views`: with an injected fake assembly fn, the handlers return its output serialized (HTML or JSON — pin one; JSON is simplest to assert) with a 200. Assert **no** handler for any GET path can reach a mutating adapter method (the adapter handed to GET handlers is a read-only-narrowed interface — OD-7). Green: route table → assembly → serialize.

**F2 — POST `/repos` calls the SAME core `add` routine as the CLI.**
Test `add-repo form posts to the shared addRepo`: POST `/repos` with `{url}` invokes the **identical** `addRepo` used by `maestro add` (assert by injecting a spy `addRepo` and checking the HTTP handler calls it with the parsed url + default `commit:true`); on success returns a redirect/200, on a duplicate/validation error returns a 4xx with the typed reason — never a 500 stacktrace. Pins §8 "same effect as `maestro add`." Green: one POST handler delegating to `addRepo`.

**F3 — wiring smoke (the only socket-binding test).**
Test `server starts, serves GET /, accepts POST /repos`: bind `127.0.0.1:0`, issue a real GET and a real POST against in-process fakes, assert status codes; close. Keeps the HTTP plumbing honest without a real forge. Green: the server factory `createServer(deps)` returning a `listen`able handle.

### Part G — daemon entry shell (`packages/cli/src/daemon.ts` → `dist/daemon.js`)

**G1 — `dist/daemon.js` calls M5's daemon main.**
Test `daemon entry delegates to core/M5 daemon main`: the entry imports M5's exported `runDaemon`/`main` and calls it (assert via a spy that the entry body is a one-call shell — no loop logic in cli). Because M5 does not exist yet (OD-1), this slice is **written but `xit`-skipped with a pointer to OD-1**; M6 ships the entry as a thin `import { main } from '@maestro/core/daemon'; void main()` stub guarded so typecheck passes once M5 lands. Assert tsup is configured to emit `dist/daemon.js` as a second entry (§0.1, §14). Green (once OD-1 resolved): the one-line shell.

---

## Exit gate (checklist)

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean; new code lives only under `packages/cli/src` and `packages/web/src`, plus any **shared** assembly/`addRepo` routine in `packages/core/src` (no forge-specific code in cli/web).
- [ ] Argument parser routes all five verbs; bad input → typed usage error + nonzero exit, never a stacktrace (A1–A3).
- [ ] `add`: appends `repos[]` preserving comments (B1), idempotent on duplicates (B2), validates/​infers forge before any side-effect (B3), runs §11 setup via the adapter reusing M2 (B4), and on `--no-commit` makes **zero** git calls (B6).
- [ ] **Commit-by-default stages exactly `maestro.config.yaml`** — a test asserts the staged arg set excludes `.`, `-A`, `.env`, and wildcards; subject is imperative ≤72 chars with **no `Co-Authored-By`** (B5, B7).
- [ ] `status`/`list`/`logs` formatters render from a core view snapshot using only §0.2 `LifecycleState` names; state is **core-derived**, not re-implemented in cli (C1–C4, gated on OD-2/OD-5).
- [ ] `run --attach` spawns interactive `claude` in the issue workspace and is **proven not** to use `-p`/`stream-json`/`ClaudeRunner` (D1–D2); missing workspace fails clearly (D3).
- [ ] Web data-assembly functions are pure, tested without HTTP, make **only read** adapter calls (read-only guarantee proven by a call recorder), and degrade per-repo on forge errors (E1–E3).
- [ ] Web HTTP layer: GET routes can't reach a mutating adapter method (read-only-narrowed interface); POST `/repos` calls the **identical** `addRepo` as the CLI (F1–F2); a single socket-binding smoke test passes (F3).
- [ ] Dashboard derived state equals reconciler state derivation for the same snapshot (E2) — no divergent web state machine.
- [ ] `dist/daemon.js` is emitted by tsup and is a thin shell over M5's daemon main (G1 — skipped-with-pointer acceptable for the gate while OD-1 open; the gap is logged in §0.10).
- [ ] No contract type redefined inline; every read-model/view type, logs-cache reader, and `addRepo`/derivation home is in **Open dependencies**, not invented in cli/web. Any adopted shape is recorded in M0 §0.10 before it lands.

---

## Cross-cutting (QA + Security)

**QA:**
- The split is the whole point: **data assembly is pure and unit-tested** (Parts C, E); the argv layer (A) and HTTP layer (F) are dumb marshallers with their own thin tests. UI tests assert *data*, never pixels — there is no visual rendering to test, by design (web is non-goal styling for v1).
- One socket-binding test only (F3); everything else is in-process with fakes. The stall/latency-prone real forge is never hit.
- Edge rendering (C4) and per-repo degradation (E3) are explicit assertions — a dashboard that 500s because one repo's token expired is a regression, not an inconvenience.

**Security:**
- **Web read-only guarantee.** GET handlers receive a **read-only-narrowed** adapter interface (OD-7) so a mutating call is a *type error*, not just a convention; E1 proves zero mutating calls via a recorder. The only write path is POST `/repos` → the shared `addRepo` (the same one `maestro add` uses, §8). No other forge mutation is reachable from the web.
- **No token in CLI output or logs.** `status`/`list`/`logs` render only forge-public data + log lines; a test asserts no rendered string contains a `process.env[token_env]` value (reuse the M3 suite-wide secret-grep helper). The logs reader surfaces only what the daemon wrote; M5 owns keeping secrets out of the cache (OD-2 notes this obligation), but M6 adds the boundary assertion.
- **Commit-by-default must never stage secrets.** B5/B7 assert explicit-path staging (`git add maestro.config.yaml`, never `git add .`/`-A`) and that `.env` is excluded; this honors both §5 ("secrets never enter git") and the user's git rules (explicit paths, imperative ≤72-char subject, no `Co-Authored-By`). `.gitignore` already covers `.env` (M0 §0.1/§0.11); M6 relies on it **and** on explicit staging — defense in depth, since `git add -A` would have bypassed `.gitignore` only for already-tracked files, but explicit-path staging removes the question entirely.
- **`run --attach` runs interactive claude on the host** with the human's logged-in auth (§8) — local-dev only. It inherits the §13 host-workspace tradeoff but is human-driven, so prompt-injection (§13.1) is moot (a human is at the keyboard). Flagged, not a new risk surface.
- **Web has no authn/authz in v1** (local-dev dashboard, §14). Acceptable because it's read-only + the single `add` path, bound to localhost by default. Network exposure hardening is M8. Flagged here so it isn't a silent assumption.

---

## Open dependencies

Genuine gaps where the frozen contracts under-specify an M6 surface. Each is non-blocking for *writing the tests* (the test pins the behavior against the proposed shape); the impl waits on central reconciliation + an M0 §0.10 entry. **No divergent type invented in cli/web.**

- **OD-1 — M5 (daemon loop) does not exist yet.** *Gap:* M6's `dist/daemon.js` entry (§14) is a shell over M5's daemon `main`, and M5 owns the tick loop, slot accounting, cleanup sweep, and the logs-cache writer. The M5 plan/file is absent (`plans/maestro-05-daemon-loop.md` not present). *Why it blocks:* G1 can't import a symbol that doesn't exist; the daemon entry can't be wired. *Proposed fix:* M5 exports a single `async function runDaemon(deps): Promise<void>` (or `main()`) from `@maestro/core` (or `@maestro/cli`-internal). M6 G1 is written and skipped-with-pointer until M5 lands; the entry ships as a thin guarded stub. Sequencing note: M6 depends on M5 — write/land M5 first or land G1's impl in M5's wake.

- **OD-2 — no logs-cache read-model / format in the contracts.** *Gap:* §3/§4 say `logs/` is a gitignored cache the views read, but no contract defines its on-disk format, per-issue layout, or a reader interface. `status`/`logs`/the dashboard all consume it. *Why it matters:* C3/E1 read it; without a frozen format M6 and M5 (the writer) diverge. *Proposed fix (M5-owned, add to §0.10):* M5 defines the cache layout (e.g. `logs/<repo-slug>/<iid>.ndjson`, append-only, one record per tick event) and exports a **reader** `readIssueLog(repo, iid): LogLine[]` + a `LogLine` type. M6 consumes the reader only; tests inject a fake reader matching the proposed shape. M5 also owns keeping secrets out of what it writes.

- **OD-3 — does a non-`--attach` `maestro run` mode exist?** *Gap:* §8 names only `run <issue> --attach` (interactive, local-dev). It's unstated whether `run` without `--attach` is an error or a headless one-shot. *Why it matters:* A2 must decide. *Proposed fix:* in v1, `run` **requires** `--attach` (the daemon is the only headless path; a one-shot headless `run` would duplicate the daemon tick and bypass slot/cleanup accounting). `run` without `--attach` → usage error. Confirm centrally; M6 implements require-`--attach`.

- **OD-4 — home of the shared `addRepo` routine (core vs shared cli/web module).** *Gap:* both `maestro add` and the web POST must call the **same** routine (§8). M0 places "all real logic in core" but doesn't name an `addRepo`. *Why it matters:* B-slices and F2 both depend on one shared implementation; two copies = the rot M0 forbids. *Proposed fix:* `addRepo(input, deps): Promise<AddResult>` lives in `packages/core/src/onboarding/add-repo.ts` (it's config+adapter logic, not UI). Its signature/behavior are pinned in Part B; add `AddResult` + `addRepo` to §0.10. CLI and web both import it.

- **OD-5 — no exported "derive `LifecycleState` from a snapshot" helper.** *Gap:* §0.4 rule 2 describes state derivation *inside* `reconcile`, but `reconcile` returns an `Intent`, not a `LifecycleState`. The CLI/web need the **state** for display, and must not re-implement it (else they drift from the reconciler). *Why it matters:* C2/E2 require a single source of derivation truth. *Proposed fix:* expose `deriveLifecycleState(snapshot, settings): LifecycleState` from core (factored out of the reconciler's internal `deriveState` per M1 slice A15). Add to §0.10; M1 likely already has the private function — promote it to an export. M6 consumes it read-only.

- **OD-6 — interactive spawn primitive for `--attach`.** *Gap:* the §0.8 `Exec` seam models captured `run`/line-`stream` output — neither is an interactive, stdio-inherited, TTY-attached spawn. `--attach` needs the latter. *Why it matters:* D1 must spawn claude with the user's terminal. *Proposed fix:* add an `attach(cmd, args, opts): Promise<number>` (inherits stdio, returns exit code) to the `Exec` seam, fake-injectable like the rest — or a separate `InteractiveSpawn` seam if mixing it into `Exec` muddies the headless contract. This is a **contract amendment to §0.8** (add a §0.10 row). Flagging: I'm not silently overloading `Exec.run`; the interactive path is semantically distinct (no capture, TTY) and should be its own method.

- **OD-7 — read-only-narrowed adapter interface for the web GET path.** *Gap:* `ForgeAdapter` (§0.3) bundles reads + mutations. The web read-only guarantee is strongest if GET handlers can only *see* the read methods (`listAssignedOpenIssues`, `getSnapshot`, `getIssueState`) — a compile-time guarantee, not a convention. *Why it matters:* F1/E1 assert no mutating call is reachable; a narrowed type makes that a type error. *Proposed fix:* define `ReadOnlyForgeAdapter = Pick<ForgeAdapter, 'listAssignedOpenIssues'|'getSnapshot'|'getIssueState'>` in contracts; the dashboard assembly + GET handlers take that, the `add` path takes the full adapter. Add to §0.10. Cheap, purely additive (a `Pick`, no new behavior).
