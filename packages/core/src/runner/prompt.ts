// The agent-facing half of the §10 contract: the stdin payload (operating-protocol
// prompt + reconstructed forge context) and the status contract appended to EVERY
// prompt. Agent-agnostic — both the Claude and Codex runners send this exact payload.

import type { RunnerInput } from '../contracts/index.js';

/** Assemble the stdin payload: operating-protocol prompt body + reconstructed context. */
export function assemblePrompt(input: RunnerInput): string {
  const { issue, mr, recentComments } = input.context;
  const ctx = {
    // null for a command-MR run — that prompt carries the MR framing itself (§MR-command).
    issue: issue
      ? { iid: issue.iid, title: issue.title, body: issue.body, webUrl: issue.webUrl }
      : null,
    mr: mr ? { iid: mr.iid, description: mr.description, isDraft: mr.isDraft } : null,
    recentComments: recentComments.map((c) => ({
      author: c.author.username,
      body: c.body,
      at: c.createdAt,
    })),
  };
  return (
    `${input.promptBody}\n\n` +
    `--- CONTEXT (reconstructed from the forge) ---\n${JSON.stringify(ctx, null, 2)}\n\n` +
    `--- HOW TO REPORT (required) ---\n${STATUS_CONTRACT}\n`
  );
}

/** The §10 status contract, appended to EVERY prompt so emission never depends on the
 *  per-repo WORKFLOW author getting it right. The daemon consumes only this final line; the
 *  agent has no forge token, so the daemon (not the agent) acts on it. */
export const STATUS_CONTRACT =
  'Make your changes as atomic git commits in this working directory — the daemon pushes ' +
  'them; never push or use the network yourself. You have NO access to the issue or MR ' +
  'beyond the context above: you cannot post comments or edit the MR yourself. You ' +
  'communicate ONLY through your final message: end it with EXACTLY one JSON object on its ' +
  'own line, with nothing after it:\n' +
  '  {"status":"done","summary":"<what you changed>"}          — work complete, hand off for review\n' +
  '  {"status":"needs_input","summary":"<your questions>"}     — you need a human decision; you will be\n' +
  '                                                              marked blocked and the summary is posted to\n' +
  '                                                              them verbatim. Put questions HERE, never in a file.\n' +
  '  {"status":"in_progress","summary":"<where you are>"}      — you ran out of turns; will resume next tick\n' +
  '\n' +
  'Summaries are posted to humans on the forge (#25): write readable Markdown — short ' +
  'paragraphs, bullet lists where they aid scanning, never one wall of text. When ' +
  'needs_input asks more than one question, NUMBER the questions (1., 2., …) so each ' +
  'can be answered by number.\n' +
  '\n' +
  'To make your PLAN VISIBLE (the daemon, not you, writes it to the forge), add these ' +
  'OPTIONAL fields to that same JSON object:\n' +
  '  "mrDescription": "<full Markdown for the MR description: a detailed plan AND a ' +
  '`- [ ]` / `- [x]` checkbox todo list>"\n' +
  '      The MR description is your DURABLE plan/todo — it is fed back to you next session. ' +
  'Re-emit it each session with the boxes you have finished ticked (`- [x]`). Keep the ' +
  '`Closes #<issue>` line so the merge auto-closes the issue.\n' +
  '  "planComment": "<a short plan summary>"\n' +
  '      Posted ONCE as an issue comment on your first planning session. Omit it afterwards.\n' +
  '\n' +
  'When you are the REVIEW agent (#29): judge the diff against the plan and add\n' +
  '  "review": {"verdict":"pass"}                                — no blocking findings\n' +
  '  "review": {"verdict":"fail","findings":"<numbered list>"}   — blocking findings; they are\n' +
  '                                                                posted for the next implementation\n' +
  '                                                                session, so be specific and actionable.';
