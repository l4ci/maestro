# Open-issue burndown plan (daemon paused)

18 open issues. Ordered by: land in-flight work first, then bugs, then
features — grouped into lanes that don't touch the same files so lanes can
run in parallel (worktree-isolated subagents).

## Phase 0 — land the recovered in-flight work (sequential, blocks Phase 2)

- [x] #12 — PR #30 merged. Recovered commit was src-only/incomplete: fixed 14
      stale tests, added behavior coverage (schema list forms, generateProofs,
      comment folding), documented list form in template.
- [x] #48 — PR #49 merged (plan → forge routing live).

Both PRs carry the recovered agent commits; CI green. They overlap in
`tick.ts` → strictly sequential.

## Phase 1 — three parallel lanes

### Lane A — core daemon bugs (sequential within lane: shared files)
- [x] #55 — PR #59 merged: catch-up push / rescue-ref parking.
- [x] #56 — PR #61 merged: atomic .trash eviction, unpushed-work refusal,
      remnant re-clone.
- [x] #27 — PR #64 merged: --filter=blob:none default, clone_filter config,
      persisted name-only credential helper for lazy fetches.
- [x] #47 — PR #63 merged: RateLimitGate (CLI reset time or capped
      exponential), spawn-skip as no-op, healthy-run clear.

### Lane B — dashboard (packages/web; sequential within lane: shared render code)
- [x] #35 — PR #58 merged (agent) + XSS hardening (safeUrl allowlist).
- [x] #37 — PR #62 merged (agent): avatars via safeUrl, initials fallback.
- [x] #39 — PR #66 merged (agent): max-of-signals last-activity line.
- [x] #40 — PR #68 merged (agent): heartbeat file + header indicator.
- [x] #43 — PR #69 merged (agent): title/favicon badge + sort-to-top
      (notifications dropped — the issue body excludes them).
- [x] #44 — PR #70 merged (agent): themed palette vars + narrow layout.
- [x] #41 — PR #73 merged (agent): drill-down detail row, plan progress,
      fixed dead route.
- [x] #9  — PR #60 merged (agent): writes off unless MAESTRO_DASHBOARD_TOKEN,
      bearer + timingSafeEqual, 404 when disabled, UI form hidden.

### Lane C — CLI (independent)
- [x] #28 — PR #57 merged (agent): `maestro daemon` subcommand.

## Phase 2 — features that need merged groundwork (after Phase 0 + Lane A)

- [x] #25 — PR #65 merged: structured comments + contract demands.
- [x] #53 — PR #67 merged: queued marker + by-label retraction on unassign.
- [x] #29 — design agreed on-issue, then P1 #71 (role prompts), P2 #72
      (stage machine: deriveStage from artifacts, blocked as modifier,
      human definition gate, maestro:queued rename), P3 #74 (internal
      review gate, bounce cap, escalation).

## Review

All 18 original issues closed + 2 bugs found and fixed along the way
(#55 reset data loss, #56 non-atomic cleanup — both discovered while
recovering the agents' lost workspace commits). 21 PRs merged. Final
test count 546 (was 375 at start). Notable patterns that worked:

- Worktree-isolated subagents per dashboard issue, merged sequentially
  through CI — zero lost work, two real conflicts total.
- Security sweep caught an XSS (raw href on the keyed update path);
  the allowlist discipline then carried into avatars/drill-down.
- For #29 the issue's own "design before implementing" note was
  honored: proposal posted on-issue, approved, then three independently
  shippable slices, each keeping legacy repos byte-identical.
