#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export GITLEA_PAUSE_ON_ERROR=1
exec bash "$SCRIPT_DIR/start.sh" "$@"
