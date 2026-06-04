// GitHub forge adapter — the SECOND ForgeAdapter implementation (§0.3), built
// against the now-settled surface M2 (GitLab) established. All I/O flows through
// the injected Exec seam via GithubClient. Normalizes GitHub JSON to the SAME §0.2
// model M2 produces, so the reconciler + daemon drive GitHub with ZERO changes —
// that zero-change property is the milestone's headline proof.
//
// GitHub diverges from GitLab on exactly three things: (1) FLAT labels `maestro:*`
// whose mutual exclusion the adapter enforces (GitLab got it free from scoped
// labels); (2) approval / changes-requested derived from PR REVIEWS; (3) ensureBoard
// is left UNDEFINED (labels only — Projects V2 deferred §11/§17). botUser is
// construction config (§0.10), mirroring M2. MR≡PR throughout.

import type {
  CreateIssueArgs,
  CreateMRArgs,
  Exec,
  ForgeAdapter,
  Issue,
  IssueSnapshot,
  Label,
  MergeRequest,
  MergeStrategy,
  RepoRef,
} from '../../contracts/index.js';
import { labelNames } from '../../contracts/labels.js';
import { ForgeCli } from '../cli.js';
import { ForgeError } from '../errors.js';
import {
  type RawComment,
  type RawCommit,
  type RawIssue,
  type RawPr,
  type RawReview,
  type RawTimelineEvent,
  changesRequestedSince,
  normalizeComment,
  normalizeIssue,
  normalizeMergeRequest,
  normalizeReviews,
  normalizeUser,
} from './normalize.js';

const DEFAULT_LABEL_COLOR = '6699cc'; // GitHub label colors are hex WITHOUT the leading '#'

/** Adapter construction config (M0 §0.10). Kept as a named type for the public barrel. */
export interface GithubClientConfig {
  token: string;
  host: string; // github.com or a self-hosted GHE host
  botUser: string; // edge-trigger / bot assignment
  commentCap?: number; // recentComments bound (default 50)
}

/** Split 'org/repo' into URL-encoded path segments for /repos/:owner/:repo. */
export function repoSegments(project: string): { owner: string; repo: string } {
  const i = project.indexOf('/');
  if (i === -1) throw new ForgeError('github', 'GET', project, 0, `invalid repo path '${project}'`);
  return {
    owner: encodeURIComponent(project.slice(0, i)),
    repo: encodeURIComponent(project.slice(i + 1)),
  };
}

interface RawLabelObj {
  name: string;
}

/** Common prefix of every maestro label for this forge, e.g. 'maestro:' on GitHub. */
const MAESTRO_PREFIX = (() => {
  const ln = labelNames('github').inProgress; // 'maestro:in-progress'
  return ln.slice(0, ln.indexOf(':') + 1);
})();

export class GithubAdapter implements ForgeAdapter {
  readonly kind = 'github' as const;
  readonly #c: ForgeCli;

