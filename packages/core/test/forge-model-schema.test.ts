import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '../src/contracts/index.js';
import { MergeRequestSchema } from '../src/contracts/index.js';

function mr(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    iid: 7,
    id: 'gid-mr-7',
    title: 'Add OAuth login',
    description: '- [ ] step one',
    state: 'opened',
    isDraft: true,
    sourceBranch: 'maestro/issue-42-add-oauth-login',
    targetBranch: 'main',
    assignees: [],
    reviewers: [],
    labels: [],
    approvals: { approved: false, approvedBy: [], changesRequested: false },
    webUrl: 'https://gitlab.com/group/api/-/merge_requests/7',
    ...over,
  };
}

describe('MergeRequestSchema — ci field (#118)', () => {
  it('preserves a valid ci status through parse', () => {
    const parsed = MergeRequestSchema.parse(
      mr({ ci: { conclusion: 'failed', at: '2026-06-11T10:00:00Z', webUrl: 'u' } }),
    );
    expect(parsed.ci).toEqual({
      conclusion: 'failed',
      at: '2026-06-11T10:00:00Z',
      webUrl: 'u',
    });
  });

  it('rejects an MR whose ci.conclusion is not a known value', () => {
    const result = MergeRequestSchema.safeParse(
      // @ts-expect-error — invalid conclusion is the point of the test
      mr({ ci: { conclusion: 'bogus' } }),
    );
    expect(result.success).toBe(false);
  });
});
