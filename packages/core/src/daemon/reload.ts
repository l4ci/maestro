// Hot-reload wiring (spec §5). M1's ConfigStore / WorkflowStore already validate
// before swapping (valid → swap; invalid → keep old). M5 adds the daemon-side
// derivation: on a valid config reload re-derive the live WATCH SET (the repos the
// scheduler ticks); on a valid WORKFLOW reload re-derive that repo's RepoSettings.
// On an invalid reload we keep the previous good value and LOG the rejected path.
// A swapped-out repo stops being scheduled; a newly-added one starts next pass.

import { buildBootstrapWorkflow } from '../bootstrap/bootstrap-workflow.js';
import { type ConfigStore, botUserForHost, inferForge } from '../config/load-config.js';
import { resolveRepoSettings } from '../config/resolve-settings.js';
import type {
  MaestroConfig,
  RepoRef,
  RepoSettings,
  WorkflowFrontMatter,
} from '../contracts/index.js';
import { WorkflowStore, parseWorkflow } from '../workflow/load-workflow.js';
import type { Logger } from './ports.js';

type RepoOverride = NonNullable<MaestroConfig['repos'][number]['overrides']>;

/** Build a RepoRef from a configured repo url, inferring its forge (§0.6). */
export function repoRefFromUrl(url: string, forges: MaestroConfig['forges']): RepoRef {
  const noScheme = url.replace(/^[a-z]+:\/\//i, '');
  const slash = noScheme.indexOf('/');
  const host = slash === -1 ? noScheme : noScheme.slice(0, slash);
  const project = slash === -1 ? '' : noScheme.slice(slash + 1);
  return { forge: inferForge(url, forges), host, project, url };
}

/** The live set of repos the daemon watches, derived from the current config. */
export function deriveWatchSet(config: MaestroConfig): RepoRef[] {
  return config.repos.map((r) => repoRefFromUrl(r.url, config.forges));
}

/** Wraps M1's ConfigStore; re-derives the watch set on a valid reload, logs otherwise. */
export class WatchedConfig {
  readonly #store: ConfigStore;
  readonly #log: Logger;
  #watchSet: RepoRef[];

  constructor(store: ConfigStore, log: Logger) {
    this.#store = store;
    this.#log = log;
    this.#watchSet = deriveWatchSet(store.current);
  }

  get watchSet(): RepoRef[] {
    return this.#watchSet;
  }

  get config(): MaestroConfig {
    return this.#store.current;
  }

  /** Validate-before-reload (§5). true on swap (+ re-derive); false keeps old + logs. */
  reload(text: string): boolean {
    const r = this.#store.reload(text);
    if (!r.ok) {
      this.#log.error('config reload rejected, keeping previous', { error: r.error });
      return false;
    }
    this.#watchSet = deriveWatchSet(this.#store.current);
    return true;
  }
}

/** Wraps one repo's WorkflowStore; re-resolves RepoSettings on a valid reload. */
export class RepoSettingsCell {
  readonly #repo: RepoRef;
  readonly #store: WorkflowStore;
  readonly #defaults: MaestroConfig['defaults'];
  readonly #override: RepoOverride | undefined;
  readonly #log: Logger;
  #settings: RepoSettings;

  constructor(args: {
    repo: RepoRef;
    store: WorkflowStore;
    defaults: MaestroConfig['defaults'];
    override?: RepoOverride;
    log: Logger;
  }) {
    this.#repo = args.repo;
    this.#store = args.store;
    this.#defaults = args.defaults;
    this.#override = args.override;
    this.#log = args.log;
    this.#settings = this.#resolve();
  }

  get settings(): RepoSettings {
    return this.#settings;
  }

  get promptBody(): string {
    return this.#store.current.promptBody;
  }

  /** The current WORKFLOW front matter (proof / environment / claude) → TickContext. */
  get frontMatter(): WorkflowFrontMatter {
    return this.#store.current.frontMatter;
  }

  reload(text: string): boolean {
    const r = this.#store.reload(text);
    if (!r.ok) {
      this.#log.error('WORKFLOW reload rejected, keeping previous', {
        repo: this.#repo.project,
        error: r.error,
      });
      return false;
    }
    this.#settings = this.#resolve();
    return true;
  }

  #resolve(): RepoSettings {
    return resolveRepoSettings({
      repo: this.#repo,
      workflow: this.#store.current.frontMatter,
      defaults: this.#defaults,
      ...(this.#override ? { override: this.#override } : {}),
    });
  }
}

/** Outcome of deriving a repo's settings cell from its WORKFLOW text (#107). The tag
 *  carries what comments used to whisper: `bootstrap` = no committed WORKFLOW.md and the
 *  bootstrap template is unusable (expected when no template ships); `invalid` = a file
 *  the USER wrote failed to parse — a user error, never to be papered over with a
 *  bootstrap fallback. */
