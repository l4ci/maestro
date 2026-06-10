// The progress mirror (#86): a daemon-owned, marker-delimited region inside the MR
// description listing the branch's commit subjects — the FALLBACK "where it's at" when
// a session dies before emitting `mrDescription` (stall-kill, --max-turns hard exit).
// The agent-emitted todo stays the primary channel and owns everything OUTSIDE the
// markers; these transforms never modify a byte outside them. Both are PURE — the tick
// supplies the subjects (adapter.listMrCommits) and performs the compare-and-skip write.

export const PROGRESS_START = '<!-- maestro:progress:start -->';
export const PROGRESS_END = '<!-- maestro:progress:end -->';

/** Newest commits shown; older ones collapse into one "…and N earlier commits" line. */
export const PROGRESS_COMMIT_CAP = 50;

/**
 * Render the marker-delimited region for CHRONOLOGICAL commit subjects (oldest first,
 * newest last). Capped at the NEWEST 50 — the older overflow becomes one counted line
 * above the bullets. Empty input renders an em-dash placeholder (the region still
 * exists, so a reader sees "mirror live, nothing pushed yet" rather than nothing).
 */
export function renderProgressRegion(subjects: string[]): string {
  const shown = subjects.slice(-PROGRESS_COMMIT_CAP);
  const dropped = subjects.length - shown.length;
  const lines: string[] = [PROGRESS_START, '### Commits so far'];
  if (shown.length === 0) {
    lines.push('—');
  } else {
    if (dropped > 0) lines.push(`_…and ${dropped} earlier commit${dropped === 1 ? '' : 's'}_`);
    lines.push(...shown.map((s) => `- ${s}`));
  }
  lines.push(PROGRESS_END);
  return lines.join('\n');
}

/**
 * Replace the text between existing markers, or append the region (blank-line
 * separated) when absent. Idempotent: applying twice equals applying once. Text
 * outside the markers is byte-preserved — the replace path splices between the exact
 * marker offsets, and the append path only ever ADDS bytes after the existing text.
 * A corrupt region (a start marker without its end, or reversed order) falls through
 * to append rather than guessing a boundary and swallowing agent-authored text.
 */
export function upsertProgressRegion(description: string, subjects: string[]): string {
  const region = renderProgressRegion(subjects);
  const start = description.indexOf(PROGRESS_START);
  const end = start === -1 ? -1 : description.indexOf(PROGRESS_END, start + PROGRESS_START.length);
  if (start !== -1 && end !== -1) {
    return description.slice(0, start) + region + description.slice(end + PROGRESS_END.length);
  }
  if (description.trim() === '') return region;
  const sep = description.endsWith('\n\n') ? '' : description.endsWith('\n') ? '\n' : '\n\n';
  return description + sep + region;
}
