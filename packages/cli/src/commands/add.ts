// Part B (marshalling only) — `maestro add`. A THIN marshaller: it forwards the parsed
// add command to core's addRepo (the ONE shared routine the web POST also calls — OD-4)
// and renders the AddResult as a human line. No config/forge/commit logic lives here.

import type { AddRepoDeps, AddRepoInput, AddResult } from '@maestro/core';
import type { ParsedCommand } from '../parse.js';

type AddCommand = Extract<ParsedCommand, { kind: 'add' }>;

export interface RunAddDeps {
  /** Injected so tests spy it; production passes core's `addRepo`. */
  addRepo: (input: AddRepoInput, deps: AddRepoDeps) => Promise<AddResult>;
  /** The real-I/O deps (exec, configPath, adapterFor, …) forwarded to addRepo. */
  addDeps: AddRepoDeps;
}

export async function runAdd(cmd: AddCommand, deps: RunAddDeps): Promise<string> {
  const result = await deps.addRepo({ url: cmd.url, commit: cmd.commit }, deps.addDeps);
  if (result.added) return `Watching ${result.repo.project}`;
  return `Not added: ${result.reason}`;
}
