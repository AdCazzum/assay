#!/usr/bin/env bash
# Runs the Assay demo with both things it needs on PATH.
#
# Two separate requirements, and getting only one of them is the common failure:
#
#   CLAUDE_CODE_OAUTH_TOKEN  is exported ABOVE the interactive guard in ~/.bashrc,
#                            so a login shell (bash -l) has it. Without it the
#                            agent dies with "Not logged in".
#   mise (node, pnpm)        is activated BELOW that guard, so a login shell does
#                            NOT have it. Without it you get "pnpm: command not found".
#
# So `bash -lc 'pnpm ...'` fails, and so does plain `pnpm ...` from a script.
# You need the login shell for the token and an explicit mise activation for pnpm.
#
#   ./scripts/demo.sh              # live: a real agent, real networks
#   ./scripts/demo.sh rehearsal    # offline replay of the last captured run
#   ./scripts/demo.sh reset        # restore both providers' opening state first
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
eval "$(~/.local/bin/mise activate bash)"

case "${1:-live}" in
  reset)
    exec pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
    ;;
  rehearsal)
    shift || true
    exec pnpm --filter @assay/demo exec tsx src/index.ts rehearsal "$@"
    ;;
  live)
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "CLAUDE_CODE_OAUTH_TOKEN is not set." >&2
      echo "It lives in ~/.bashrc above the interactive guard, so run this through a login shell:" >&2
      echo "  bash -lc './scripts/demo.sh live'" >&2
      exit 1
    fi
    exec pnpm --filter @assay/demo exec tsx src/index.ts live
    ;;
  *)
    echo "usage: ./scripts/demo.sh [live|rehearsal [capturePath]|reset]" >&2
    exit 2
    ;;
esac
