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
  proof: z.object({
    type: z.enum(['playwright', 'test-output', 'diff-summary', 'none']),
    command: z.string().optional(),
  }),
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
      permission_mode: z.string().default('bypassPermissions'),
    })
    .default({}),
  concurrency: z.object({ max_active: z.number().int().positive() }).default({ max_active: 2 }),
});

export type WorkflowFrontMatter = z.infer<typeof WorkflowSchema>;
export type WorkflowEnvironment = WorkflowFrontMatter['environment'];
