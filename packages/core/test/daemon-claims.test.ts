import { describe, expect, it } from 'vitest';
import { Claims } from '../src/daemon/claims.js';

// The claim lifecycle (#91), tested THROUGH its interface only: open, duplicate
// open → null, slotAvailable under both caps, holdSlot, close releases slot and
// uniqueness together, double-close is a no-op. SlotAccountant/InFlightSet stay
// internal — nothing here reaches behind Claims.

describe('Claims.open — uniqueness admission (#18)', () => {
  it('admits a unit once and returns null while it is in flight', () => {
    const claims = new Claims(4);
    const first = claims.open('repoA', 7);
    expect(first).not.toBeNull();
    expect(claims.open('repoA', 7)).toBeNull(); // duplicate → already in flight
  });

  it('distinguishes iids and repo keys', () => {
    const claims = new Claims(4);
    expect(claims.open('repoA', 7)).not.toBeNull();
    expect(claims.open('repoA', 8)).not.toBeNull(); // other iid, same repo
    expect(claims.open('repoB', 7)).not.toBeNull(); // same iid, other repo
  });

  it('a distinct scope dedups separately while the SLOT stays on the repo key', () => {
    // The command-MR pass: issue iid 5 and MR iid 5 must coexist, but both passes
    // share ONE per-repo slot budget (§14).
    const claims = new Claims(4);
    const issue = claims.open('repoA', 5);
    const mr = claims.open('repoA', 5, 'repoA#mr');
    expect(issue).not.toBeNull();
    expect(mr).not.toBeNull();
    expect(claims.open('repoA', 5, 'repoA#mr')).toBeNull(); // same scope → in flight
    issue?.holdSlot();
    expect(mr?.slotAvailable(1)).toBe(false); // issue's slot counts against repoA's cap
  });
});

describe('Claim.slotAvailable / holdSlot — capacity under both caps (§14)', () => {
  it('reports availability until the global cap is reached, across repos', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    const b = claims.open('repoB', 1);
    expect(b?.slotAvailable(2)).toBe(true);
    a?.holdSlot();
    expect(b?.slotAvailable(2)).toBe(false); // global (1) full, other repo blocked
  });

  it('reports availability until the per-repo cap is reached, with global headroom', () => {
    const claims = new Claims(4);
    const a1 = claims.open('repoA', 1);
    const a2 = claims.open('repoA', 2);
    const b = claims.open('repoB', 1);
    a1?.holdSlot();
    expect(a2?.slotAvailable(1)).toBe(false); // repoA at its cap
    expect(b?.slotAvailable(1)).toBe(true); // repoB still free (global headroom)
  });

  it('holdSlot is unconditional (policy lives with the caller) and held at most once', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    a?.holdSlot();
    a?.holdSlot(); // second call: no double-count
    expect(claims.globalActive).toBe(1);
  });
});

describe('Claim.close — the single release path', () => {
  it('releases slot and uniqueness together', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    a?.holdSlot();
    expect(claims.globalActive).toBe(1);
    expect(claims.open('repoA', 1)).toBeNull();

    a?.close();

    expect(claims.globalActive).toBe(0); // slot back
    expect(claims.open('repoA', 1)).not.toBeNull(); // re-claimable
  });

  it('releases uniqueness even when no slot was held (no-launch path)', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    a?.close();
    expect(claims.globalActive).toBe(0);
    expect(claims.open('repoA', 1)).not.toBeNull();
  });

  it('double-close is a no-op — never a double release', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    a?.holdSlot();
    a?.close();
    a?.close(); // idempotent

    expect(claims.globalActive).toBe(0); // not negative, not re-decremented
    const b = claims.open('repoB', 1);
    b?.holdSlot();
    expect(claims.globalActive).toBe(1); // accounting still consistent after the double close
    expect(b?.slotAvailable(2)).toBe(false); // global (1) genuinely full again
  });

  it('holdSlot after close is a no-op — a closed claim can never leak a slot', () => {
    const claims = new Claims(1);
    const a = claims.open('repoA', 1);
    a?.close();
    a?.holdSlot();
    expect(claims.globalActive).toBe(0);
  });
});
