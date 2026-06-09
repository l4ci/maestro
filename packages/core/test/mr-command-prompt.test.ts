// The built-in MR-command runner prompt (spec §5). A FIXED prompt (not a
// WORKFLOW-declared role): orient on the MR, follow the human instruction, commit if
// code changed (the daemon pushes), and end via the standard status contract — which
// the runner's assemblePrompt appends, so it is intentionally NOT duplicated here.

import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '../src/contracts/index.js';
import { buildMrCommandPrompt } from '../src/mr-command/prompt.js';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 84,
  id: 'gid-84',
  title: 'Tidy the parser',
  description: 'Refactor the tokenizer for clarity.\n\nNo behaviour change intended.',
  state: 'opened',
  isDraft: true,
  sourceBranch: 'feature/tidy-parser',
  targetBranch: 'main',
  assignees: [],
  labels: [],
  approvals: { approved: false, approvedBy: [] },
  webUrl: 'https://example.test/mr/84',
  ...over,
});

describe('buildMrCommandPrompt', () => {
  const prompt = buildMrCommandPrompt({
    instruction: 'make sure the tests pass',
    mr: mr(),
    workflowBody: '## House rules\nUse pnpm, never npm.',
  });

  it('carries the human instruction verbatim', () => {
    expect(prompt).toContain('make sure the tests pass');
  });

  it('orients the agent on the MR title, description, and branch', () => {
    expect(prompt).toContain('Tidy the parser');
    expect(prompt).toContain('Refactor the tokenizer for clarity.');
    expect(prompt).toContain('feature/tidy-parser');
  });

  it('tells the agent to commit and that the daemon pushes', () => {
    expect(prompt.toLowerCase()).toContain('commit');
    expect(prompt.toLowerCase()).toContain('daemon');
    expect(prompt.toLowerCase()).toContain('push');
  });

  it('appends the workflow body for repo conventions', () => {
    expect(prompt).toContain('## House rules\nUse pnpm, never npm.');
  });

  it('omits an empty workflow body cleanly (no dangling header)', () => {
    const p = buildMrCommandPrompt({ instruction: 'do x', mr: mr(), workflowBody: '' });
    expect(p).toContain('do x');
    expect(p).not.toMatch(/conventions[\s—-]*$/i);
  });
});
