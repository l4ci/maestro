// maestro.config.yaml schema (spec §5 / §0.6). The schema IS the type. Validate-
// before-reload (M1). token_env holds the NAME of an env var, never a token.

import { z } from 'zod';
import { zByteSize, zDuration } from './zod-helpers.js';

const ForgeEntrySchema = z.object({ host: z.string(), token_env: z.string() });

const ForgeConfigSchema = z.object({
  gitlab: z.union([ForgeEntrySchema, z.array(ForgeEntrySchema)]).optional(),
  github: z.union([ForgeEntrySchema, z.array(ForgeEntrySchema)]).optional(),
});

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
  forges: ForgeConfigSchema,
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

export type ForgeEntry = z.infer<typeof ForgeEntrySchema>;

/** Raw parsed type (before forge normalization). */
export type _RawConfig = z.infer<typeof ConfigSchema>;

/** MaestroConfig with normalized forge entries (always arrays at runtime). */
export interface MaestroConfig extends Omit<_RawConfig, 'forges'> {
  forges: {
    gitlab?: ForgeEntry[];
    github?: ForgeEntry[];
  };
}

/** Normalize a single forge entry or array into an array. */
function normalizeForgeEntry(v: ForgeEntry | ForgeEntry[] | undefined): ForgeEntry[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** Normalize forge entries in a raw config so each kind is always an array. */
export function normalizeForges(raw: _RawConfig): MaestroConfig {
  const gl = normalizeForgeEntry(raw.forges.gitlab);
  const gh = normalizeForgeEntry(raw.forges.github);
  // exactOptionalPropertyTypes: do NOT set key when value is undefined
  const forges: MaestroConfig['forges'] = {};
  if (gl !== undefined) forges.gitlab = gl;
  if (gh !== undefined) forges.github = gh;
  return {
    ...raw,
    forges,
  };
}
