// Issue #92 — the shared trigger allowlist rule. One predicate, two callers (the
// issue trigger guard and the command-MR edge); these tests pin its fail-closed
// semantics so neither caller can drift.

import { describe, expect, it } from 'vitest';
import { isAuthorizedActor } from '../src/security/authorized-actor.js';

describe('isAuthorizedActor — fail-closed allowlist predicate', () => {
  it('an empty allowlist allows any named actor', () => {
    expect(isAuthorizedActor('anyone', [])).toBe(true);
  });

  it('an empty allowlist allows even an unidentified actor (no list ⇒ no rule)', () => {
    expect(isAuthorizedActor(undefined, [])).toBe(true);
  });

  it('a non-empty allowlist with a missing username fail-closes', () => {
    expect(isAuthorizedActor(undefined, ['maintainer'])).toBe(false);
  });

  it('a listed actor passes', () => {
    expect(isAuthorizedActor('maintainer', ['maintainer', 'owner'])).toBe(true);
  });

  it('an unlisted actor fails', () => {
    expect(isAuthorizedActor('random-public-user', ['maintainer', 'owner'])).toBe(false);
  });
});
