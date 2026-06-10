# #115 — Handoff: request review + ready-for-review comment

## Plan
- [ ] Model: add `reviewers: ForgeUser[]` to `MergeRequest` (forge-model.ts) + schema (forge-model-schema.ts)
- [ ] Normalizer GitHub: `requested_reviewers` → `reviewers` (+ RawPr field)
- [ ] Normalizer GitLab: `reviewers` → `reviewers` (+ RawMr field)
- [ ] Contract: add `requestReview(repo, mrIid, username)` to ForgeAdapter
- [ ] GitLab adapter: `requestReview` via `reviewer_ids`, guard on current reviewers
- [ ] GitHub adapter: `requestReview` via `/pulls/{n}/requested_reviewers`; skip when user==botUser; swallow 422
- [ ] Handoff: request review (guard mr.reviewers) → single ready comment (READY_SENTINEL, always @-mentions, MR link + 3 channels); drop assignMR call + silent-drop re-read + reviewPingBody/REVIEW_PING_SENTINEL
- [ ] Dashboard assemble.ts: reviewer from mr.reviewers[0]
- [ ] README handoff bullet: assignment → review request
- [ ] Tests: makeMR + daemon fake (+reviewers/+requestReview); rewrite handoff slices; crash-recovery; adapter requestReview tests; fix compiler-flagged MR literals
- [ ] Typecheck + full test suite green

## Decisions
- Adopt issue's candidate simplification: ONE ready comment (always @-mentions) covers native notify + non-collaborator drop + GitHub self-422. Single sentinel.
- GitHub author-422 avoided deterministically (PR author is always bot → skip when username==botUser); 422 still swallowed for non-collaborator case.
- `assignMR` kept on the adapter (still unit-tested) but unused by handoff.

## Review
All acceptance criteria met. Verification: `pnpm test` 801 pass (+4 new), `pnpm typecheck` clean, `pnpm lint` clean.

- AC1 ✅ handoff requests review (reviewer field); guard reads `mr.reviewers`
- AC2 ✅ ready comment after proof, MR link + 3 channels, idempotent via `READY_SENTINEL`
- AC3 ✅ non-collaborator + shared-account both notified — single always-@-mention ready comment is the safety net; GitHub skips self-request (botUser) and swallows 422
- AC4 ✅ README handoff bullet + state diagram updated
- AC5 ✅ handoff + crash-recovery tests rewritten green; added GitLab/GitHub `requestReview` adapter tests

Notes:
- Adopted the issue's candidate simplification: one comment, one sentinel, both failure modes covered (dropped the old re-read + `reviewPingBody`/`REVIEW_PING_SENTINEL`).
- `assignMR` kept on the adapter (still unit-tested capability) but no longer called by handoff; `mr.assignees` no longer read in production.
- GitLab `requestReview` mirrors `assignMR` (resolve id → `reviewer_ids`), relying on the same silent-drop-of-invalid behavior the file already assumes for assignees.
