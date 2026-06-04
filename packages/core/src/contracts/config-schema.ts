// maestro.config.yaml schema (spec §5 / §0.6). The schema IS the type. Validate-
// before-reload (M1). token_env holds the NAME of an env var, never a token.

import { z } from 'zod';
import { zByteSize, zDuration } from './zod-helpers.js';

export const ConfigSchema = z.object({
  defaults: z.object({
    poll_interval_active: zDuration.default('30s'),
    poll_interval_idle: zDuration.default('5m'),
    poll_jitter: zDuration.default('5s'),
    bot_user: z.string(),
    concurrency: z.object({ global_max: z.number().int().positive() }).default({ global_max: 2 }),
    workspaces: z
      .object({
        root: z.string().default('./workspaces'),
        disk_cap: zByteSize.default('20GB'),
        cleanup: z.enum(['lru', 'on_terminal']).default('lru'),
      })
      .default({}),
  }),
  forges: z.object({
    gitlab: z.object({ host: z.string(), token_env: z.string() }).optional(),
    github: z.object({ host: z.string(), token_env: z.string() }).optional(),
  }),
  repos: z.array(
    z.object({
      url: z.string(), // host inferred → ForgeKind
      overrides: z
        .object({
          concurrency: z.object({ max_active: z.number().int().positive() }).optional(),
        })
        .partial()
        .optional(),
    }),
  ),
});

export type MaestroConfig = z.infer<typeof ConfigSchema>;
