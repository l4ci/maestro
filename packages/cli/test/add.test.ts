// Part B (marshalling only) — runAdd is a thin marshaller: it turns a parsed `add` command
// into a core addRepo(...) call and renders the AddResult as a human string. ALL real logic
// (config append, forge setup, commit) lives in core's addRepo, already tested there.

import type { AddRepoDeps, AddRepoInput, AddResult, RepoRef } from '@maestro/core';
import { describe, expect, it, vi } from 'vitest';
import { runAdd } from '../src/commands/add.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'g/r',
  url: 'gitlab.com/g/r',
};

describe('runAdd (B — marshaller)', () => {
  it('calls addRepo with the parsed url + commit flag and renders success', async () => {
    const spy = vi.fn<(i: AddRepoInput, d: AddRepoDeps) => Promise<AddResult>>(() =>
      Promise.resolve({ added: true, repo }),
    );
    const out = await runAdd(
      { kind: 'add', url: 'gitlab.com/g/r', commit: false, public: false },
      // deps the marshaller forwards to addRepo, plus the injected addRepo itself
      { addRepo: spy, addDeps: {} as AddRepoDeps },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ url: 'gitlab.com/g/r', commit: false, public: false });
    expect(out).toMatch(/g\/r/);
  });

  it('renders a clear line on a not-added result', async () => {
    const spy = vi.fn<(i: AddRepoInput, d: AddRepoDeps) => Promise<AddResult>>(() =>
      Promise.resolve({ added: false, reason: 'already-watched' }),
    );
    const out = await runAdd(
      { kind: 'add', url: 'gitlab.com/g/r', commit: true, public: true },
      { addRepo: spy, addDeps: {} as AddRepoDeps },
    );
    expect(out).toMatch(/already-watched/);
  });
});
