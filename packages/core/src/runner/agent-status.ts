// Agent-agnostic response parsing (§10). Given candidate final-message texts from ANY
// agent CLI, find the last valid {status,summary} block; detect the usage/rate-limit
// signal (#47); scrub token shapes from diagnostics. No CLI specifics live here — the
// per-agent transcript→text mapping is the runner's job.

import type { AgentResult, AgentStatus } from '../contracts/index.js';

/** Map extractStatus over candidate texts in stream order; the LAST valid block wins
 *  (done-safe precedence: a correctly-emitted final status beats an earlier one). */
export function pickLastStatus(texts: string[]): AgentResult | null {
  let status: AgentResult | null = null;
  for (const t of texts) {
    const found = extractStatus(t);
    if (found) status = found;
  }
  return status;
}

export function extractStatus(result: unknown): AgentResult | null {
  if (typeof result !== 'string') return null;
  // Newest balanced top-level {...} first; a brace scanner that ignores braces inside
  // JSON strings survives a multi-line `mrDescription` with markdown braces (#48).
  for (const span of topLevelJsonObjects(result).reverse()) {
    const obj = tryParse(span) as Record<string, unknown> | null;
    if (obj && isAgentStatus(obj.status)) return toAgentResult(obj);
  }
  return null;
}

/** Build the result, carrying the optional #48 plan-channel fields when present. */
function toAgentResult(obj: Record<string, unknown>): AgentResult {
  const out: AgentResult = {
    status: obj.status as AgentStatus,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
  };
  if (typeof obj.mrDescription === 'string' && obj.mrDescription.trim()) {
    out.mrDescription = obj.mrDescription;
  }
  if (typeof obj.planComment === 'string' && obj.planComment.trim()) {
    out.planComment = obj.planComment;
  }
  const rev = obj.review as { verdict?: unknown; findings?: unknown } | undefined;
  if (rev && (rev.verdict === 'pass' || rev.verdict === 'fail')) {
    out.review = {
      verdict: rev.verdict,
      ...(typeof rev.findings === 'string' && rev.findings.trim()
        ? { findings: rev.findings }
        : {}),
    };
  }
  return out;
}

/** Every balanced top-level `{...}` substring, document order; string-aware (#48). */
export function topLevelJsonObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

function isAgentStatus(s: unknown): s is AgentStatus {
  return s === 'done' || s === 'needs_input' || s === 'in_progress';
}

export function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Recognize a CLI usage/rate-limit failure in transcript or stderr text (#47). Carries
 *  the reset time when present (seconds normalized to epoch ms). Wording is matched
 *  defensively so both Claude ("usage limit reached|<epoch>") and Codex variants hit. */
export function detectRateLimit(text: string): { resetAt?: number } | null {
  const m = text.match(/usage limit reached\|(\d{9,13})/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return { resetAt: n < 1e12 ? n * 1000 : n };
  }
  if (/usage limit reached|rate[ -]?limit(ed| exceeded)?/i.test(text)) return {};
  return null;
}

/** Best-effort scrub of obvious token shapes from diagnostics (defense in depth). */
export function scrub(s: string): string {
  return s.replace(/\b(glpat-|gh[pousr]_)[A-Za-z0-9_-]+/g, '$1***');
}
