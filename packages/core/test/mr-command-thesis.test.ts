// Thesis guard (spec §6): the command-MR trigger is an additive parallel path. The issue
// reconciler must carry NO command-MR logic — the issue FSM stays the brain it was. (Task 1's
// shared `isHumanComment` extraction is deliberate and is not command-MR coupling.)

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('command-MR trigger leaves the issue reconciler unchanged in spirit', () => {
  it('reconcile.ts references no command-MR symbols', () => {
    const src = readFileSync(new URL('../src/reconciler/reconcile.ts', import.meta.url), 'utf8');
    for (const token of [
      'mr-command',
      'MrCommand',
      'decideMrCommand',
      'MR_COMMAND_REPLY_SENTINEL',
      'listAssignedOpenMergeRequests',
      'evaluateMrCommands',
    ]) {
      expect(src).not.toContain(token);
    }
  });
});
