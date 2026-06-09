// Pure meta-command router (#88). A standalone-MR `/maestro` instruction is a *daemon action*
// — not an agent run — when its leading verb is in the fixed vocabulary below. The agent has no
// forge token (§13.1), so `merge`/`close` must be performed by the daemon via the adapter.
//
// Leading-verb only, case-insensitive: a *pure* `merge`/`close` routes to the daemon; a mixed
// command like "review then merge" keeps `review` as the verb → null → the agent path (the
// deliberate v1 scope, issue #88 Q2a). Total, deterministic, side-effect free.

export type MetaCommand = 'merge' | 'close';

const VOCABULARY: ReadonlyArray<readonly [RegExp, MetaCommand]> = [
  [/^merge\b/i, 'merge'],
  [/^close\b/i, 'close'],
];

/**
 * Classify a stripped instruction (the text after `/maestro`, already trimmed by
 * `decideMrCommand`). Returns the daemon action when the leading verb matches the fixed
 * vocabulary, else null (route to the agent unchanged).
 */
export function metaCommandOf(instruction: string): MetaCommand | null {
  const s = instruction.trimStart();
  for (const [re, command] of VOCABULARY) {
    if (re.test(s)) return command;
  }
  return null;
}
