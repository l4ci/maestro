// WORKFLOW.md loader (spec §6, §0.6). Splits YAML front matter from the prompt
// body (carried separately), validates the front matter via WorkflowSchema, and
// infers the forge from the repo host when omitted. Hot-reload validates first.
//
// WORKFLOW lives in a *watched* repo → semi-trusted (§13.1); zod validation + a
// safe YAML load (no custom tags) is the containment.

import { parse as parseYaml } from 'yaml';
import { inferForge } from '../config/load-config.js';
import { type ForgeKind, type WorkflowFrontMatter, WorkflowSchema } from '../contracts/index.js';

export interface LoadedWorkflow {
  frontMatter: WorkflowFrontMatter;
  promptBody: string;
  forge: ForgeKind;
}

export type WorkflowParseResult =
  | { ok: true; value: LoadedWorkflow }
  | { ok: false; error: string };

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split `---\n<frontMatter>\n---\n<promptBody>`. Throws if the fence is absent. */
export function splitFrontMatter(src: string): { frontMatter: string; promptBody: string } {
  const m = FENCE.exec(src);
  if (!m) throw new Error('WORKFLOW.md has no YAML front matter fence (--- ... ---)');
  return { frontMatter: m[1] as string, promptBody: m[2] as string };
}

export function parseWorkflow(text: string, host?: string): WorkflowParseResult {
  let frontMatter: string;
  let promptBody: string;
  try {
    ({ frontMatter, promptBody } = splitFrontMatter(text));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  let raw: unknown;
  try {
    raw = parseYaml(frontMatter);
  } catch (e) {
    return { ok: false, error: `WORKFLOW front matter YAML error: ${(e as Error).message}` };
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '(root)';
    const msg = first ? first.message : 'invalid front matter';
    return { ok: false, error: `WORKFLOW invalid at ${path}: ${msg}` };
  }

  let forge: ForgeKind;
  if (parsed.data.forge) {
    forge = parsed.data.forge; // explicit wins over host (§6)
  } else if (host) {
    try {
      forge = inferForge(host);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  } else {
    return { ok: false, error: 'WORKFLOW omits `forge` and no repo host was provided to infer it' };
  }

  return { ok: true, value: { frontMatter: parsed.data, promptBody, forge } };
}

/** Holds the current workflow; validate-before-reload (§6). */
export class WorkflowStore {
  #current: LoadedWorkflow;
  readonly #host: string | undefined;

  constructor(initial: LoadedWorkflow, host?: string) {
    this.#current = initial;
    this.#host = host;
  }

  get current(): LoadedWorkflow {
    return this.#current;
  }

  reload(text: string, host: string | undefined = this.#host): WorkflowParseResult {
    const r = parseWorkflow(text, host);
    if (r.ok) this.#current = r.value;
    return r;
  }
}
