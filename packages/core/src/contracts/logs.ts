// Logs-cache contract (AM-12). M5 writes the gitignored logs/ cache; the CLI/web
// (M6) read it for `status`/`logs`/dashboard. Format frozen here so both agree.

import type { RepoRef } from './forge-model.js';

export interface LogLine {
  ts: string; // ISO 8601
  repo: string; // RepoRef.project
  issueIid: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface LogReader {
  readIssueLog(repo: RepoRef, issueIid: number, limit?: number): Promise<LogLine[]>;
}
