// maestro.config.yaml schema (spec §5 / §0.6). The schema IS the type. Validate-
// before-reload (M1). token_env holds the NAME of an env var, never a token.

import { z } from 'zod';
import { zByteSize, zDuration } from './zod-helpers.js';

// bot_user (optional): the bot's account name ON THIS HOST. Usernames are per-forge
// namespaces, so one global default cannot span e.g. github.com and a self-hosted
// GitLab; absent → defaults.bot_user.
const ForgeEntrySchema = z.object({
  host: z.string(),
  token_env: z.string(),
  bot_user: z.string().optional(),
});

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
        // Partial-clone filter for per-issue workspaces (#27). Blobless by default:
        // commits/trees up front, blobs fetched lazily — far smaller and faster per
        // clone while keeping full isolation. `null` opts back into full clones.
        clone_filter: z.string().nullable().default('blob:none'),
      })
      .default({}),
    // Which coding agent the daemon runs (daemon-global, #codex). 'claude' (default)
    // or 'codex' (OpenAI Codex CLI). `command` overrides the binary/path; absent →
    // the kind name. Per-repo WORKFLOW.md keeps its `claude:` block for tuning
    // (stall_timeout/max_turns); max_turns/permission_mode are claude-only and ignored
    // under codex (codex exec has no turn cap; it uses --sandbox instead).
    agent: z
      .object({
        kind: z.enum(['claude', 'codex']).default('claude'),
        command: z.string().optional(),
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

/** Daemon-global agent selection. */
export type AgentSelection = _RawConfig['defaults']['agent'];

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
