# Herdr runner runbook

Operator guide for `agent.runner: herdr`. Instead of a headless `claude -p` call,
the daemon hosts each agent run as an interactive TUI in its own named
[herdr](https://github.com/l4ci/herdr) tab, so you can attach and watch (or step
in) mid-run while the daemon still drives the whole lifecycle: provision, prompt,
poll, read result, teardown. The contract is otherwise the same as headless:
every run is cold, no session resume, and the tab is torn down on every exit
path. Design background lives in spec
[§8 and §13.1](superpowers/specs/2026-06-03-maestro-design.md).

## Enabling it

In `maestro.config.yaml`:

```yaml
defaults:
  agent:
    kind: claude              # herdr can host either agent; runner is orthogonal to kind
    runner: herdr
    herdr:
      command: herdr          # optional: override the herdr binary/path
      workspace_label: maestro # herdr workspace the daemon's tabs live in (default: maestro)
      env:
        CLAUDE_CONFIG_DIR: /home/bot/.claude-bot
```

`herdr.env.CLAUDE_CONFIG_DIR` is required in practice. The pane's environment
comes from the **herdr server**, not from the daemon or your shell, so the agent
account has to be selected explicitly on the pane. Without it, the pane's
`claude` starts logged out and the run goes nowhere. Point it at the config
directory that holds the bot account's login.

Two headless-mode knobs stop working under herdr:

- `agent.command` / `claude.command` binary overrides have no effect; herdr
  resolves the binary from its own `--kind`.
- `max_turns` is ignored (it is a print-mode flag). The run budget is
  `claude.run_timeout_seconds` instead; see the troubleshooting table.

## What you see during a run

- A herdr workspace labeled `maestro` (or your `workspace_label`), created on
  demand. All of the daemon's tabs live there.
- One tab per active run, named `m-<repo>-<iid>` (lowercased, `[a-z0-9-]` only,
  capped at 48 chars), e.g. `m-maestro-123`.
- Attach to the tab through the herdr TUI or CLI to watch the agent work. You
  can intervene, for example answer a prompt the agent is stuck on. The daemon
  keeps polling agent state and reads the result from a nonce-guarded
  `.maestro/result.json` in the workspace, so watching or typing does not
  disturb the lifecycle.
- When the run ends (done, blocked, error, or timeout), the daemon closes the
  tab. An empty `maestro` workspace outside working hours is normal.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pane's `claude` is logged out / asks for login | The pane inherits the herdr **server's** env, not your shell's, and no account was selected | Set `agent.herdr.env.CLAUDE_CONFIG_DIR` to the bot account's config dir and restart the daemon |
| Run sits on a folder-trust dialog | First run in a fresh workspace; the dialog defaults to "No, exit" | The daemon nudges it automatically (down+enter selects "Yes, I trust this folder"). If a run still hangs there, attach and answer it by hand, then report it |
| Stale `m-*` tabs left in the workspace | The daemon crashed mid-run and never reached teardown | Start the daemon: its startup sweep closes every live `m-*` agent in the configured workspace (a fresh start means no run can legitimately be live). Or close them by hand in herdr |
| Run killed after ~30 minutes | Whole-run ceiling hit | Raise `claude.run_timeout_seconds` in the repo's WORKFLOW.md (default 1800). `max_turns` does nothing under herdr |

## Credentials (spec §13.1)

The daemon blanks the configured forge `token_env` names in every pane (an empty
`--env KEY=` override), which keeps the persisted git credential helper from
expanding them. That is the extent of what it can scrub: the pane otherwise
inherits the herdr server's own environment, which the daemon cannot audit.
A herdr server started with forge or git credentials in its env leaks them to
every pane it hosts. Run the herdr server itself under a minimal environment
that carries no such credentials.
