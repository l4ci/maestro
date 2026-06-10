// Handoff contract (AM-11). M4 implements the §7 ordering guarantee (proof-comment
// → requestReview → ready comment → setDraft(false) → label in-review, idempotent); M5 invokes it.

import type { ForgeAdapter } from './forge-adapter.js';
import type { RepoRef } from './forge-model.js';
import type { ProofResult } from './proof.js';
import type { RepoSettings } from './reconciler.js';

export interface HandoffInput {
  repo: RepoRef;
  issueIid: number;
  mrIid: number;
  ticketCreator: string; // issue.author.username — the reviewer to request review from
  settings: RepoSettings;
  adapter: ForgeAdapter;
  proof: ProofResult[]; // one entry per configured strategy; all-must-pass at handoff
}

export type HandoffFn = (input: HandoffInput) => Promise<void>;