export type DeriveCellOutcome =
  | { ok: true; cell: RepoSettingsCell }
  | { ok: false; reason: 'bootstrap' }
  | { ok: false; reason: 'invalid'; error: string };

/** Build a repo's settings cell from its WORKFLOW text. `undefined` text → BOOTSTRAP mode
 *  (no committed WORKFLOW.md yet) so the daemon can still work the "define my workflow"
 *  issue; the stand-in workflow is built from `templateText`. Pure decision — logging the
 *  failure (and choosing skip-vs-keep-prior) belongs to the caller, see WorkflowCells. */
export function deriveCell(args: {
  repo: RepoRef;
  workflowText: string | undefined;
  templateText: string;
  config: MaestroConfig;
  log: Logger;
}): DeriveCellOutcome {
  const { repo, workflowText, config } = args;
  const parsed =
    workflowText !== undefined
      ? parseWorkflow(workflowText, repo.host)
      : buildBootstrapWorkflow(repo, args.templateText, botUserForHost(repo.host, config));
  if (!parsed.ok) {
    return workflowText === undefined
      ? { ok: false, reason: 'bootstrap' }
      : { ok: false, reason: 'invalid', error: parsed.error };
  }
  const override = config.repos.find((r) => r.url === repo.url)?.overrides;
  return {
    ok: true,
    cell: new RepoSettingsCell({
      repo,
      store: new WorkflowStore(parsed.value, repo.host),
      defaults: config.defaults,
      ...(override ? { override } : {}),
      log: args.log,
    }),
  };
}

/** The daemon's live per-repo settings cells, keyed by repo url, plus the WORKFLOW text
 *  last SEEN per repo — recorded even when derivation fails, so a refresh re-derives
 *  (and re-logs) only on a real change: the error log fires once per distinct text.
 *
 *  Owns the §5 swap policy around deriveCell:
 *   · `invalid` with a prior good cell → keep the prior (validate-before-swap), log.
 *   · `invalid` with NO prior cell → the repo is SKIPPED with an error-level log naming
 *     the parse failure — explicitly NOT a bootstrap fallback: the daemon must never
 *     open a sample-WORKFLOW bootstrap PR over a file the user actually wrote (#107). */
export class WorkflowCells {
  readonly #config: MaestroConfig;
  readonly #templateText: string;
  readonly #log: Logger;
  readonly #cells = new Map<string, { repo: RepoRef; cell: RepoSettingsCell }>();
  readonly #lastText = new Map<string, string | undefined>();

  constructor(args: { config: MaestroConfig; templateText: string; log: Logger }) {
    this.#config = args.config;
    this.#templateText = args.templateText;
    this.#log = args.log;
  }

  /** Seed a repo's cell from the local cache at startup (`undefined` = no cache → bootstrap). */
  seed(repo: RepoRef, cachedText: string | undefined): void {
    this.#apply(repo, cachedText, 'seed');
  }

  /** Apply a freshly-fetched default-branch WORKFLOW.md; re-derives only on a real change
   *  (an unchanged remote is a no-op — this is also what dedupes the invalid-text log). */
  applyRemote(repo: RepoRef, text: string | undefined): void {
    if (this.#lastText.has(repo.url) && text === this.#lastText.get(repo.url)) return;
    this.#apply(repo, text, 'remote');
  }

  get size(): number {
    return this.#cells.size;
  }

  entries(): { repo: RepoRef; cell: RepoSettingsCell }[] {
    return [...this.#cells.values()];
  }

  #apply(repo: RepoRef, text: string | undefined, via: 'seed' | 'remote'): void {
    const prior = this.#cells.get(repo.url);
    const derived = deriveCell({
      repo,
      workflowText: text,
      templateText: this.#templateText,
      config: this.#config,
      log: this.#log,
    });
    this.#lastText.set(repo.url, text);
    if (!derived.ok) {
      if (derived.reason === 'invalid') {
        this.#log.error(
          prior
            ? 'WORKFLOW invalid — keeping previous workflow'
            : 'WORKFLOW invalid — repo skipped until its WORKFLOW.md parses (not entering bootstrap)',
          { repo: repo.project, error: derived.error },
        );
      } else {
        this.#log.error(
          prior
            ? 'bootstrap workflow unavailable — keeping previous workflow'
            : 'bootstrap workflow unavailable — repo skipped',
          { repo: repo.project },
        );
      }
      return; // keep the prior good cell if any (§5 validate-before-swap)
    }
    this.#cells.set(repo.url, { repo, cell: derived.cell });
    if (via === 'seed') {
      if (text === undefined)
        this.#log.info('repo has no WORKFLOW.md yet — operating in bootstrap mode', {
          repo: repo.project,
        });
    } else {
      this.#log.info(
        prior ? 'WORKFLOW re-derived from default branch' : 'WORKFLOW loaded from default branch',
        { repo: repo.project, bootstrap: text === undefined },
      );
    }
  }
}
