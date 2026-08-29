import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowStore, parseWorkflow, splitFrontMatter } from '../src/workflow/load-workflow.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const template = readFileSync(resolve(repoRoot, 'templates/WORKFLOW.md'), 'utf8');

describe('C0 — split front matter + body', () => {
  it('separates YAML front matter from the prompt body', () => {
    const { frontMatter, promptBody } = splitFrontMatter(template);
    expect(frontMatter).toContain('proof:');
    expect(promptBody).toContain('# Agent operating protocol');
  });

  it('throws a typed error on missing front matter', () => {
    expect(() => splitFrontMatter('# just a body, no fence')).toThrow(/front matter/i);
  });
});

describe('C1 — validate front matter via WorkflowSchema', () => {
  it('parses and defaults the sample template', () => {
    const r = parseWorkflow(template);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.frontMatter.proof[0]?.type).toBe('playwright');
      expect(r.value.frontMatter.git.merge_strategy).toBe('squash');
      expect(r.value.frontMatter.manage_board).toBe(true);
      expect(r.value.frontMatter.claude.max_turns).toBe(40);
      expect(r.value.frontMatter.claude.run_timeout_seconds).toBe(1800); // HerdrRunner poll ceiling
      expect(r.value.promptBody).toContain('atomic commit');
    }
  });

  it('rejects front matter missing required proof.type', () => {
    const bad =
      '---\nproject: g/r\nbot_user: bot\ngit:\n  default_branch: main\n  target: main\n---\nbody';
    const r = parseWorkflow(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/proof/);
  });
});

describe('C2 — forge inference when omitted', () => {
  it('infers forge from the repo host when WORKFLOW omits it', () => {
    const noForge = template.replace(/^forge: gitlab.*$/m, '');
    const r = parseWorkflow(noForge, 'github.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.forge).toBe('github');
  });

  it('uses the explicit forge when present', () => {
    const r = parseWorkflow(template, 'github.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.forge).toBe('gitlab'); // explicit `forge: gitlab` wins over host
  });
});

describe('C3 — hot-reload + validate-before-reload', () => {
  it('keeps last good front matter on invalid reload', () => {
    const store = new WorkflowStore(parseWorkflowOrThrow(template));
    const before = store.current;
    const r = store.reload('---\nproject: g/r\n---\nbody'); // missing required fields
    expect(r.ok).toBe(false);
    expect(store.current).toBe(before);
  });

  it('swaps on a valid reload', () => {
    const store = new WorkflowStore(parseWorkflowOrThrow(template));
    const next = template.replace('max_turns: 40', 'max_turns: 12');
    const r = store.reload(next);
    expect(r.ok).toBe(true);
    expect(store.current.frontMatter.claude.max_turns).toBe(12);
  });
});

function parseWorkflowOrThrow(text: string, host?: string) {
  const r = parseWorkflow(text, host);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('C1b — proof accepts a list of strategies (#12)', () => {
  const fm = (proofYaml: string) =>
    `---\nproject: g/r\nforge: gitlab\nbot_user: bot\nproof:\n${proofYaml}git:\n  default_branch: main\n  target: main\n---\nbody`;

  it('parses a list and keeps config order', () => {
    const r = parseWorkflow(
      fm('  - type: diff-summary\n  - type: test-output\n    command: npm test\n'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.frontMatter.proof.map((p) => p.type)).toEqual(['diff-summary', 'test-output']);
    }
  });

  it('normalizes the single-object form to a one-element list (back-compat)', () => {
    const r = parseWorkflow(fm('  type: diff-summary\n'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.frontMatter.proof).toEqual([{ type: 'diff-summary' }]);
  });

  it("rejects 'none' inside a multi-strategy list", () => {
    const r = parseWorkflow(fm('  - type: none\n  - type: diff-summary\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only strategy/);
  });

  it('rejects an empty list', () => {
    const r = parseWorkflow(fm('  []\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one/);
  });
});
