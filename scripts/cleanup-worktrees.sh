#!/usr/bin/env bash
# Sweep stale Claude Code agent worktrees under .claude/worktrees/.
#
# Agent sessions create one worktree per dispatched subagent; a session that ends
# without cleanup leaves them (and their branches) behind. This sweep removes a
# worktree only when ALL of these hold, so in-flight work is never touched:
#   1. it lives under <repo>/.claude/worktrees/
#   2. it is not locked (an active agent locks its worktree)
#   3. its checked-out branch tip is an ancestor of main (the work is merged)
#   4. it is older than MAX_AGE_HOURS (default 24), so today's sessions survive
# The merged branch is then deleted with `git branch -d` (git re-verifies the
# merge), and stale remote-tracking refs are pruned — unconditionally safe.
#
# Usage: cleanup-worktrees.sh [repo-dir]   (default: ~/Sync/Dev/maestro)
set -euo pipefail

repo="${1:-$HOME/Sync/Dev/maestro}"
max_age_hours="${MAX_AGE_HOURS:-24}"
cd "$repo"

now=$(date +%s)
removed=0

consider() {
  local path="$1" branch="$2" locked="$3"
  [ -n "$path" ] || return 0
  case "$path" in "$repo/.claude/worktrees/"*) ;; *) return 0 ;; esac
  if [ "$locked" = 1 ]; then
    echo "skip (locked, agent active): $path"
    return 0
  fi
  if [ -z "$branch" ]; then
    echo "skip (detached HEAD): $path"
    return 0
  fi
  if ! git merge-base --is-ancestor "$branch" main; then
    echo "skip (branch $branch not merged into main): $path"
    return 0
  fi
  local mtime age_h
  mtime=$(stat -c %Y "$path")
  age_h=$(((now - mtime) / 3600))
  if [ "$age_h" -lt "$max_age_hours" ]; then
    echo "skip (only ${age_h}h old): $path"
    return 0
  fi
  echo "remove (merged, unlocked, ${age_h}h old): $path [$branch]"
  git worktree remove --force "$path"
  git branch -d "$branch"
  removed=$((removed + 1))
}

# Parse `git worktree list --porcelain`: blank-line-separated blocks of
# `worktree <path>` / `branch refs/heads/<name>` / bare `locked` lines.
path="" branch="" locked=0
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path="${line#worktree }" ;;
    "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
    locked*) locked=1 ;;
    "")
      consider "$path" "$branch" "$locked"
      path="" branch="" locked=0
      ;;
  esac
done < <(git worktree list --porcelain; echo)

git worktree prune
git remote prune origin
echo "done: removed $removed stale worktree(s)"
