// Argv → ParsedCommand. A thin, hand-rolled parser over a fixed verb table: NO business
// logic lives here, and bad input becomes a typed `usage-error` (mapped to a nonzero exit
// in main) rather than a thrown stacktrace — the CLI must never crash on user typos (A1-A3).

export type ParsedCommand =
  | { kind: 'add'; url: string; commit: boolean; public: boolean }
  | { kind: 'status'; issue: number }
  | { kind: 'list' }
  | { kind: 'logs'; issue: number }
  | { kind: 'run'; issue: number; attach: true }
  | { kind: 'daemon' }
  | { kind: 'doctor' }
  | { kind: 'help' }
  | { kind: 'usage-error'; message: string };

function usage(message: string): ParsedCommand {
  return { kind: 'usage-error', message };
}

/** Parse the first non-flag token after the verb as a positive issue iid, or null. */
function parseIssue(rest: string[]): number | null {
  const positional = rest.find((a) => !a.startsWith('--'));
  if (positional === undefined) return null;
  const n = Number(positional);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parse(argv: string[]): ParsedCommand {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'add': {
      const url = rest.find((a) => !a.startsWith('--'));
      if (url === undefined) return usage('add requires a repo url: maestro add <url>');
      // --public: conscious opt-in to onboard a PUBLIC repo (§13.1, OD-3).
      return {
        kind: 'add',
        url,
        commit: !rest.includes('--no-commit'),
        public: rest.includes('--public'),
      };
    }
    case 'list':
      return { kind: 'list' };
    case 'status': {
      const issue = parseIssue(rest);
      if (issue === null) return usage('status requires an issue iid: maestro status <issue>');
      return { kind: 'status', issue };
    }
    case 'logs': {
      const issue = parseIssue(rest);
      if (issue === null) return usage('logs requires an issue iid: maestro logs <issue>');
      return { kind: 'logs', issue };
    }
    case 'run': {
      const issue = parseIssue(rest);
      if (issue === null) return usage('run requires an issue iid: maestro run <issue> --attach');
      // v1: --attach is the ONLY run mode (OD-3); the daemon owns all headless work.
      if (!rest.includes('--attach')) return usage('run requires --attach (interactive only)');
      return { kind: 'run', issue, attach: true };
    }
    case 'daemon':
      return { kind: 'daemon' };
    case 'doctor':
      return { kind: 'doctor' };
    default:
      return { kind: 'help' };
  }
}
