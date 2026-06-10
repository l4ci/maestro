// The claim (#91): the daemon's unit of work admission. One object owns BOTH
// concurrency resources for one unit of work (an issue, or a command MR):
//   · UNIQUENESS — the unit is not already being worked (#18). A repo stays "due"
//     while its prior pass's agent work is still settling, so overlapping tick passes
//     re-enter evaluation; without a per-unit claim a free slot (max_active ≥ 2) would
//     stack a second agent on the same workspace.
//   · CAPACITY — a worker slot under the global and per-repo caps (§14).
// `open` must be called SYNCHRONOUSLY before any await (atomic check-and-claim), and
// `close` is the ONLY release path — it returns slot and uniqueness together, on every
// outcome (no-launch, launch-settled, throw). SlotAccountant and InFlightSet survive
// as internal seams behind this interface; only Claims is exported from the package.

import { InFlightSet, SlotAccountant, type SlotRelease } from './slots.js';

/** One admitted unit of work. Obtained from `Claims.open`; closed exactly once. */
export interface Claim {
  /** Can a NEW active worker start for this claim's repo under both caps? Feeds the
   *  reconciler's `slotAvailable` input — capacity POLICY stays in the reconciler. */
  slotAvailable(maxActive: number): boolean;
  /** Take a worker slot, unconditionally (the policy decision was `slotAvailable`'s).
   *  At most one slot per claim; a second call is a no-op, as is one after close. */
  holdSlot(): void;
  /** Release whatever is held — the slot (if any) AND uniqueness, together.
   *  Idempotent; the ONLY release path. */
  close(): void;
}

/** Process-wide work admission: the daemon constructs ONE of these and every pass
 *  (issue lifecycle, command MR) opens claims against it. */
export class Claims {
  readonly #slots: SlotAccountant;
  readonly #inFlight = new InFlightSet();

  constructor(globalMax: number) {
    this.#slots = new SlotAccountant(globalMax);
  }

  /** Workers currently holding a slot — the heartbeat/dashboard signal (#40). */
  get globalActive(): number {
    return this.#slots.globalActive;
  }

  /**
   * Admit `iid` under `key`, or return null when it is already in flight. Synchronous —
   * the caller MUST open before its first await so overlapping tick passes can never
   * both claim one unit (#18). `scope` is the uniqueness namespace and defaults to
   * `key`; the command-MR pass passes a distinct scope so an issue iid 5 and an MR
   * iid 5 never collide, while the SLOT stays keyed on `key` — both passes share one
   * per-repo budget (§14).
   */
  open(key: string, iid: number, scope: string = key): Claim | null {
    if (this.#inFlight.has(scope, iid)) return null;
    this.#inFlight.add(scope, iid);
    const slots = this.#slots;
    const inFlight = this.#inFlight;
    let release: SlotRelease | undefined;
    let closed = false;
    return {
      slotAvailable: (maxActive) => slots.available(key, maxActive),
      holdSlot: () => {
        if (closed || release) return;
        release = slots.acquire(key);
      },
      close: () => {
        if (closed) return;
        closed = true;
        release?.();
        inFlight.delete(scope, iid);
      },
    };
  }
}
