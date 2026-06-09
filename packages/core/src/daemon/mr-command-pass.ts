// The command-MR pass (spec §3/§5): the standalone-MR `/maestro` trigger. Runs per repo
// per tick alongside the issue lifecycle + cleanup passes, sharing the repo's slot budget.
// Only MRs with NO maestro-issue linkage are handled here — issue-backed MRs stay with the
// issue path, so nothing double-fires. Mirrors `evaluateLifecycle`: claim → decide → (slot)
// launch, releasing the claim when the launched work settles. The edge clears on the
// ALWAYS-posted reply comment, so it can never loop (the issue #5 lesson — stronger here,
// because the clear is a reply the daemon always posts, not a push that might not happen).

import type {
  AgentResult,
  Comment,
  MergeRequest,
  RepoRef,
  RunnerInput,
} from '../contracts/index.js';
import { MR_COMMAND_REPLY_SENTINEL } from '../contracts/index.js';
import { decideMrCommand } from '../mr-command/decide.js';
import { buildMrCommandPrompt } from '../mr-command/prompt.js';
import type { TickContext } from './ports.js';
import { repoKey } from './ports.js';

/** A standalone command MR: not a maestro-issue MR (branch prefix) and not Closing an
 *  issue. Issue-backed MRs are driven by the issue lifecycle; the command pass skips them. */
export function isStandaloneMr(mr: MergeRequest): boolean {
  return !mr.sourceBranch.startsWith('maestro/issue-') && mr.closesIssueIid === undefined;
}

/** In-flight namespace for command MRs — distinct from issues so an issue iid 5 and an MR
 *  iid 5 never collide in the process-wide set. */
const mrScope = (key: string): string => `${key}#mr`;

/**
 * Command-MR pass for one repo. Returns launched promises for the caller to await (the
 * same shape as `evaluateLifecycle`). One MR's failure is isolated and retried next tick.
 */
export async function evaluateMrCommands(
  repo: RepoRef,
  ctx: TickContext,
): Promise<{ pending: Promise<void>[]; active: boolean }> {
  const key = repoKey(repo);
  const scope = mrScope(key);
  const pending: Promise<void>[] = [];
  let active = false;

  let mrs: MergeRequest[] = [];
  try {
    mrs = await ctx.adapter.listAssignedOpenMergeRequests(repo);
  } catch (err) {
    ctx.log.error('mr-command: listAssignedOpenMergeRequests failed', {
      repo: key,
      err: String(err),
    });
    return { pending, active };
  }

  for (const mr of mrs) {
    if (!isStandaloneMr(mr)) continue;
    if (ctx.inFlight.has(scope, mr.iid)) continue;
    ctx.inFlight.add(scope, mr.iid);
    let launched: Promise<void> | undefined;
    try {
      const thread = await ctx.adapter.getMrComments(repo, mr.iid);
      const intent = decideMrCommand(thread, ctx.settings.botUser, ctx.settings.trigger);
      if (intent.kind !== 'run-mr-command') continue;

      // Claude rate-limited (#47): a fresh spawn is doomed — no-op, the command stays pending.
      if (ctx.rateGate.pausedUntil() !== null) {
        ctx.log.info('mr-command spawn skipped: claude rate-limited (#47)', {
          repo: key,
          mr: mr.iid,
        });
        continue;
      }
      // Share the repo's slot budget with the issue lifecycle (§14). No slot → wait, retry next tick.
      if (!ctx.slots.available(key, ctx.settings.concurrency.maxActive)) {
        ctx.log.info('mr-command waiting: no concurrency slot', { repo: key, mr: mr.iid });
        continue;
      }

      ctx.log.info('mr-command intent', { repo: key, mr: mr.iid });
      const release = ctx.slots.acquire(key);
      active = true;
      launched = runMrCommand(repo, mr, intent.instruction, thread, ctx)
        .then(
          () => {},
          (err) =>
            ctx.log.error('mr-command: run failed', { repo: key, mr: mr.iid, err: String(err) }),
        )
        .finally(() => {
          release();
          ctx.inFlight.delete(scope, mr.iid);
        });
      pending.push(launched);
    } catch (err) {
      ctx.log.error('mr-command: mr tick failed', { repo: key, mr: mr.iid, err: String(err) });
    } finally {
      if (!launched) ctx.inFlight.delete(scope, mr.iid);
    }
  }
  return { pending, active };
}

/** Check out the MR branch, run the agent on the one instruction, push iff it committed,
 *  and ALWAYS reply (§5) — the reply clears the edge. The single exception is a rate-limited
 *  spawn: nothing ran, so it does NOT reply and the command stays pending for next tick. */
async function runMrCommand(
  repo: RepoRef,
  mr: MergeRequest,
  instruction: string,
  thread: Comment[],
  ctx: TickContext,
): Promise<void> {
  const handle = await ctx.workspace.ensureMrWorkspace(repo, mr.iid, mr.sourceBranch);
  const result = await ctx.runner.run(buildMrRunnerInput(handle.dir, mr, instruction, thread, ctx));

  if (result.rateLimit) {
    const until = ctx.rateGate.trip(result.rateLimit.resetAt);
    ctx.log.warn('claude rate-limited during mr-command: pausing spawns (#47)', {
      repo: repoKey(repo),
      mr: mr.iid,
      resumeAt: new Date(until).toISOString(),
    });
    return; // no reply → edge stays hot, retried once the gate reopens
  }
  ctx.rateGate.clear();

  let pushed = 0;
  const unpushed = await ctx.workspace.countUnpushedCommits(handle);
  if (unpushed > 0) {
    await ctx.workspace.pushBranch(handle, mr.sourceBranch);
    pushed = unpushed;
  }
  await ctx.adapter.commentMR(repo, mr.iid, mrReply(result, pushed));
}

function buildMrRunnerInput(
  workspaceDir: string,
  mr: MergeRequest,
  instruction: string,
  thread: Comment[],
  ctx: TickContext,
): RunnerInput {
  return {
    workspaceDir,
    promptBody: buildMrCommandPrompt({ instruction, mr, workflowBody: ctx.promptBody }),
    context: { mr, recentComments: thread }, // no issue — a command MR has none
    claude: {
      command: ctx.workflow.claude.command,
      maxTurns: ctx.workflow.claude.max_turns,
      permissionMode: ctx.workflow.claude.permission_mode,
      stallTimeoutMs: ctx.workflow.claude.stall_timeout_seconds * 1000,
    },
  };
}

/** The reply body (§5). Every terminal status posts it WITH the sentinel, so the edge
 *  clears on every path — success, no-op, needs_input, ran-out-of-turns. */
function mrReply(result: AgentResult, pushed: number): string {
  const head =
    result.status === 'done'
      ? pushed > 0
        ? `✅ Done — pushed ${pushed} commit${pushed === 1 ? '' : 's'} to this MR.`
        : '✅ Done — no code changes were needed.'
      : result.status === 'needs_input'
        ? '🙋 I need a decision before continuing:'
        : '⏳ Ran out of turns before finishing — re-comment `/maestro …` to continue.';
  return `🎼 ${head}\n\n${result.summary}\n\n${MR_COMMAND_REPLY_SENTINEL}`;
}
