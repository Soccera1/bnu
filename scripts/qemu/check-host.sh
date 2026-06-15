#!/usr/bin/env bash
# Report host-side prerequisites without changing anything.

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

missing=0
for command in bash bun qemu-img qemu-system-x86_64 ssh scp ssh-keygen curl gpg \
  mkfs.ext4 timeout awk sort comm sha512sum tar xz; do
  if command -v "$command" >/dev/null 2>&1; then
    printf 'ok       %s\n' "$command"
  else
    printf 'missing  %s\n' "$command"
    missing=1
  fi
done
if command -v xorriso >/dev/null 2>&1 || command -v genisoimage >/dev/null 2>&1; then
  printf 'ok       xorriso or genisoimage\n'
else
  printf 'missing  xorriso or genisoimage\n'
  missing=1
fi
if [[ -r /dev/kvm && -w /dev/kvm ]]; then
  printf 'ok       /dev/kvm (read/write)\n'
else
  printf 'missing  /dev/kvm access (KVM group membership may require a new login)\n'
  missing=1
fi
if code=$(find_ovmf code 2>/dev/null) && vars=$(find_ovmf vars 2>/dev/null); then
  printf 'ok       OVMF code: %s\n' "$code"
  printf 'ok       OVMF vars: %s\n' "$vars"
else
  printf 'missing  OVMF firmware (or set BNU_OVMF_CODE and BNU_OVMF_VARS)\n'
  missing=1
fi
exit "$missing"
