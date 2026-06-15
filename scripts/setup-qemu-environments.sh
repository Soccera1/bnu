#!/usr/bin/env bash
# Create the persistent Gentoo guests used by run-gnu-qemu-matrix.sh.

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/qemu/common.sh"

only=all
usage() {
  cat <<'EOF'
usage: scripts/setup-qemu-environments.sh [--dry-run] [--only NAME]

NAME is standard, selinux, smack, hurd, or all. The setup is resumable and
stores downloads and separate qcow2 images below /var/tmp/bnu-qemu by default.
It never falls back from KVM to software emulation.
EOF
}
while (($#)); do
  case $1 in
    --dry-run) BNU_QEMU_DRY_RUN=1 ;;
    --only) [[ $# -ge 2 ]] || die "--only needs a value"; only=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ $only =~ ^(all|standard|selinux|smack|hurd)$ ]] || die "invalid --only value: $only"

for command in qemu-img qemu-system-x86_64 ssh scp ssh-keygen curl gpg mkfs.ext4; do require_command "$command"; done
require_kvm
ensure_state_dir

if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then
  case $only in
    hurd) required_gib=3 ;;
    standard) required_gib=8 ;;
    selinux) required_gib=20 ;;
    smack|all) required_gib=30 ;;
  esac
  require_free_gib "${BNU_QEMU_MIN_FREE_GIB:-$required_gib}"
fi
ensure_ssh_key

case $only in
  all)
    run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
      "$BNU_REPO_ROOT/scripts/qemu/download-images.sh" --only all
    ;;
  standard|hurd)
    run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
      "$BNU_REPO_ROOT/scripts/qemu/download-images.sh" --only "$([[ $only == standard ]] && printf cloud || printf hurd)"
    ;;
  selinux|smack)
    run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
      "$BNU_REPO_ROOT/scripts/qemu/download-images.sh" --only cloud
    run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
      "$BNU_REPO_ROOT/scripts/qemu/download-images.sh" --only selinux
    ;;
esac
[[ $only == hurd ]] && { note "Hurd image and isolated overlay are ready"; exit 0; }

run env BNU_QEMU_DIR="$BNU_QEMU_DIR" BNU_QEMU_DRY_RUN="$BNU_QEMU_DRY_RUN" \
  "$BNU_REPO_ROOT/scripts/qemu/build-payload.sh"

cloud=$BNU_QEMU_DIR/cloud/gentoo-cloudinit-amd64.qcow2
standard=$BNU_QEMU_DIR/standard/gentoo-standard-bnu.qcow2
seed=$BNU_QEMU_DIR/cloud/bnu-seed.iso
run mkdir -p -- "$BNU_QEMU_DIR/standard" "$BNU_QEMU_DIR/selinux" "$BNU_QEMU_DIR/smack"
create_seed_iso "$seed"
create_overlay "$cloud" "$standard"

if [[ $BNU_QEMU_DRY_RUN == 1 ]]; then
  note "would provision standard, SELinux MLS, and SMACK guests sequentially"
  note "each VM would use KVM, $BNU_QEMU_MEMORY RAM, and $BNU_QEMU_CPUS vCPUs"
  exit 0
fi

if [[ ! -e $standard.ready ]]; then
  vm=setup-standard
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$standard" "$vm" "" "$seed"
  if ! guest_ssh 'test -e /var/lib/bnu-standard-ready'; then
    guest_scp "$BNU_REPO_ROOT/scripts/qemu/guest/provision-base.sh" root@127.0.0.1:/root/provision-base.sh
    guest_ssh 'chmod 700 /root/provision-base.sh && /root/provision-base.sh && touch /var/lib/bnu-standard-ready'
  fi
  stop_vm "$vm"
  trap - EXIT HUP INT TERM
  touch "$standard.ready"
fi
[[ $only == standard ]] && { note "standard Gentoo guest is ready: $standard"; exit 0; }

selinux=$BNU_QEMU_DIR/selinux/gentoo-selinux-mls-bnu.qcow2
if [[ ! -e $selinux.ready ]]; then
  if [[ ! -s $selinux ]]; then run qemu-img create -q -f qcow2 "$selinux" 20G; fi
  vm=setup-selinux
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$standard" "$vm" "$BNU_QEMU_DIR/bnu-test-payload.ext4" "$seed" "$selinux"
  guest_scp "$BNU_REPO_ROOT/scripts/qemu/guest/provision-selinux.sh" root@127.0.0.1:/root/provision-selinux.sh
  guest_ssh 'chmod 700 /root/provision-selinux.sh && /root/provision-selinux.sh'
  stop_vm "$vm"
  trap - EXIT HUP INT TERM

  # Boot permissive once for the full relabel, then enable enforcing mode.
  vm=bootstrap-selinux
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$selinux" "$vm"
  guest_ssh 'sestatus; test "$(getenforce)" = Permissive; sestatus | grep -q "Loaded policy name:[[:space:]]*mls"; setsebool -P allow_execmem on; sed -i "s/^SELINUX=.*/SELINUX=enforcing/" /etc/selinux/config; sed -i "s/[[:space:]]*enforcing=0//g" /etc/default/grub; grub-mkconfig -o /boot/grub/grub.cfg'
  stop_vm "$vm"
  trap - EXIT HUP INT TERM

  vm=verify-selinux
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$selinux" "$vm"
  guest_ssh 'sestatus; test "$(getenforce)" = Enforcing; sestatus | grep -q "Loaded policy name:[[:space:]]*mls"; touch /var/lib/bnu-selinux-ready'
  stop_vm "$vm"
  trap - EXIT HUP INT TERM
  touch "$selinux.ready"
fi
[[ $only == selinux ]] && { note "SELinux MLS guest is ready: $selinux"; exit 0; }

smack=$BNU_QEMU_DIR/smack/gentoo-smack-bnu.qcow2
create_overlay "$selinux" "$smack"
if [[ ! -e $smack.ready ]]; then
  vm=setup-smack
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$smack" "$vm"
  if ! guest_ssh 'test -e /var/lib/bnu-smack'; then
    guest_scp "$BNU_REPO_ROOT/scripts/qemu/guest/provision-smack.sh" root@127.0.0.1:/root/provision-smack.sh
    guest_ssh 'chmod 700 /root/provision-smack.sh && /root/provision-smack.sh'
  fi
  stop_vm "$vm"
  trap - EXIT HUP INT TERM

  vm=verify-smack
  trap 'stop_vm "$vm"' EXIT HUP INT TERM
  start_vm "$smack" "$vm"
  guest_ssh 'grep -qw smack /sys/kernel/security/lsm; touch /var/lib/bnu-smack-ready'
  stop_vm "$vm"
  trap - EXIT HUP INT TERM
  touch "$smack.ready"
fi
note "all requested QEMU environments are ready beneath $BNU_QEMU_DIR"
