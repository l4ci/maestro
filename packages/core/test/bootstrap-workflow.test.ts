// buildBootstrapWorkflow — the stand-in workflow a no-WORKFLOW repo runs on so the daemon
// can work its "define my workflow" issue (iteration 2).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_PROMPT_BODY,
  buildBootstrapWorkflow,
} from '../src/bootstrap/bootstrap-workflow.js';
import type { RepoRef } from '../src/contracts/index.js';

const TEMPLATE = readFileSync('templates/WORKFLOW.md', 'utf8');
const repo: RepoRef = {
  forge: 'github',
  host: 'github.com',
  project: 'l4ci/maestro',
  url: 'github.com/l4ci/maestro',
};

describe('buildBootstrapWorkflow', () => {
  it('is schema-valid, carries the repo identity + bootstrap defaults, and the bootstrap prompt', () => {
    const wf = buildBootstrapWorkflow(repo, TEMPLATE, 'l4ci');
    expect(wf.ok).toBe(true);
    if (!wf.ok) return;
    expect(wf.value.frontMatter.project).toBe('l4ci/maestro');
    expect(wf.value.frontMatter.bot_user).toBe('l4ci');
    expect(wf.value.frontMatter.proof.type).toBe('none'); // bootstrap runs no proof
    expect(wf.value.promptBody).toBe(BOOTSTRAP_PROMPT_BODY);
    expect(wf.value.promptBody).toMatch(/ask the maintainer|STOP|blocked/i);
  });

  it('fails cleanly when the template is unusable (rather than throwing)', () => {
    const wf = buildBootstrapWorkflow(repo, 'not a template', 'l4ci');
    expect(wf.ok).toBe(false);
  });
});
