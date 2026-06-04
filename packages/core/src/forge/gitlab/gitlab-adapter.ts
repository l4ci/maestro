// GitLab forge adapter — the reference ForgeAdapter implementation (§0.3). All I/O
// flows through the injected Exec seam via the shared ForgeCli transport (cli.ts);
// getSnapshot delegates the choreography to the shared snapshot algorithm (snapshot.ts)
// and supplies only GitLab-specific primitives. Normalizes GitLab JSON to the §0.2
// model; idempotent mutations (§13); scoped labels give mutual exclusion for free;
// §11 Free-tier board automation. botUser is construction config (§0.10).

import type {
  ApprovalState,
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
import { ForgeCli } from '../cli.js';
import { ForgeError } from '../errors.js';
import { type ForgePrimitives, assembleSnapshot } from '../snapshot.js';
import {
  type RawApprovals,
  type RawIssue,
  type RawMr,
  type RawNote,
  type RawUser,
  normalizeApprovals,
  normalizeComment,
  normalizeIssue,
  normalizeMergeRequest,
  normalizeUser,
} from './normalize.js';

const DEFAULT_LABEL_COLOR = '#6699cc';

/** Adapter construction config (M0 §0.10). Kept as a named type for the public barrel. */
export interface GitlabClientConfig {
  token: string;
  host: string; // e.g. gitlab.com
  botUser: string; // used for edge-trigger / lastActor
  commentCap?: number; // recentComments bound (default 50)
}

/** URL-encode a GitLab project path for the `:id` segment: group/repo → group%2Frepo. */
export function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

interface RawLabel {
  id: number | string;
  name: string;
}
interface RawBoard {
  id: number | string;
}
interface RawList {
  id: number | string;
  label?: RawLabel;
}
interface RawDiscussion {
  id: string;
  notes: {
    id: number | string;
    author: RawUser;
    created_at: string;
    resolvable?: boolean;
    resolved?: boolean;
    system?: boolean;
  }[];
}
interface RawCommit {
  id: string;
  committed_date: string;
  author_name: string;
  author_email: string;
}
interface RawLabelEvent {
  id: number | string;
  user: RawUser | null;
  created_at: string;
}

export class GitlabAdapter implements ForgeAdapter {
  readonly kind = 'gitlab' as const;
  readonly #c: ForgeCli;

  constructor(exec: Exec, cfg: GitlabClientConfig) {
    this.#c = new ForgeCli(exec, {
      bin: 'glab',
      forge: 'gitlab',
      env: { GITLAB_TOKEN: cfg.token, GITLAB_HOST: cfg.host }, // glab reads these
      botUser: cfg.botUser,
      ...(cfg.commentCap !== undefined ? { commentCap: cfg.commentCap } : {}),
    });
  }

  #pid(repo: RepoRef): string {
    return encodeProject(repo.project);
  }

  // --- discovery ----------------------------------------------------------

  async listAssignedOpenIssues(repo: RepoRef): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>(
      'GET',
      `/projects/${this.#pid(repo)}/issues`,
      {
        query: { assignee_username: this.#c.botUser, state: 'opened', per_page: 100 },
      },
    );
    return raw.map(normalizeIssue);
  }

  async getSnapshot(repo: RepoRef, issueIid: number): Promise<IssueSnapshot> {
    return assembleSnapshot(repo, issueIid, this.#primitives(repo), this.#c.commentCap);
  }

  async getIssueState(repo: RepoRef, issueIid: number): Promise<'open' | 'closed' | 'missing'> {
    const raw = await this.#c.api<RawIssue>(
      'GET',
      `/projects/${this.#pid(repo)}/issues/${issueIid}`,
    );
    if (raw === null) return 'missing';
    return raw.state === 'closed' ? 'closed' : 'open';
  }

  // --- mutation -----------------------------------------------------------

  async createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void> {
    try {
      await this.#c.api('POST', `/projects/${this.#pid(repo)}/repository/branches`, {
        query: { branch: name, ref: fromRef },
      });
    } catch (e) {
      if (e instanceof ForgeError && /already exists/i.test(e.message)) return; // idempotent
      throw e;
    }
  }

  async createDraftMR(repo: RepoRef, args: CreateMRArgs): Promise<MergeRequest> {
    const pid = this.#pid(repo);
    const existing = await this.#c.apiRequired<RawMr[]>('GET', `/projects/${pid}/merge_requests`, {
      query: { source_branch: args.sourceBranch, state: 'opened' },
    });
    if (existing.length > 0) {
      return normalizeMergeRequest(existing[0] as RawMr); // idempotent: return existing, no create
    }
    const body: Record<string, unknown> = {
      source_branch: args.sourceBranch,
      target_branch: args.targetBranch,
      title: withDraftPrefix(args.title),
      description: args.description,
    };
    if (args.assignToBot) body.assignee_ids = [Number(await this.#resolveUserId(this.#c.botUser))];
    const created = await this.#c.apiRequired<RawMr>('POST', `/projects/${pid}/merge_requests`, {
      body,
    });
    return normalizeMergeRequest(created);
  }

  async updateMRDescription(repo: RepoRef, mrIid: number, body: string): Promise<void> {
    await this.#c.api('PUT', `/projects/${this.#pid(repo)}/merge_requests/${mrIid}`, {
      body: { description: body },
    });
  }

  async setDraft(repo: RepoRef, mrIid: number, draft: boolean): Promise<void> {
    const pid = this.#pid(repo);
    const mr = await this.#c.apiRequired<RawMr>('GET', `/projects/${pid}/merge_requests/${mrIid}`);
    const isDraft =
      /^(draft:|wip:)/i.test(mr.title.trim()) || mr.draft === true || mr.work_in_progress === true;
    if (isDraft === draft) return; // idempotent — no spurious title mangling
    const title = draft ? withDraftPrefix(mr.title) : stripDraftPrefix(mr.title);
    await this.#c.api('PUT', `/projects/${pid}/merge_requests/${mrIid}`, { body: { title } });
  }

  async assignMR(repo: RepoRef, mrIid: number, username: string): Promise<void> {
    const pid = this.#pid(repo);
    const id = Number(await this.#resolveUserId(username));
    const mr = await this.#c.apiRequired<RawMr & { assignees?: RawUser[] }>(
      'GET',
      `/projects/${pid}/merge_requests/${mrIid}`,
    );
    if ((mr.assignees ?? []).some((a) => String(a.id) === String(id))) return; // already assigned
    await this.#c.api('PUT', `/projects/${pid}/merge_requests/${mrIid}`, {
      body: { assignee_ids: [id] },
    });
  }

  async mergeMR(
    repo: RepoRef,
    mrIid: number,
    strategy: MergeStrategy,
    deleteSource: boolean,
  ): Promise<void> {
    const pid = this.#pid(repo);
    const mr = await this.#c.apiRequired<RawMr>('GET', `/projects/${pid}/merge_requests/${mrIid}`);
    if (mr.state === 'merged') return; // idempotent
    // Strategy map: squash→squash:true; merge/rebase→squash:false (true rebase-merge
    // follows the project's merge_method). should_remove_source_branch carries deleteSource.
    await this.#c.api('PUT', `/projects/${pid}/merge_requests/${mrIid}/merge`, {
      body: { squash: strategy === 'squash', should_remove_source_branch: deleteSource },
    });
  }

  async setIssueLabels(
    repo: RepoRef,
    issueIid: number,
    set: string[],
    unset: string[],
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (set.length > 0) body.add_labels = set.join(','); // delta params don't clobber non-maestro labels
    if (unset.length > 0) body.remove_labels = unset.join(',');
    // Scoped labels (maestro::*) drop their sibling automatically — no manual unset (contrast M7).
    await this.#c.api('PUT', `/projects/${this.#pid(repo)}/issues/${issueIid}`, { body });
  }

  async commentIssue(repo: RepoRef, issueIid: number, body: string): Promise<void> {
    await this.#c.api('POST', `/projects/${this.#pid(repo)}/issues/${issueIid}/notes`, {
      body: { body },
    });
  }

  async commentMR(repo: RepoRef, mrIid: number, body: string): Promise<void> {
    await this.#c.api('POST', `/projects/${this.#pid(repo)}/merge_requests/${mrIid}/notes`, {
      body: { body },
    });
  }

  // --- onboarding / setup -------------------------------------------------

  async ensureLabels(repo: RepoRef, labels: Label[]): Promise<void> {
    const pid = this.#pid(repo);
    const existing = await this.#c.apiRequired<RawLabel[]>('GET', `/projects/${pid}/labels`, {
      query: { per_page: 100 },
    });
    const have = new Set(existing.map((l) => l.name));
    for (const label of labels) {
      if (have.has(label.name)) continue; // create-missing only; existing untouched
      await this.#c.api('POST', `/projects/${pid}/labels`, {
        body: { name: label.name, color: DEFAULT_LABEL_COLOR },
      });
    }
  }

  async ensureBoard(repo: RepoRef, orderedLabels: Label[]): Promise<void> {
    const pid = this.#pid(repo);
    const labels = await this.#c.apiRequired<RawLabel[]>('GET', `/projects/${pid}/labels`, {
      query: { per_page: 100 },
    });
    const idByName = new Map(labels.map((l) => [l.name, String(l.id)]));

    const boards = await this.#c.apiRequired<RawBoard[]>('GET', `/projects/${pid}/boards`);
    let boardId: string;
    if (boards.length > 0) {
      boardId = String((boards[0] as RawBoard).id); // Free-tier: single board, reuse it
    } else {
      const created = await this.#c.apiRequired<RawBoard>('POST', `/projects/${pid}/boards`, {
        body: { name: 'Maestro' },
      });
      boardId = String(created.id);
    }

    const lists = await this.#c.apiRequired<RawList[]>(
      'GET',
      `/projects/${pid}/boards/${boardId}/lists`,
    );
    const listLabelIds = new Set(lists.map((l) => (l.label ? String(l.label.id) : '')));

    for (const label of orderedLabels) {
      // lifecycle order preserved by iterating orderedLabels in sequence
      const labelId = idByName.get(label.name);
      if (!labelId || listLabelIds.has(labelId)) continue; // skip missing-id or existing list (idempotent)
      await this.#c.api('POST', `/projects/${pid}/boards/${boardId}/lists`, {
        body: { label_id: Number(labelId) },
      });
    }
  }

  async createIssue(repo: RepoRef, args: CreateIssueArgs): Promise<Issue> {
    const pid = this.#pid(repo);
    const body: Record<string, unknown> = { title: args.title, description: args.body };
    if (args.assignToBot) body.assignee_ids = [Number(await this.#resolveUserId(this.#c.botUser))];
    const created = await this.#c.apiRequired<RawIssue>('POST', `/projects/${pid}/issues`, {
      body,
    });
    return normalizeIssue(created);
  }

  // --- internals ----------------------------------------------------------

  async #resolveUserId(username: string): Promise<string> {
    const users = await this.#c.apiRequired<RawUser[]>('GET', '/users', { query: { username } });
    const u = users[0];
    if (!u)
      throw new ForgeError('gitlab', 'GET', `/users?username=${username}`, 404, 'user not found');
    return String(u.id);
  }

  async #lastActor(repo: RepoRef, issueIid: number) {
    const pid = this.#pid(repo);
    const events =
      (await this.#c.api<RawLabelEvent[]>(
        'GET',
        `/projects/${pid}/issues/${issueIid}/resource_label_events`,
        {
          query: { per_page: 100 },
        },
      )) ?? [];
    const withUser = events
      .filter((e) => e.user)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const top = withUser[0];
    return top?.user ? normalizeUser(top.user) : undefined;
  }

  /** The §0.3 forge-specific fetches the shared snapshot algorithm composes (snapshot.ts).
   *  Everything here is normalized GitLab JSON; the choreography lives above the seam. */
  #primitives(repo: RepoRef): ForgePrimitives {
    const pid = this.#pid(repo);
    return {
      issue: async (iid) =>
        normalizeIssue(
          await this.#c.apiRequired<RawIssue>('GET', `/projects/${pid}/issues/${iid}`),
        ),
      lastActor: (iid) => this.#lastActor(repo, iid),
      comments: async (iid) => {
        const notes =
          (await this.#c.api<RawNote[]>('GET', `/projects/${pid}/issues/${iid}/notes`, {
            query: { sort: 'desc', order_by: 'created_at', per_page: this.#c.commentCap },
          })) ?? [];
        return notes.filter((n) => !n.system).map(normalizeComment);
      },
      openMergeRequests: async (iid) => {
        const related =
          (await this.#c.api<RawMr[]>(
            'GET',
            `/projects/${pid}/issues/${iid}/related_merge_requests`,
          )) ?? [];
        return related.map((m) => normalizeMergeRequest(m));
      },
      approvalBase: (mrIid) => this.#approvalState(repo, mrIid),
      blockingThreadAt: (mrIid) => this.#blockingThreadAt(repo, mrIid),
      lastBotPushAt: (mr) => this.#lastBotPushAt(repo, mr.sourceBranch),
    };
  }

  async #approvalState(repo: RepoRef, mrIid: number): Promise<ApprovalState> {
    const raw =
      (await this.#c.api<RawApprovals>(
        'GET',
        `/projects/${this.#pid(repo)}/merge_requests/${mrIid}/approvals`,
      )) ?? {};
    return normalizeApprovals(raw);
  }

  /** Newest unresolved non-bot blocking discussion timestamp (§0.3 edge-trigger half).
   *  The shared algorithm compares this against the last bot push (snapshot.ts). */
  async #blockingThreadAt(repo: RepoRef, mrIid: number): Promise<string | undefined> {
    const pid = this.#pid(repo);
    const bot = this.#c.botUser;
    const discussions =
      (await this.#c.api<RawDiscussion[]>(
        'GET',
        `/projects/${pid}/merge_requests/${mrIid}/discussions`,
      )) ?? [];
    return discussions
      .map((d) => d.notes[0])
      .filter(
        (n): n is RawDiscussion['notes'][number] =>
          !!n &&
          !n.system &&
          n.resolvable === true &&
          n.resolved !== true &&
          n.author.username !== bot,
      )
      .map((n) => n.created_at)
      .sort()
      .at(-1);
  }

  /** Newest bot-authored commit timestamp on the source branch (§0.3 edge-trigger half). */
  async #lastBotPushAt(repo: RepoRef, sourceBranch: string): Promise<string | undefined> {
    const pid = this.#pid(repo);
    const bot = this.#c.botUser;
    const commits =
      (await this.#c.api<RawCommit[]>('GET', `/projects/${pid}/repository/commits`, {
        query: { ref_name: sourceBranch, per_page: 100 },
      })) ?? [];
    return commits
      .filter((cm) => cm.author_name === bot || cm.author_email.split('@')[0] === bot)
      .map((cm) => cm.committed_date)
      .sort()
      .at(-1);
  }
}

function withDraftPrefix(title: string): string {
  return /^(draft:|wip:)/i.test(title.trim()) ? title : `Draft: ${title}`;
}

function stripDraftPrefix(title: string): string {
  return title.replace(/^(draft:|wip:)\s*/i, '');
}
