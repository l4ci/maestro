// zod helpers for human-legible durations + byte sizes used in config (§0.6).

import { z } from 'zod';

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
const BYTE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;

/** '30s' | '5m' | '500ms' | '2h' → milliseconds. */
export const zDuration = z
  .string()
  .regex(/^(\d+)(ms|s|m|h)$/, 'expected a duration like 30s, 5m, 500ms, 2h')
  .transform((v) => {
    const m = /^(\d+)(ms|s|m|h)$/.exec(v) as RegExpExecArray;
    return Number(m[1]) * DURATION_UNITS[m[2] as keyof typeof DURATION_UNITS];
  });

/** '20GB' | '512MB' | '1024B' → bytes. */
export const zByteSize = z
  .string()
  .regex(/^(\d+)(B|KB|MB|GB|TB)$/, 'expected a size like 20GB, 512MB, 1024B')
  .transform((v) => {
    const m = /^(\d+)(B|KB|MB|GB|TB)$/.exec(v) as RegExpExecArray;
    return Number(m[1]) * BYTE_UNITS[m[2] as keyof typeof BYTE_UNITS];
  });
