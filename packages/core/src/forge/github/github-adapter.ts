// GitHub forge adapter — the SECOND ForgeAdapter implementation (§0.3), built
// against the now-settled surface M2 (GitLab) established. All I/O flows through the
// injected Exec seam via the shared ForgeCli transport (cli.ts); getSnapshot delegates
// the choreography to the shared snapshot algorithm (snapshot.ts) and supplies only
// GitHub-specific primitives. Normalizes GitHub JSON to the SAME §0.2 model M2 produces,
// so the reconciler + daemon drive GitHub with ZERO changes — that zero-change property
// is the milestone's headline proof.
//
// GitHub diverges from GitLab on exactly three things: (1) FLAT labels `maestro:*`
// whose mutual exclusion the adapter enforces (GitLab got it free from scoped
// labels); (2) approval / changes-requested derived from PR REVIEWS; (3) ensureBoard
// is left UNDEFINED (labels only — Projects V2 deferred §11/§17). botUser is
// construction config (§0.10), mirroring M2. MR≡PR throughout.

import type {
  ApprovalState,
  CiFailureLogs,
  CiStatus,
  Comment,
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
import { MAESTRO_COMMAND_RE } from '../../contracts/index.js';
import { labelNames } from '../../contracts/labels.js';
import { TtlMemoizer } from '../../utils/ttl-memo.js';
import { formatJobLog, truncateCiLogs } from '../ci-logs.js';
import { ForgeCli } from '../cli.js';
import { ForgeError } from '../errors.js';
import { type ForgePrimitives, assembleSnapshot } from '../snapshot.js';
import {
  type RawCheckRunsResponse,
  type RawCombinedStatus,
  type RawComment,
  type RawCommit,
  type RawIssue,
  type RawPr,
  type RawReview,
  type RawTimelineEvent,
  type RawUser,
  changesRequestedSince,
  isFailedCheckRun,
  normalizeCiStatus,
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
  readonly host: string;
  readonly #c: ForgeCli;
  readonly #snapMemo = new TtlMemoizer<string, IssueSnapshot>(5_000);
  readonly #stateMemo = new TtlMemoizer<string, 'open' | 'closed' | 'missing'>(5_000);

  constructor(exec: Exec, cfg: GithubClientConfig) {
    this.host = cfg.host;
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

  async listOpenIssuesByLabel(repo: RepoRef, label: string): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
      query: { labels: label, state: 'open', per_page: 100 },
      paginate: true,
    });
    // GitHub's /issues list includes PRs (every PR is an issue) — drop them.
    return raw.filter((i) => i.pull_request === undefined).map(normalizeIssue);
  }

  async listGrabbableIssues(repo: RepoRef): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
      query: { state: 'open', per_page: 100 },
    });
    const bot = this.#c.botUser;
    // GitHub's /issues list includes PRs (every PR is an issue) — drop them; and drop issues
    // already assigned to the bot (those ride the board, not the grabbable list).
    return raw
      .filter((i) => i.pull_request === undefined)
      .filter((i) => !(i.assignees ?? []).some((u) => u.login === bot))
      .map(normalizeIssue);
  }

  async getSnapshot(repo: RepoRef, issueIid: number, ciGate = false): Promise<IssueSnapshot> {
    return this.#snapMemo.get(`${repo.url}-${issueIid}-${ciGate}`, () =>
      assembleSnapshot(repo, issueIid, this.#primitives(repo), this.#c.commentCap, ciGate),
    );
  }

  async getIssueState(repo: RepoRef, issueIid: number): Promise<'open' | 'closed' | 'missing'> {
    return this.#stateMemo.get(`${repo.url}-${issueIid}`, async () => {
      const raw = await this.#c.api<RawIssue>('GET', `${this.#base(repo)}/issues/${issueIid}`);
      if (raw === null) return 'missing';
      return raw.state === 'closed' ? 'closed' : 'open';
    });
  }

  async listAssignedOpenMergeRequests(repo: RepoRef): Promise<MergeRequest[]> {
    // GitHub has no PR-assignee filter; the issues endpoint carries PRs (every PR is an
    // issue), so filter to PRs then fetch each as a PR to normalize branch/merged state.
    const issues =
      (await this.#c.api<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
        query: { assignee: this.#c.botUser, state: 'open', per_page: 100 },
        paginate: true,
      })) ?? [];
    const prs = issues.filter((i) => i.pull_request !== undefined);
    return Promise.all(prs.map((i) => this.#getMergeRequest(repo, i.number)));
  }

  async getMrComments(repo: RepoRef, mrIid: number): Promise<Comment[]> {
    const comments =
      (await this.#c.api<RawComment[]>('GET', `${this.#base(repo)}/issues/${mrIid}/comments`, {
        query: { per_page: this.#c.commentCap },
        paginate: true,
      })) ?? [];
    return comments
      .map(normalizeComment)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, this.#c.commentCap);
  }

  async getMergeRequestState(
    repo: RepoRef,
    mrIid: number,
  ): Promise<'open' | 'closed' | 'merged' | 'missing'> {
    const raw = await this.#c.api<RawPr>('GET', `${this.#base(repo)}/pulls/${mrIid}`);
    if (raw === null) return 'missing';
    if (raw.merged === true || (raw.merged_at != null && raw.merged_at !== '')) return 'merged';
    return raw.state === 'closed' ? 'closed' : 'open';
  }

  /** Commit subjects for the #86 progress mirror — the SAME endpoint #lastBotPushAt hits.
   *  GitHub lists PR commits chronologically already (oldest first; the endpoint itself
   *  caps at 250), so no reorder; --paginate keeps the count exact up to that cap. */
  async listMrCommits(repo: RepoRef, mrIid: number): Promise<string[]> {
    const commits =
      (await this.#c.api<RawCommit[]>('GET', `${this.#base(repo)}/pulls/${mrIid}/commits`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? [];
    return commits
      .map((cm) => (cm.commit.message ?? '').split('\n', 1)[0] ?? '')
      .filter((s) => s !== '');
  }

  /** Fetch one PR and normalize — shared by the command-MR pass. */
  async #getMergeRequest(repo: RepoRef, prNumber: number): Promise<MergeRequest> {
    return normalizeMergeRequest(
      await this.#c.apiRequired<RawPr>('GET', `${this.#base(repo)}/pulls/${prNumber}`),
    );
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

  async requestReview(repo: RepoRef, mrIid: number, username: string): Promise<void> {
    // GitHub 422s on a review request from the PR author. maestro always opens the PR as the
    // bot, so a review of the bot account by itself (shared-account setup, bot_user = creator)
    // is the author case — skip it deterministically rather than provoking the 422.
    if (username === this.#c.botUser) return;
    const pr = await this.#c.apiRequired<RawPr & { requested_reviewers?: RawUser[] }>(
      'GET',
      `${this.#base(repo)}/pulls/${mrIid}`,
    );
    if ((pr.requested_reviewers ?? []).some((r) => r.login === username)) return; // already requested
    try {
      await this.#c.api('POST', `${this.#base(repo)}/pulls/${mrIid}/requested_reviewers`, {
        body: { reviewers: [username] },
      });
    } catch (e) {
      // 422 = the user can't be a reviewer here (a non-collaborator on this repo). Not fatal:
      // the handoff's ready-for-review comment @-mentions them and carries the notification.
      if (e instanceof ForgeError && /\b422\b/.test(e.message)) return;
      throw e;
    }
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

  async closeMR(repo: RepoRef, mrIid: number): Promise<void> {
    const base = this.#base(repo);
    const pr = await this.#c.apiRequired<RawPr>('GET', `${base}/pulls/${mrIid}`);
    if (pr.merged === true || pr.state === 'closed') return; // idempotent — terminal already
    await this.#c.api('PATCH', `${base}/pulls/${mrIid}`, { body: { state: 'closed' } });
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

  /** The §0.3 forge-specific fetches the shared snapshot algorithm composes (snapshot.ts).
   *  GitHub diverges from GitLab on approvals (derived from PR reviews) and label shape,
   *  but the choreography above the seam is identical. */
  #primitives(repo: RepoRef): ForgePrimitives {
    const base = this.#base(repo);
    return {
      issue: async (iid) =>
        normalizeIssue(await this.#c.apiRequired<RawIssue>('GET', `${base}/issues/${iid}`)),
      lastActor: (iid) => this.#lastActor(repo, iid),
      comments: async (iid) => {
        const comments =
          (await this.#c.api<RawComment[]>('GET', `${base}/issues/${iid}/comments`, {
            query: { per_page: this.#c.commentCap },
            paginate: true,
          })) ?? [];
        return comments.map(normalizeComment);
      },
      openMergeRequests: async () => {
        // GitHub lists PRs repo-wide; the shared matcher filters by branch/closes (snapshot.ts).
        const open =
          (await this.#c.api<RawPr[]>('GET', `${base}/pulls`, {
            query: { state: 'open', per_page: 100 },
            paginate: true,
          })) ?? [];
        return open.map((p) => normalizeMergeRequest(p));
      },
      approvalBase: (mrIid) => this.#approvalBase(repo, mrIid),
      blockingThreadAt: async (mrIid) => {
        const reviewAt = changesRequestedSince(await this.#reviews(repo, mrIid));
        const commandAt = await this.#maestroCommandAt(repo, mrIid);
        return [reviewAt, commandAt]
          .filter((t): t is string => t !== undefined)
          .sort()
          .at(-1);
      },
      lastBotPushAt: (mr) => this.#lastBotPushAt(repo, mr.iid),
      ciStatus: (mr) => this.#ciStatus(repo, mr.sourceBranch),
    };
  }

  /** Head-commit CI conclusion (#120): fold check-runs + the legacy combined commit status
   *  for the source branch's tip into one §0.2 CiStatus. The branch name resolves to its
   *  HEAD commit on both endpoints, so no extra PR-detail round-trip for the sha. A 404
   *  (branch gone / no commit) reads as `none` via the api()'s null. */
  async #ciStatus(repo: RepoRef, sourceBranch: string): Promise<CiStatus> {
    const base = this.#base(repo);
    const ref = encodeURIComponent(sourceBranch);
    const checks = await this.#c.api<RawCheckRunsResponse>(
      'GET',
      `${base}/commits/${ref}/check-runs`,
      { query: { per_page: 100 } },
    );
    const status = await this.#c.api<RawCombinedStatus>('GET', `${base}/commits/${ref}/status`, {
      query: { per_page: 100 },
    });
    return normalizeCiStatus(checks?.check_runs ?? [], status);
  }

  /** Failing-check logs for the head commit (#120): the failed check-runs' `output`
   *  (title + summary — GitHub's failure annotations), concatenated and truncated. The
   *  check-run `head_sha` keys the CI-fix comment for idempotency. Returns undefined when
   *  there are no failed checks / no head sha. (Full Actions logs are a zip artifact; the
   *  check output carries the human-readable failure, which is what the cold session needs.) */
  async ciFailureLogs(repo: RepoRef, mr: MergeRequest): Promise<CiFailureLogs | undefined> {
    const ref = encodeURIComponent(mr.sourceBranch);
    const resp = await this.#c.api<RawCheckRunsResponse>(
      'GET',
      `${this.#base(repo)}/commits/${ref}/check-runs`,
      { query: { per_page: 100 } },
    );
    const runs = resp?.check_runs ?? [];
    const headSha = runs.find((r) => r.head_sha)?.head_sha;
    if (!headSha) return undefined;
    const sections = runs
      .filter(isFailedCheckRun)
      .map((r) =>
        formatJobLog(
          r.name ?? 'check',
          [r.output?.title, r.output?.summary].filter(Boolean).join('\n') || '(no check output)',
        ),
      );
    if (sections.length === 0) return undefined;
    return { headSha, logs: truncateCiLogs(sections.join('\n\n')) };
  }

  /** Shared-account escape hatch (mirror of the GitLab adapter's): the bot/operator
   *  account cannot file a CHANGES_REQUESTED review on its own PR, so a bot-authored
   *  PR-conversation comment whose body STARTS with `/maestro` counts as the blocking
   *  signal instead. Newest such timestamp; the edge still clears via the
   *  last-bot-push comparison in the shared algorithm (snapshot.ts). */
  async #maestroCommandAt(repo: RepoRef, prNumber: number): Promise<string | undefined> {
    const bot = this.#c.botUser;
    const comments =
      (await this.#c.api<RawComment[]>('GET', `${this.#base(repo)}/issues/${prNumber}/comments`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? [];
    return comments
      .filter((c) => c.user?.login === bot && MAESTRO_COMMAND_RE.test(c.body))
      .map((c) => c.created_at)
      .sort()
      .at(-1);
  }

  /** PR reviews for a PR (paginated). Read for both the approval base and the blocking
   *  timestamp; the shared algorithm short-circuits the second read when no blocking exists. */
  async #reviews(repo: RepoRef, prNumber: number): Promise<RawReview[]> {
    return (
      (await this.#c.api<RawReview[]>('GET', `${this.#base(repo)}/pulls/${prNumber}/reviews`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? []
    );
  }

  /** Approval base for a PR: APPROVED/CHANGES_REQUESTED reduced from reviews (§0.2). */
  async #approvalBase(repo: RepoRef, prNumber: number): Promise<ApprovalState> {
    return normalizeReviews(await this.#reviews(repo, prNumber));
  }

  /** Newest commit timestamp on the PR — author-AGNOSTIC (§0.3 edge-trigger half). The daemon
   *  owns this branch, so any commit post-dating the blocking signal means the work was redone;
   *  that is what retires the changes-requested edge (snapshot.ts). Deliberately NOT filtered by
   *  bot_user: on a shared account the agent's commits carry the operator's own git identity, so
   *  an author filter stranded this timestamp before the feedback and looped (issue #5, GitLab twin). */
  async #lastBotPushAt(repo: RepoRef, prNumber: number): Promise<string | undefined> {
    const commits =
      (await this.#c.api<RawCommit[]>('GET', `${this.#base(repo)}/pulls/${prNumber}/commits`, {
        query: { per_page: 100 },
        paginate: true,
      })) ?? [];
    return commits
      .map((cm) => cm.commit.committer?.date ?? cm.commit.author?.date ?? '')
      .filter(Boolean)
      .sort()
      .at(-1);
  }
}
