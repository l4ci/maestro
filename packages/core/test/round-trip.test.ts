import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigSchema, WorkflowSchema } from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

/** Split `---\n<frontmatter>\n---\n<body>` (the real loader lives in M1). */
function splitFrontMatter(src: string): { frontMatter: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  if (!m) throw new Error('no front matter');
  return { frontMatter: m[1] as string, body: m[2] as string };
}

describe('maestro.config.example.yaml round-trips through ConfigSchema', () => {
  const raw = parseYaml(read('maestro.config.example.yaml'));

  it('validates against ConfigSchema', () => {
    expect(() => ConfigSchema.parse(raw)).not.toThrow();
  });

  it('transforms human-legible durations + sizes to numbers', () => {
    const cfg = ConfigSchema.parse(raw);
    expect(cfg.defaults.poll_interval_active).toBe(30_000);
    expect(cfg.defaults.poll_interval_idle).toBe(300_000);
    expect(cfg.defaults.poll_jitter).toBe(5_000);
    expect(cfg.defaults.workspaces.disk_cap).toBe(20 * 1024 ** 3);
    expect(cfg.defaults.concurrency.global_max).toBe(2);
  });

  it('preserves the watchlist and per-repo overrides', () => {
    const cfg = ConfigSchema.parse(raw);
    expect(cfg.repos).toHaveLength(2);
    expect(cfg.repos[1]?.url).toBe('github.com/org/web');
    expect(cfg.repos[1]?.overrides?.concurrency?.max_active).toBe(1);
  });

  it('is YAML-lossless (re-emit + re-parse is stable)', () => {
    expect(parseYaml(stringifyYaml(raw))).toEqual(raw);
  });
});

describe('templates/WORKFLOW.md round-trips through WorkflowSchema', () => {
  const { frontMatter, body } = splitFrontMatter(read('templates/WORKFLOW.md'));
  const raw = parseYaml(frontMatter);

  it('front matter validates against WorkflowSchema', () => {
    expect(() => WorkflowSchema.parse(raw)).not.toThrow();
  });

  it('applies defaults and keeps declared values', () => {
    const wf = WorkflowSchema.parse(raw);
    expect(wf.proof.type).toBe('playwright');
    expect(wf.git.merge_strategy).toBe('squash');
    expect(wf.trigger.require_label).toBeNull();
    expect(wf.claude.max_turns).toBe(40);
    expect(wf.environment.base_url).toBe('http://localhost:3000');
  });

  it('preserves the prompt body (the operating protocol)', () => {
    expect(body).toContain('# Agent operating protocol');
    expect(body).toContain('atomic commit');
    expect(body.length).toBeGreaterThan(100);
  });

  it('is YAML-lossless on the front matter', () => {
    expect(parseYaml(stringifyYaml(raw))).toEqual(raw);
  });
});
