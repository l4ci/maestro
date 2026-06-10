// Lifecycle moves (#78) — the write-side label table, tested through the pure
// interface only: exact { set, unset } arrays per move per forge, the role-aware
// unblock, and the load-bearing invariant that only begin-work-from-plan ever
// consumes the human-set todo definition gate (#29).

import { describe, expect, it } from 'vitest';
import { labelNames } from '../src/contracts/labels.js';
import { type LifecycleMove, lifecycleMove } from '../src/reconciler/transitions.js';

const ALL_MOVES: LifecycleMove[] = [
  'begin-work',
  'begin-work-from-plan',
  'enter-define',
  'resume-from-review',
  'unblock',
  'park-blocked',
  'enter-review',
  'mark-queued',
  'retract-queued',
];

describe.each([
  ['gitlab', labelNames('gitlab'), '::'],
  ['github', labelNames('github'), ':'],
] as const)('lifecycleMove — exact label arrays on %s', (_forge, labels, sep) => {
  it('begin-work: +in-progress −queued (start-new, #53)', () => {
    expect(lifecycleMove('begin-work', labels)).toEqual({
      set: [`maestro${sep}in-progress`],
      unset: [`maestro${sep}queued`],
    });
  });

  it('begin-work-from-plan: +in-progress −todo,backlog,queued (run-plan, #29)', () => {
    expect(lifecycleMove('begin-work-from-plan', labels)).toEqual({
      set: [`maestro${sep}in-progress`],
      unset: [`maestro${sep}todo`, `maestro${sep}backlog`, `maestro${sep}queued`],
    });
  });

  it('enter-define: +backlog −queued (run-define, #29)', () => {
    expect(lifecycleMove('enter-define', labels)).toEqual({
      set: [`maestro${sep}backlog`],
      unset: [`maestro${sep}queued`],
    });
  });

  it('resume-from-review: +in-progress −in-review (apply-changes-requested, §7)', () => {
    expect(lifecycleMove('resume-from-review', labels)).toEqual({
      set: [`maestro${sep}in-progress`],
      unset: [`maestro${sep}in-review`],
    });
  });

  it('park-blocked: +blocked −in-progress (bounce cap + mark-blocked, §0.9)', () => {
    expect(lifecycleMove('park-blocked', labels)).toEqual({
      set: [`maestro${sep}blocked`],
      unset: [`maestro${sep}in-progress`],
    });
  });

  it('enter-review: +in-review −in-progress (proof-only + handoff step 5, §7)', () => {
    expect(lifecycleMove('enter-review', labels)).toEqual({
      set: [`maestro${sep}in-review`],
      unset: [`maestro${sep}in-progress`],
    });
  });

  it('mark-queued: +queued, nothing unset (capacity marker, #53)', () => {
    expect(lifecycleMove('mark-queued', labels)).toEqual({
      set: [`maestro${sep}queued`],
      unset: [],
    });
  });

  it('retract-queued: −queued, nothing set (cleanup sweep, #53)', () => {
    expect(lifecycleMove('retract-queued', labels)).toEqual({
      set: [],
      unset: [`maestro${sep}queued`],
    });
  });
});

describe('lifecycleMove — role-aware unblock (#29)', () => {
  it.each(['gitlab', 'github'] as const)(
    'implement role restores in-progress and clears blocked (%s)',
    (forge) => {
      const labels = labelNames(forge);
      expect(lifecycleMove('unblock', labels, 'implement')).toEqual({
        set: [labels.inProgress],
        unset: [labels.blocked],
      });
      // The tick defaults intent.role ?? 'implement' — the table must match.
      expect(lifecycleMove('unblock', labels)).toEqual(
        lifecycleMove('unblock', labels, 'implement'),
      );
    },
  );

  it.each(['define', 'plan', 'review'] as const)(
    'non-implement role (%s) sets NO stage label — artifacts carry the stage',
    (role) => {
      const labels = labelNames('gitlab');
      expect(lifecycleMove('unblock', labels, role)).toEqual({
        set: [],
        unset: [labels.blocked],
      });
    },
  );
});

describe('lifecycleMove — invariants', () => {
  it('only begin-work-from-plan ever unsets the human-set todo gate (#29)', () => {
    for (const forge of ['gitlab', 'github'] as const) {
      const labels = labelNames(forge);
      for (const move of ALL_MOVES) {
        for (const role of ['implement', 'define', 'plan', 'review'] as const) {
          const { set, unset } = lifecycleMove(move, labels, role);
          if (move !== 'begin-work-from-plan') {
            expect(unset, `${move} (${role}, ${forge}) must not clear the todo gate`).not.toContain(
              labels.todo,
            );
          }
          // The daemon never APPLIES the gate either — todo is human-set only.
          expect(set, `${move} (${role}, ${forge}) must not set the todo gate`).not.toContain(
            labels.todo,
          );
        }
      }
    }
  });
});
