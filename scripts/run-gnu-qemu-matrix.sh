#!/usr/bin/env bash
# Run and reconcile the complete GNU command-test inventory in Gentoo guests.

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/qemu/common.sh"

setup=0
dry=0
while (($#)); do
  case $1 in
    --setup) setup=1 ;;
    --dry-run) dry=1; BNU_QEMU_DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
usage: scripts/run-gnu-qemu-matrix.sh [--setup] [--dry-run]

--setup creates or resumes all required Gentoo guests first. The matrix runs
one KVM VM at a time with 1536 MiB RAM, saves logs, and accepts only the six
documented Bun runtime/ABI boundaries as unresolved upstream tests.
EOF
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

for command in bun qemu-img qemu-system-x86_64 ssh scp timeout awk sort comm; do require_command "$command"; done
require_kvm
ensure_state_dir
if ((setup)); then
  run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
    "$BNU_REPO_ROOT/scripts/setup-qemu-environments.sh"
fi
run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
  "$BNU_REPO_ROOT/scripts/qemu/build-payload.sh"

standard=$BNU_QEMU_DIR/standard/gentoo-standard-bnu.qcow2
selinux=$BNU_QEMU_DIR/selinux/gentoo-selinux-mls-bnu.qcow2
smack=$BNU_QEMU_DIR/smack/gentoo-smack-bnu.qcow2
hurd=$BNU_QEMU_DIR/hurd-gentoo-amd64/bnu-matrix-overlay.qcow2
payload=$BNU_QEMU_DIR/bnu-test-payload.ext4
for image in "$standard" "$selinux" "$smack" "$hurd"; do
  [[ -s $image || $dry == 1 ]] || die "missing $image; rerun with --setup"
done
if ((dry)); then
  note "would run: standard/nonroot, SELinux-MLS/root, SELinux policy supplements, SMACK supplements, Hurd boot probe"
  note "would reconcile every upstream test against the six-entry boundary allowlist"
  exit 0
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
logs=$BNU_QEMU_DIR/results/$stamp
mkdir -p "$logs"
runner=$BNU_REPO_ROOT/scripts/qemu/guest/run-tests.sh

run_guest_batch() {
  local image=$1 name=$2 mode=$3 log=$4
  shift 4
  local vm=matrix-$name
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$image" "$vm" "$payload"
  set +e
  guest_ssh "bash -s -- $(printf '%q ' "$mode" "$@")" <"$runner" 2>&1 | tee "$log"
  local status=${PIPESTATUS[0]}
  set -e
  stop_vm "$vm"
  trap - EXIT HUP INT TERM
  # Per-batch failures are reconciled after platform-specific reruns.
  printf 'batch-status=%s\n' "$status" >>"$log"
}

run_guest_batch "$standard" standard nonroot "$logs/standard-nonroot.log"
run_guest_batch "$selinux" selinux-root root "$logs/selinux-root.log"
run_guest_batch "$selinux" selinux-policy selected-root "$logs/selinux-policy.log" \
  tests/chcon/chcon.sh tests/cp/cp-a-selinux.sh tests/id/setgid.sh \
  tests/install/install-C-selinux.sh tests/install/install-Z-selinux.sh \
  tests/ls/selinux.sh tests/mkdir/selinux.sh tests/misc/selinux.sh
run_guest_batch "$smack" smack selected-root "$logs/smack-root.log" \
  tests/id/smack.sh tests/mkdir/smack-root.sh
run_guest_batch "$smack" smack-nobody selected-nonroot "$logs/smack-nobody.log" \
  tests/mkdir/smack-no-root.sh

# Bun has no GNU/Hurd executable, but boot the official amd64 image so this ABI
# boundary is checked against the real target rather than inferred from Linux.
hurd_serial=$logs/hurd-boot.log
set +e
timeout --kill-after=5s 90s qemu-system-x86_64 \
  -name bnu-hurd-probe -machine pc,accel=kvm -cpu host -smp "$BNU_QEMU_CPUS" -m "$BNU_QEMU_MEMORY" \
  -drive "if=ide,format=qcow2,snapshot=on,file=$hurd" \
  -nographic -monitor none -net none >"$hurd_serial" 2>&1
hurd_status=$?
set -e
printf 'qemu-status=%s\n' "$hurd_status" >>"$hurd_serial"
[[ $hurd_status -eq 124 ]] || die "the Gentoo Hurd VM exited early with status $hurd_status; see $hurd_serial"
grep -aq 'Gentoo GNU/Hurd' "$hurd_serial" ||
  die "the Gentoo Hurd boot entry was not reached; see $hurd_serial"
printf '%s\n' 'SKIP tests/id/gnu-zero-uids.sh - Bun provides no GNU/Hurd amd64 runtime' >>"$hurd_serial"

inventory=$logs/inventory
inventory_raw=$logs/inventory.raw
passed=$logs/passed
unresolved=$logs/unresolved
allowed=$logs/allowed-boundaries
bun "$BNU_REPO_ROOT/scripts/run-gnu-tests.js" --all --list >"$inventory_raw"
sort -u "$inventory_raw" >"$inventory"
cat >"$allowed" <<'EOF'
tests/df/no-mtab-status-masked-proc.sh
tests/id/gnu-zero-uids.sh
tests/nproc/nproc-quota-systemd.sh
tests/sort/sort-continue.sh
tests/sort/sort-merge-fdlimit.sh
tests/stat/stat-mount.sh
EOF
awk '/^PASS tests\// {print $2}' "$logs"/*.log | sort -u >"$passed"
comm -23 "$inventory" "$passed" | sort -u >"$unresolved"
unexpected=$logs/unexpected-unresolved
comm -23 "$unresolved" "$allowed" >"$unexpected"
count=$(wc -l <"$inventory")
[[ $count -eq 733 ]] || die "expected 733 upstream command tests, found $count"
if [[ -s $unexpected ]]; then
  note "unexpected unresolved tests:"
  sed 's/^/  /' "$unexpected" >&2
  die "matrix did not reconcile; logs are in $logs"
fi
missing_boundaries=$logs/missing-boundaries
comm -23 "$allowed" "$unresolved" >"$missing_boundaries"
if [[ -s $missing_boundaries ]]; then
  note "documented boundaries that unexpectedly passed:"
  sed 's/^/  /' "$missing_boundaries" >&2
fi
note "matrix reconciled all $count tests; only documented Bun boundaries remain"
note "logs: $logs"
