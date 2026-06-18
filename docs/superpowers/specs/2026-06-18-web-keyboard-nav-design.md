# Web dashboard: keyboard navigation + GitHub-true polish

**Date:** 2026-06-18
**Scope:** `packages/web/src/page.ts` (the single static HTML string) and `packages/web/test/page.test.ts`.

## Goal

Make the read-only dashboard navigable from the keyboard, GitHub/Gmail style, and
read more like real GitHub (system-sans chrome, monospace reserved for code-like
tokens). Polish only — the card → issue-table layout is unchanged.

## Hard constraints (unchanged)

- One static HTML string. No framework, no build step.
- JSON read-model, routes, 5s poll, keyed reconcile, create/update parity all stay.
- Security discipline holds: `textContent` only, `safeUrl` on every forge URL, never
  `innerHTML` (§13.1). New chrome (filter input, help dialog) carries no forge data.

## 1. Keyboard navigation

A module-level `selectedKey` (the existing `repoUrl#iid` row key) is the single
source of truth for selection. It lives OUTSIDE the reconcile, exactly like collapse
and expand state, so it survives the 5s poll. After every `render()` a post-pass
`applySelection()` re-finds `tr[data-key=selectedKey]` and paints `.selected`; if the
selected issue vanished from the poll, selection falls back to the nearest still-visible
row (or clears when the board is empty).

**Navigable rows** = visible `tr.issue` only. Excluded: detail rows, `~error`/`~empty`
placeholders, rows inside a collapsed repo card (`table[hidden]`), and rows hidden by
the filter (`.filtered`).

| Key | Action |
|-----|--------|
| `j` / `k` | move selection down / up across visible issue rows |
| `o` / `Enter` | toggle the selected issue's detail panel (existing `toggleDetail`) |
| `g g` / `Shift+G` | select first / last visible row |
| `c` | collapse/expand the repo card that holds the selection |
| `/` | focus the filter input |
| `a` | open the Add Repo dialog (only when writes enabled / button visible) |
| `?` | toggle the shortcuts help overlay |
| `Esc` | close help → else clear+blur filter → else close the selected open detail |

A single `keydown` listener on `document`. While focus is in an `<input>` or an open
dialog, only `Esc` is honored (so typing a repo URL or a filter query is never
intercepted). `g` is a two-key prefix: a short-lived "pending g" flag set on first `g`,
consumed by the next key (`g` → top) and cleared on any other key or a timeout-free
reset (next keydown clears it). The selected row is scrolled into view with
`scrollIntoView({ block: 'nearest' })`.

## 2. Live filter (`/`)

A small `<input id="filter">` in the header. Filters the ALREADY-FETCHED view client
side — no API change. `applyFilter()` runs as a post-render pass (and on every `input`
event): it toggles a `.filtered` class on non-matching `tr.issue` rows and on repo
cards whose every issue is filtered out. Match is case-insensitive over the issue
title, `#<iid>`, and state. Empty query → nothing filtered. Hiding (not removing) keeps
keyed identity and the parity suite intact. After filtering, selection is re-validated
so a hidden selected row hands off to the nearest visible one.

## 3. Shortcuts overlay (`?`)

A static, centered `<dialog id="helpDialog">` listing the bindings above, opened with
the same `openDialog`/`closeDialog` modal helpers as Add Repo. Pure static markup in
the shipped HTML — no forge data flows through it, so no new security surface.

## 4. Typography / visual polish

- Body font → system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", …`).
  Monospace (`ui-monospace, …`) retained via a `.mono` rule for issue IDs (`td.iid`),
  the daemon worker count, and log lines — the code-like tokens.
- `.selected` row affordance: left accent bar (`--accent`) + subtle `--surface` bg, so
  the keyboard focus position is always obvious. Distinct from `:hover` and `.open`.
- Minor spacing/hierarchy tightening now that titles are sans. No layout restructure,
  no new palette entries (the palette is already GitHub's).

## What does NOT change

Architecture, routes, polling, reconcile, create/update parity, security model, the
add-repo write path. Net diff is additive: one input, one help dialog, one keydown
handler, the selection + filter helpers, and CSS.

## Testing

jsdom, driving the shipped artifact (existing harness). New cases:
- `j`/`k` move `.selected` across visible rows; wrap/stop at ends; skip collapsed and
  filtered rows.
- `o`/`Enter` toggle the selected detail panel; `Esc` closes it.
- `g g` / `Shift+G` jump to first / last.
- selection survives a poll (re-render) and falls back when the selected row vanishes.
- `/` filters rows by title/iid/state; clearing restores; a hidden selection hands off.
- key handlers are inert while typing in an input (except `Esc`).
- `?` toggles the help dialog.
- existing 105 tests stay green (parity, keyed identity, security, daemon, avatars).
