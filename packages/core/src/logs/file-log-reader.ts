// Concrete LogReader over the gitignored logs/ cache (OD-2 read side). Layout:
// `logs/<repo-slug>/<iid>.ndjson`, append-only, one JSON LogLine per line — the format
// frozen in contracts/logs.ts (AM-12). M6 only READS it; the per-tick WRITER is M5's
// obligation (see plan note — M5 currently ships a console logger, so this reader
// returns [] until a writer lands). Missing/partial files degrade to [], never throw.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLine, LogReader, RepoRef } from '../contracts/index.js';
import { slugifyProject } from '../workspace/paths.js';

export class FileLogReader implements LogReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async readIssueLog(repo: RepoRef, issueIid: number, limit?: number): Promise<LogLine[]> {
    const path = join(this.#root, slugifyProject(repo.project), `${issueIid}.ndjson`);
    if (!existsSync(path)) return [];
    const lines: LogLine[] = [];
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as LogLine);
      } catch {
        // skip a corrupt/half-written line rather than fail the whole read
      }
    }
    return limit !== undefined ? lines.slice(-limit) : lines;
  }
}
