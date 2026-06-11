// WORKFLOW.md front-matter schema (spec §6 / §0.6). The markdown body after the
// front matter is carried separately as `promptBody: string` (the loader, M1).

import { z } from 'zod';

export const WorkflowSchema = z.object({
  forge: z.enum(['gitlab', 'github']).optional(), // inferred from host if omitted
  project: z.string(),
  bot_user: z.string(),
  manage_board: z.boolean().default(true),
  trigger: z
    .object({
      assignee: z.literal('bot').default('bot'),
      require_label: z.string().nullable().default(null),
      allowed_actors: z.array(z.string()).default([]),
    })
    .default({}),
  // One strategy, or a list to prove multiple surfaces at handoff (all must pass).
  // Single-object form stays valid (back-compat); both normalize to an array so every
  // downstream reader sees a list. A list containing `none` is a config error — `none`
  // means "no proof", which can't coexist with a real one.
  proof: z.preprocess(
    (p) => (Array.isArray(p) ? p : [p]),
    z
      .array(
        z.object({
          type: z.enum(['playwright', 'test-output', 'diff-summary', 'none']),
          command: z.string().optional(),
        }),
      )
      .nonempty('proof must list at least one strategy')
      .superRefine((strategies, ctx) => {
        if (strategies.length > 1 && strategies.some((s) => s.type === 'none')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "proof 'none' must be the only strategy, not one of a list",
          });
        }
      }),
  ),
  // Internal review loop (#29 P3): how many review-fail bounces are allowed since the
  // last human action before the daemon escalates (blocked flag + summary comment).
  review: z.object({ max_rounds: z.number().int().positive().default(3) }).default({}),
  git: z.object({
    default_branch: z.string().default('main'),
    target: z.string().default('main'),
    merge_strategy: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    delete_source_branch: z.boolean().default(true),
  }),
  environment: z
    .object({
      base_url: z.string().optional(),
      start_command: z.string().optional(),
      seed_command: z.string().optional(),
      health_check: z.string().optional(),
    })
    .partial()
    .default({}),
  claude: z
    .object({
      command: z.string().default('claude'),
      max_turns: z.number().int().positive().default(40),
      // Stall watchdog: kill the agent after this many seconds with NO stream events,
      // then retry once (§13). Per-repo because the floor is the repo's slowest single
      // no-event tool call — a cold `pnpm install` / full build emits nothing for
      // minutes, so a too-short window false-kills a healthy agent mid-command. Size it
      // ABOVE that floor; 120s suits a warm, fast repo.
      stall_timeout_seconds: z.number().int().positive().default(120),
      // Constrained to Claude's real modes (no free string). bypassPermissions maps to
      // --dangerously-skip-permissions in the runner; the rest pass through verbatim.
      permission_mode: z
        .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
        .default('bypassPermissions'),
    })
    .default({}),
  concurrency: z.object({ max_active: z.number().int().positive() }).default({ max_active: 2 }),
  // CI gate (#118/#120): opt-in per repo. When `gate` is true, the daemon holds the human
  // handoff until the head commit's pipeline is conclusive (a `running` pipeline holds the
  // handoff) and bounces a failed pipeline back to the agent. Default off — repos without
  // CI, or that don't want the gate, are unaffected.
  //  - wait_timeout_seconds: a `running` pipeline older than this hands off anyway, so a
  //    stuck/external CI can't block the handoff forever (seconds, matching
  //    `claude.stall_timeout_seconds`; default 1200 = 20m).
  //  - max_fix_rounds: CI-fix bounces allowed since the last human comment before the
  //    daemon parks the issue as blocked (mirrors review.max_rounds; default 3).
  ci: z
    .object({
      gate: z.boolean().default(false),
      wait_timeout_seconds: z.number().int().positive().default(1200),
      max_fix_rounds: z.number().int().positive().default(3),
    })
    .default({}),
});

export type WorkflowFrontMatter = z.infer<typeof WorkflowSchema>;
export type WorkflowEnvironment = WorkflowFrontMatter['environment'];
