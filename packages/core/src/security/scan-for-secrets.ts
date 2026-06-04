// Committed-secret scanner (§13.1 / §0.11, M8 Slice 12). Hardens the M0 "secrets-
// not-in-git" stub into a real gate: feed it tracked files; it flags any line
// carrying a known forge-token literal. The maestro config carries only token_env
// NAMES (§5), never values, so it scans clean — the patterns are prefix-anchored to
// real token shapes precisely so an identifier like `MAESTRO_GITLAB_TOKEN` is NOT a
// match (low false-positive is the design constraint). A wired test runs this over
// `git ls-files` and fails CI on any finding.

export interface ScannedFile {
  path: string;
  text: string;
}

export interface SecretFinding {
  path: string;
  line: number; // 1-based
  pattern: string; // which rule matched
}

/** Known forge token shapes. Each is prefix-anchored to the secret's documented form
 *  so env-var NAMES and prose never match. Document any addition here. */
const PATTERNS: { name: string; re: RegExp }[] = [
  // GitLab personal/project/group access tokens: `glpat-` + ≥12 token chars.
  { name: 'gitlab-token', re: /glpat-[A-Za-z0-9_-]{12,}/ },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + ≥20 base62 chars.
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
];

export function scanForSecrets(files: ScannedFile[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i] as string)) {
          findings.push({ path: file.path, line: i + 1, pattern: p.name });
          break; // one finding per line is enough to fail the gate
        }
      }
    }
  }
  return findings;
}
