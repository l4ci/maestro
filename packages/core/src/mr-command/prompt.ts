// The built-in MR-command runner prompt (spec §5). Unlike the issue pipeline this is a
// FIXED prompt, NOT a WORKFLOW-declared role: a standalone command MR has no lifecycle
// stage to map a role onto. The agent orients on the MR, follows ONE human instruction,
// commits if it changed code (the daemon owns the push — the agent's token is scrubbed,
// §13.1), and reports via the standard status contract. STATUS_CONTRACT is appended by
// the runner's assemblePrompt to every run, so it is deliberately NOT repeated here —
// one source of truth, no duplicate "HOW TO REPORT" block.

import type { MergeRequest } from '../contracts/index.js';

export interface MrCommandPromptInput {
  /** The human instruction, already stripped of the leading `/maestro` token. */
  instruction: string;
  mr: MergeRequest;
  /** The repo's WORKFLOW.md body — appended verbatim for conventions (proof commands,
   *  tooling, house rules). Empty string when the repo declares none. */
  workflowBody: string;
}

/** Assemble the operating-protocol body for an MR-command run. The runner appends the
 *  reconstructed context JSON and the status contract; this is the task framing. */
export function buildMrCommandPrompt(input: MrCommandPromptInput): string {
  const { instruction, mr, workflowBody } = input;
  const sections = [
    '# Maestro MR command',
    '',
    'A human left a `/maestro` instruction on an open merge request that is assigned to ' +
      'you and has no backing issue. Carry out that ONE instruction on this MR — nothing more.',
    '',
    '## The merge request',
    '',
    `- Title: ${mr.title}`,
    `- Branch: \`${mr.sourceBranch}\` → \`${mr.targetBranch}\``,
    '- Description:',
    '',
    mr.description.trim() ? indent(mr.description.trim()) : '  _(empty)_',
    '',
    '## Your instruction',
    '',
    `> ${instruction}`,
    '',
    '## How to work',
    '',
    `1. Orient first: read the MR description and inspect the diff on this branch (\`git diff ${mr.targetBranch}...HEAD\`) before changing anything.`,
    '2. Do exactly what the instruction asks. If it needs no code change (a question, a ' +
      'check), just do the analysis and report what you found.',
    '3. If you change code, make atomic git commits in this working directory. The daemon ' +
      'pushes your commits to the MR branch afterwards — never push or use the network yourself.',
    '4. If the instruction is ambiguous or you are blocked on a human decision, report ' +
      '`needs_input` with your numbered questions instead of guessing.',
  ];
  const base = sections.join('\n');
  return workflowBody.trim()
    ? `${base}\n\n--- REPO CONVENTIONS (WORKFLOW.md) ---\n${workflowBody}`
    : base;
}

/** Indent a block by two spaces so a multi-line MR description renders as one unit. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
