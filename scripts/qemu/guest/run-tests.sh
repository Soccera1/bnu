#!/usr/bin/env bash
set -Eeuo pipefail

mode=${1:?mode is required}
shift
mountpoint=/mnt/bnu-payload
work=/var/tmp/bnu-current
mkdir -p "$mountpoint"
mountpoint -q "$mountpoint" || mount -o ro LABEL=BNU_PAYLOAD "$mountpoint"
rm -rf -- "$work"
mkdir -p "$work"
cp -a "$mountpoint/bnu/repo/." "$work/"
install -m 755 "$mountpoint/bnu/bin/bun" "$work/bun"
chmod -R a+rX "$work"

common=(
  "$work/bun" "$work/scripts/run-gnu-tests.js"
  --tarball "$work/coreutils-9.11.tar.xz"
  --very-expensive --timeout 300s --rss-limit 1024MiB --memory-limit 3GiB
)
case $mode in
  nonroot)
    mkdir -p /tmp/bnu-nobody
    chown nobody:nogroup /tmp/bnu-nobody 2>/dev/null || chown nobody:nobody /tmp/bnu-nobody
    exec runuser -u nobody -- env HOME=/tmp/bnu-nobody TMPDIR=/tmp/bnu-nobody \
      "${common[@]}" --all --nonroot-tests "$@"
    ;;
  root)
    exec env HOME=/root TMPDIR=/tmp "${common[@]}" --all --root-tests "$@"
    ;;
  selected-root)
    exec env HOME=/root TMPDIR=/tmp "${common[@]}" "$@"
    ;;
  selected-nonroot)
    mkdir -p /tmp/bnu-nobody
    chown nobody:nogroup /tmp/bnu-nobody 2>/dev/null || chown nobody:nobody /tmp/bnu-nobody
    exec runuser -u nobody -- env HOME=/tmp/bnu-nobody TMPDIR=/tmp/bnu-nobody \
      "${common[@]}" "$@"
    ;;
  *) echo "unknown test mode: $mode" >&2; exit 2 ;;
esac
