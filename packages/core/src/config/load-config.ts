// Config loader (spec §5, §0.6). Parse + validate maestro.config.yaml; infer the
// forge per repo from its host; hot-reload with validate-before-reload. No I/O on
// secrets — token_env holds the NAME of an env var only (§0.8); never resolved here.

import { parse as parseYaml } from 'yaml';
import {
  ConfigSchema,
  type ForgeEntry,
  type ForgeKind,
  type MaestroConfig,
  normalizeForges,
} from '../contracts/index.js';

export type ConfigParseResult = { ok: true; value: MaestroConfig } | { ok: false; error: string };

export function parseConfig(text: string): ConfigParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${(e as Error).message}` };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '(root)';
    const msg = first ? first.message : 'invalid config';
    return { ok: false, error: `config invalid at ${path}: ${msg}` };
  }
  return { ok: true, value: normalizeForges(parsed.data) };
}

type ForgesConfig = MaestroConfig['forges'];

/** Extract the bare host from a repo url like `gitlab.com/group/api`. */
function hostOf(url: string): string {
  const noScheme = url.replace(/^[a-z]+:\/\//i, '');
  return noScheme.split('/')[0] ?? '';
}

/** Find a configured forge entry whose host matches.
 *  Accepts an array (normalized) or a single entry (backward-compat for tests). */
function findForgeEntry(
  host: string,
  entries: ForgeEntry[] | ForgeEntry | undefined,
): ForgeEntry | undefined {
  if (!entries) return undefined;
  const arr = Array.isArray(entries) ? entries : [entries];
  return arr.find((e) => e.host === host);
}

/**
 * Resolve a repo's forge from its url host (§0.6 "host inferred → ForgeKind").
 * Configured `forges.*.host` entries match first (supports self-hosted); the
 * well-known public hosts are the fallback. Unknown host → throw.
 */
export function inferForge(url: string, forges?: ForgesConfig): ForgeKind {
  const host = hostOf(url);
  if (findForgeEntry(host, forges?.gitlab)) return 'gitlab';
  if (findForgeEntry(host, forges?.github)) return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'github.com') return 'github';
  throw new Error(
    `cannot infer forge for host '${host}' (not gitlab.com/github.com or a configured forges.* host)`,
  );
}

/** Holds the current config; validate-before-reload (§5) — only swaps on success. */
export class ConfigStore {
  #current: MaestroConfig;

  constructor(initial: MaestroConfig) {
    this.#current = initial;
  }

  get current(): MaestroConfig {
    return this.#current;
  }

  reload(text: string): ConfigParseResult {
    const r = parseConfig(text);
    if (r.ok) this.#current = r.value;
    return r;
  }
}
