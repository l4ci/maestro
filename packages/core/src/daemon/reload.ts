// Hot-reload wiring (spec §5). M1's ConfigStore / WorkflowStore already validate
// before swapping (valid → swap; invalid → keep old). M5 adds the daemon-side
// derivation: on a valid config reload re-derive the live WATCH SET (the repos the
// scheduler ticks); on a valid WORKFLOW reload re-derive that repo's RepoSettings.
// On an invalid reload we keep the previous good value and LOG the rejected path.
// A swapped-out repo stops being scheduled; a newly-added one starts next pass.

import { type ConfigStore, inferForge } from '../config/load-config.js';
import { resolveRepoSettings } from '../config/resolve-settings.js';
import type {
  MaestroConfig,
  RepoRef,
  RepoSettings,
  WorkflowFrontMatter,
} from '../contracts/index.js';
import type { WorkflowStore } from '../workflow/load-workflow.js';
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