  constructor(exec: Exec, cfg: GithubClientConfig) {
    this.#c = new ForgeCli(exec, {
      bin: 'gh',
      forge: 'github',
      env: { GH_TOKEN: cfg.token, GH_HOST: cfg.host }, // gh reads these; GH_HOST targets GHE
      botUser: cfg.botUser,
      ...(cfg.commentCap !== undefined ? { commentCap: cfg.commentCap } : {}),
    });
  }

  #base(repo: RepoRef): string {
    const { owner, repo: name } = repoSegments(repo.project);
    return `/repos/${owner}/${name}`;
  }

  // --- discovery ----------------------------------------------------------

  async listAssignedOpenIssues(repo: RepoRef): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
      query: { assignee: this.#c.botUser, state: 'open', per_page: 100 },
      paginate: true,
    });
    // GitHub's /issues list includes PRs (every PR is an issue) — drop them.
    return raw.filter((i) => i.pull_request === undefined).map(normalizeIssue);
  }

  async getSnapshot(repo: RepoRef, issueIid: number): Promise<IssueSnapshot> {
    const base = this.#base(repo);
    const rawIssue = await this.#c.apiRequired<RawIssue>('GET', `${base}/issues/${issueIid}`);
    const issue = normalizeIssue(rawIssue);

    const lastActor = await this.#lastActor(repo, issueIid);
    const issueWithActor: Issue = lastActor ? { ...issue, lastActor } : issue;

    const mr = await this.#findMaestroPr(repo, issueIid);

    const comments =
      (await this.#c.api<RawComment[]>('GET', `${base}/issues/${issueIid}/comments`, {
        query: { per_page: this.#c.commentCap },
        paginate: true,
      })) ?? [];
    const recentComments = comments
      .map(normalizeComment)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, this.#c.commentCap);

    return { repo, issue: issueWithActor, recentComments, ...(mr ? { mr } : {}) };
  }

  async getIssueState(repo: RepoRef, issueIid: number): Promise<'open' | 'closed' | 'missing'> {
    const raw = await this.#c.api<RawIssue>('GET', `${this.#base(repo)}/issues/${issueIid}`);
    if (raw === null) return 'missing';
    return raw.state === 'closed' ? 'closed' : 'open';
  }

  // --- mutation -----------------------------------------------------------

  async createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void> {
    const base = this.#base(repo);
    // GitHub needs the base ref's sha explicitly before creating a new ref. The ref
    // path keeps slashes literal (a branch like 'release/1.x' is part of the path).
    const ref = await this.#c.apiRequired<{ object: { sha: string } }>(
      'GET',
      `${base}/git/ref/heads/${fromRef}`,
    );
    try {
      await this.#c.api('POST', `${base}/git/refs`, {
        body: { ref: `refs/heads/${name}`, sha: ref.object.sha },
      });
    } catch (e) {
      if (e instanceof ForgeError && /already exists/i.test(e.message)) return; // idempotent (422)
      throw e;
    }
  }

  async createDraftMR(repo: RepoRef, args: CreateMRArgs): Promise<MergeRequest> {
    const base = this.#base(repo);
    const { owner } = repoSegments(repo.project);
    const existing = await this.#c.apiRequired<RawPr[]>('GET', `${base}/pulls`, {
      query: { head: `${owner}:${args.sourceBranch}`, state: 'open' },
    });
    if (existing.length > 0) {
      return normalizeMergeRequest(existing[0] as RawPr); // idempotent: return existing, no create
    }
    const created = await this.#c.apiRequired<RawPr>('POST', `${base}/pulls`, {
      body: {
        head: args.sourceBranch,
        base: args.targetBranch,
        title: args.title,
        body: args.description,
        draft: true, // GitHub-native draft — no title-prefix hack (contrast M2)
      },
    });
    if (args.assignToBot) await this.#addAssignees(repo, created.number, [this.#c.botUser]);
    return normalizeMergeRequest(created);
  }

  async updateMRDescription(repo: RepoRef, mrIid: number, body: string): Promise<void> {
    await this.#c.api('PATCH', `${this.#base(repo)}/pulls/${mrIid}`, { body: { body } });
  }

  async setDraft(repo: RepoRef, mrIid: number, draft: boolean): Promise<void> {
    const pr = await this.#c.apiRequired<RawPr & { node_id: string }>(
      'GET',
      `${this.#base(repo)}/pulls/${mrIid}`,
    );
    if ((pr.draft === true) === draft) return; // idempotent
    // REST has no draft toggle — GitHub flips it via GraphQL on the PR node id.
    const mutation = draft
      ? 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}'
      : 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}';
    await this.#c.graphql(mutation, { id: pr.node_id });
  }

  async assignMR(repo: RepoRef, mrIid: number, username: string): Promise<void> {
    // PRs assign via the issues endpoint; GitHub addresses users by login — no id lookup.
    const issue = await this.#c.apiRequired<RawIssue>('GET', `${this.#base(repo)}/issues/${mrIid}`);
    if ((issue.assignees ?? []).some((a) => a.login === username)) return; // already assigned
    await this.#addAssignees(repo, mrIid, [username]);
  }

  async mergeMR(
    repo: RepoRef,
    mrIid: number,
    strategy: MergeStrategy,
    deleteSource: boolean,
  ): Promise<void> {
    const base = this.#base(repo);
    const pr = await this.#c.apiRequired<RawPr>('GET', `${base}/pulls/${mrIid}`);
    if (pr.merged === true) return; // idempotent
    // GitHub has all three strategies natively — a clean 1:1 map (cleaner than GitLab).
    await this.#c.api('PUT', `${base}/pulls/${mrIid}/merge`, { body: { merge_method: strategy } });
    if (deleteSource) {
      // Already-gone branch → 404 → api() returns null, no throw (idempotent). Branch
      // slashes stay literal in the ref path.
      await this.#c.api('DELETE', `${base}/git/refs/heads/${pr.head.ref}`);
    }
  }

  async setIssueLabels(
    repo: RepoRef,
    issueIid: number,
    set: string[],
    unset: string[],
  ): Promise<void> {
    const base = this.#base(repo);
    const current = await this.#c.apiRequired<RawLabelObj[]>(
      'GET',
      `${base}/issues/${issueIid}/labels`,
      { query: { per_page: 100 } },
    );
    const have = new Set(current.map((l) => l.name));

    // Flat-label mutual exclusion (THE divergence): setting one maestro:* label drops
    // every OTHER maestro:* sibling present, even ones the caller never listed in unset.
    const setSet = new Set(set);
    const siblings = [...have].filter((n) => n.startsWith(MAESTRO_PREFIX) && !setSet.has(n));
    const toRemove = new Set([...siblings, ...unset]);
    const toAdd = set.filter((n) => !have.has(n));

    for (const name of toRemove) {
      if (!have.has(name)) continue; // not present → nothing to remove (idempotent)
      await this.#c.api('DELETE', `${base}/issues/${issueIid}/labels/${encodeURIComponent(name)}`);
    }
    if (toAdd.length > 0) {
      await this.#c.api('POST', `${base}/issues/${issueIid}/labels`, { body: { labels: toAdd } });
    }
  }

  async commentIssue(repo: RepoRef, issueIid: number, body: string): Promise<void> {
    await this.#c.api('POST', `${this.#base(repo)}/issues/${issueIid}/comments`, {
      body: { body },
    });
  }

  async commentMR(repo: RepoRef, mrIid: number, body: string): Promise<void> {
    // PR comments use the issues-comments endpoint (PR number ≡ issue number).
    await this.#c.api('POST', `${this.#base(repo)}/issues/${mrIid}/comments`, { body: { body } });
  }

  // --- onboarding / setup -------------------------------------------------

  async ensureLabels(repo: RepoRef, labels: Label[]): Promise<void> {
    const base = this.#base(repo);
    const existing = await this.#c.apiRequired<RawLabelObj[]>('GET', `${base}/labels`, {
      query: { per_page: 100 },
      paginate: true,
    });
    const have = new Set(existing.map((l) => l.name));
    for (const label of labels) {
      if (have.has(label.name)) continue; // create-missing only; existing untouched
      await this.#c.api('POST', `${base}/labels`, {
        body: { name: label.name, color: DEFAULT_LABEL_COLOR },
      });
    }
  }

  // ensureBoard is intentionally NOT defined — GitHub gets labels only (Projects V2
  // deferred §11/§17). §0.3 declares it optional (`ensureBoard?`); the daemon calls it
  // as `adapter.ensureBoard?.(…)`, so its absence needs zero GitHub-specific branching.

  async createIssue(repo: RepoRef, args: CreateIssueArgs): Promise<Issue> {
    const body: Record<string, unknown> = { title: args.title, body: args.body };
    if (args.assignToBot) body.assignees = [this.#c.botUser]; // by login, no id resolution
    const created = await this.#c.apiRequired<RawIssue>('POST', `${this.#base(repo)}/issues`, {
      body,
    });
    return normalizeIssue(created);
  }

  // --- internals ----------------------------------------------------------

  async #addAssignees(repo: RepoRef, number: number, assignees: string[]): Promise<void> {
    await this.#c.api('POST', `${this.#base(repo)}/issues/${number}/assignees`, {
      body: { assignees },
    });
  }

  async #lastActor(repo: RepoRef, issueIid: number) {
    const events =
      (await this.#c.api<RawTimelineEvent[]>(
        'GET',
        `${this.#base(repo)}/issues/${issueIid}/timeline`,
        { query: { per_page: 100 }, paginate: true },
      )) ?? [];
    const relevant = events
      .filter((e) => (e.event === 'assigned' || e.event === 'labeled') && e.actor)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const top = relevant[0];
    return top?.actor ? normalizeUser(top.actor) : undefined;
  }

  async #findMaestroPr(repo: RepoRef, issueIid: number): Promise<MergeRequest | undefined> {
    const base = this.#base(repo);
    const open =
      (await this.#c.api<RawPr[]>('GET', `${base}/pulls`, {
        query: { state: 'open', per_page: 100 },
        paginate: true,
      })) ?? [];
    const branchPrefix = `maestro/issue-${issueIid}-`;
    const candidate = open.find(
      (p) => p.head.ref.startsWith(branchPrefix) || closesThis(p, issueIid),
    );
    if (!candidate) return undefined;

    const approvals = await this.#reviewState(repo, candidate.number);
    return normalizeMergeRequest(candidate, approvals);
  }

  /** Full ApprovalState for a PR: APPROVED/CHANGES_REQUESTED from reviews, plus the
   *  edge-triggered changesRequested (review newer than the last bot commit, §0.3). */
  async #reviewState(repo: RepoRef, prNumber: number) {
    const base = this.#base(repo);
    const reviews =
      (await this.#c.api<RawReview[]>('GET', `${base}/pulls/${prNumber}/reviews`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? [];
    const approvals = normalizeReviews(reviews);

    const since = changesRequestedSince(reviews);
    if (!since) return approvals; // no blocking review → no need to read commits

    const lastBotPush = await this.#lastBotPush(repo, prNumber);
    // Unaddressed feedback if there's no bot push since the changes-requested review.
    const changesRequested = lastBotPush === undefined || since > lastBotPush;
    return { ...approvals, changesRequested };
  }

  async #lastBotPush(repo: RepoRef, prNumber: number): Promise<string | undefined> {
    const bot = this.#c.botUser;
    const commits =
      (await this.#c.api<RawCommit[]>('GET', `${this.#base(repo)}/pulls/${prNumber}/commits`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? [];
    return commits
      .filter(
        (cm) =>
          cm.author?.login === bot ||
          cm.committer?.login === bot ||
          cm.commit.author?.email?.split('@')[0] === bot,
      )
      .map((cm) => cm.commit.committer?.date ?? cm.commit.author?.date ?? '')
      .filter(Boolean)
      .sort()
      .at(-1);
  }
}

function closesThis(p: RawPr, issueIid: number): boolean {
  return new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${issueIid}\\b`, 'i').test(p.body ?? '');
}
