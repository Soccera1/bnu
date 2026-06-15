#!/usr/bin/env bash
# Build an unprivileged ext4 disk containing BNU, Bun, and the GNU tarball.

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

output=$BNU_QEMU_DIR/bnu-test-payload.ext4
size=${BNU_QEMU_PAYLOAD_SIZE:-4G}
while (($#)); do
  case $1 in
    --dry-run) BNU_QEMU_DRY_RUN=1 ;;
    --output) [[ $# -ge 2 ]] || die "--output needs a path"; output=$2; shift ;;
    --size) [[ $# -ge 2 ]] || die "--size needs a value"; size=$2; shift ;;
    -h|--help)
      printf 'usage: %s [--dry-run] [--output PATH] [--size 4G]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

for command in bun mkfs.ext4 truncate; do require_command "$command"; done
ensure_state_dir
[[ -r $BNU_REPO_ROOT/coreutils-9.11.tar.xz ]] || die "missing coreutils-9.11.tar.xz"
bun_path=$(command -v bun)
staging=$(mktemp -d "${TMPDIR:-/tmp}/bnu-payload.XXXXXX")
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT HUP INT TERM

run mkdir -p -- "$staging/bnu/repo" "$staging/bnu/bin" "$staging/bnu/artifacts"
for entry in bin src scripts tests docs package.json README.md coreutils-9.11.tar.xz; do
  [[ -e $BNU_REPO_ROOT/$entry ]] || continue
  run cp -a -- "$BNU_REPO_ROOT/$entry" "$staging/bnu/repo/"
done
run cp -L -- "$bun_path" "$staging/bnu/bin/bun"
selinux_stage=$BNU_QEMU_DIR/selinux/stage3-amd64-hardened-selinux-systemd.tar.xz
if [[ -s $selinux_stage ]]; then
  run cp -a -- "$selinux_stage" "$staging/bnu/artifacts/"
fi
if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then
  printf '%s\n' "$(git -C "$BNU_REPO_ROOT" rev-parse HEAD 2>/dev/null || printf unknown)" >"$staging/bnu/REVISION"
fi

run rm -f -- "$output.new"
run truncate -s "$size" "$output.new"
run mkfs.ext4 -q -F -L BNU_PAYLOAD -d "$staging" "$output.new"
run mv -- "$output.new" "$output"
note "payload ready: $output"
