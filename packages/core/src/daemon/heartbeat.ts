// Daemon liveness signal (#40). The web server is a SEPARATE process from the daemon; the
// dashboard assembles its view straight from the forge, so it renders a perfectly healthy
// board while the daemon is dead — issues just silently stop moving. This is the
// process-level twin of the per-repo `error` marker ("broken auth never looks like a
// healthy empty repo").
//
// The daemon writes a tiny status file each tick — last-tick timestamp, active worker
// count, the configured cap, and its own tick cadence — next to the logs/ cache the web
// side already shares (LogReader). The write is atomic (tmp + rename) so the reader never
// observes a torn file. The reader degrades to `undefined` on a missing/corrupt file
// (fresh install, daemon never ran), never throwing. Freshness is judged against the
// cadence the daemon itself recorded, not a magic constant baked into the page.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The serialized heartbeat — the read-model the dashboard renders. Times are ms-since-epoch
 *  (Clock.now()), so the reader/page can age them without timezone parsing. */
export interface Heartbeat {
  /** When the daemon last completed a tick pass (ms since epoch). */
  lastTickAt: number;
  /** Workers active at that tick (Claims.globalActive). */
  activeWorkers: number;
  /** The configured global cap (concurrency.global_max). */
  maxWorkers: number;
  /** The daemon's tick cadence (ms) — freshness threshold derives from THIS, not a page constant. */
  tickIntervalMs: number;
}

/** Default heartbeat file location under the logs root the web side already reads. */
export function heartbeatPath(logsRoot: string): string {
  return join(logsRoot, 'daemon-heartbeat.json');
}

/**
 * Writes the daemon heartbeat atomically (tmp file + rename, same dir so rename is atomic on
 * the same filesystem). The reader therefore only ever sees a complete prior version, never a
 * half-written one. Creates the parent directory on first write so a fresh install with no
 * logs/ yet still gets a heartbeat.
 */
export class HeartbeatWriter {
  readonly #path: string;

  constructor(logsRoot: string) {
    this.#path = heartbeatPath(logsRoot);
  }

  write(beat: Heartbeat): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(beat), 'utf8');
    renameSync(tmp, this.#path); // atomic swap — readers never see the tmp
  }
}

/** Reads the heartbeat, or `undefined` when the file is absent (daemon never ran) or
 *  unparsable/incomplete (mid-write torn read is impossible given the atomic writer, but a
 *  hand-edited or truncated file still degrades to "no signal" rather than throwing). */
export function readHeartbeat(logsRoot: string): Heartbeat | undefined {
  const path = heartbeatPath(logsRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Heartbeat>;
    if (
      typeof parsed.lastTickAt !== 'number' ||
      typeof parsed.activeWorkers !== 'number' ||
      typeof parsed.maxWorkers !== 'number' ||
      typeof parsed.tickIntervalMs !== 'number'
    ) {
      return undefined;
    }
    return {
      lastTickAt: parsed.lastTickAt,
      activeWorkers: parsed.activeWorkers,
      maxWorkers: parsed.maxWorkers,
      tickIntervalMs: parsed.tickIntervalMs,
    };
  } catch {
    return undefined;
  }
}
