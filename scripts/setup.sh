#!/usr/bin/env bash
# Maestro one-shot setup. Idempotent: installs deps, builds every package, scaffolds a
# local .env if missing, then verifies the external tools the daemon shells out to are on
# PATH (the same check `maestro doctor` runs). It NEVER writes secrets — you fill .env in.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, wherever this is cloned

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# 1. Toolchain present?
command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found — install it: https://pnpm.io/installation"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found — install Node >= 20"; exit 1; }

say "Installing dependencies (pnpm install)"
pnpm install

say "Building all packages (pnpm build)"
pnpm build

# 2. Secrets scaffold — copy the template once; never overwrite a filled-in .env.
if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  echo "  → edit .env and paste your MAESTRO_GITLAB_TOKEN / MAESTRO_GITHUB_TOKEN"
else
  say ".env already exists — leaving it untouched"
fi

# 3. Verify external tools (git/claude/glab/gh) are on PATH.
say "Checking required tools (maestro doctor)"
if node packages/cli/dist/cli.js doctor; then
  TOOLS_OK=1
else
  TOOLS_OK=0
fi

# 4. Put `maestro` on PATH (best-effort). Needs pnpm's global bin dir, which only
# exists after `pnpm setup` — so a fresh machine falls back to the full node path.
say "Linking the maestro CLI globally (pnpm link)"
if pnpm -C packages/cli link --global >/dev/null 2>&1; then
  LINKED=1
  echo "  → 'maestro' is on your PATH (open a new shell if it isn't picked up yet)"
else
  LINKED=0
  echo "  → skipped: pnpm has no global bin dir (run 'pnpm setup' first, then re-run"
  echo "    this script — or just call the CLI by its full path as shown below)"
fi

say "Setup complete"
if [ "${LINKED}" = "1" ]; then MAESTRO="maestro"; else MAESTRO="node packages/cli/dist/cli.js"; fi
cat <<EOF
Next steps:
  1. Edit .env             — paste your forge token(s)
  2. Edit maestro.config.yaml — set your forge host(s) and watchlist
  3. Onboard your first repo:
       ${MAESTRO} add gitlab.com/your-group/your-repo
  4. Start the daemon:
       ${MAESTRO} daemon
  5. Watch the dashboard:
       ${MAESTRO} dashboard   # then open http://127.0.0.1:4000
EOF

[ "${TOOLS_OK}" = "1" ] || echo "
NOTE: some required tools are missing (see above). Install them before starting the daemon."
