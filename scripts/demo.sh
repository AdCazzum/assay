#!/usr/bin/env bash
# Restores the demo's opening state on both providers.
#
# The demo itself is not a script any more: open Claude Code in this repo and run
# `/assay-demo`. The `assay` MCP server is registered from `.mcp.json`, so a real
# Claude Code session drives the real loop and renders its own reasoning and tool
# calls. See docs/demo-run-sheet.md.
#
# This wrapper still exists because the reset needs mise on PATH and is easy to
# get wrong: `mise` is activated BELOW the interactive guard in ~/.bashrc, so a
# login or non-interactive shell does not have it and `pnpm` is not found.
#
#   ./scripts/demo.sh          # reset both providers (~57s). Never on stage.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
eval "$(~/.local/bin/mise activate bash)"

case "${1:-reset}" in
  reset)
    exec pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
    ;;
  *)
    echo "usage: ./scripts/demo.sh [reset]" >&2
    echo "the demo itself runs inside Claude Code: /assay-demo" >&2
    exit 2
    ;;
esac
