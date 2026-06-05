// Per-role prompt sections (#29 P1). A WORKFLOW.md body may declare role-specific
// prompts as `## role: <name>` sections; the daemon then feeds each lifecycle stage's
// agent only its own section. A body with NO role sections is a legacy generalist
// workflow: every role falls back to the whole body, so existing repos behave exactly
// as before and the per-stage pipeline (#29 P2) stays opt-in per repo.

export const AGENT_ROLES = ['define', 'plan', 'implement', 'review'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

const ROLE_HEADING = /^##\s*role:\s*([a-z]+)\s*$/im;

/** Does this body opt into the role pipeline at all? (#29 P2 keys stage dispatch on it.) */
export function declaresRoles(promptBody: string): boolean {
  return ROLE_HEADING.test(promptBody);
}

/**
 * Split a body into its `## role: <name>` sections. Text BEFORE the first role heading
 * is a shared preamble, prepended to every role's prompt (repo conventions, tone, build
 * commands belong to all roles). Unknown role names are kept verbatim inside whatever
 * section they appear under — only the four known headings split.
 */
export function roleBodies(promptBody: string): Map<AgentRole, string> {
  const out = new Map<AgentRole, string>();
  const lines = promptBody.split('\n');
  const known = new Set<string>(AGENT_ROLES);

  let preamble: string[] = [];
  let current: AgentRole | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null) out.set(current, buf.join('\n').trim());
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^##\s*role:\s*([a-z]+)\s*$/i);
    if (m && known.has(m[1]?.toLowerCase() ?? '')) {
      if (current === null) preamble = buf;
      flush();
      current = m[1]?.toLowerCase() as AgentRole;
      continue;
    }
    buf.push(line);
  }
  if (current === null) preamble = buf;
  flush();

  const pre = preamble.join('\n').trim();
  if (pre) {
    for (const [role, body] of out) out.set(role, body ? `${pre}\n\n${body}` : pre);
  }
  return out;
}

/** The prompt for one role: its section (plus shared preamble) when the body declares
 *  roles, else the whole body — the legacy generalist fallback. A declared-roles body
 *  missing THIS role also falls back to the whole body rather than running an agent
 *  with an empty prompt. */
export function promptForRole(promptBody: string, role: AgentRole): string {
  if (!declaresRoles(promptBody)) return promptBody;
  const body = roleBodies(promptBody).get(role);
  return body ? body : promptBody;
}
