#!/usr/bin/env bash
# Single sequential entry point for local unit tests and the GNU QEMU matrix.

set -Eeuo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
dry=0
for arg in "$@"; do [[ $arg == --dry-run ]] && dry=1; done

if ((dry)); then
  printf '+ bun %q\n' "$root/scripts/run-bun-tests-bounded.js" >&2
else
  bun "$root/scripts/run-bun-tests-bounded.js"
fi
exec "$root/scripts/run-gnu-qemu-matrix.sh" "$@"
