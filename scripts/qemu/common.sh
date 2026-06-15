#!/usr/bin/env bash
# Shared, host-distro-neutral helpers for the BNU Gentoo QEMU test matrix.

set -Eeuo pipefail

BNU_REPO_ROOT=${BNU_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
BNU_QEMU_DIR=${BNU_QEMU_DIR:-/var/tmp/bnu-qemu}
BNU_QEMU_MEMORY=${BNU_QEMU_MEMORY:-1536M}
BNU_QEMU_CPUS=${BNU_QEMU_CPUS:-2}
BNU_QEMU_SSH_PORT=${BNU_QEMU_SSH_PORT:-22222}
BNU_QEMU_TIMEOUT=${BNU_QEMU_TIMEOUT:-900}
BNU_QEMU_DRY_RUN=${BNU_QEMU_DRY_RUN:-0}

note() { printf 'bnu-qemu: %s\n' "$*" >&2; }
die() { note "$*"; exit 2; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

run() {
  if [[ $BNU_QEMU_DRY_RUN == 1 ]]; then
    printf '+ ' >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
  else
    "$@"
  fi
}

ensure_state_dir() {
  if [[ $BNU_QEMU_DRY_RUN == 1 ]]; then
    note "would create state directory $BNU_QEMU_DIR"
    return
  fi
  mkdir -p -- "$BNU_QEMU_DIR" 2>/dev/null ||
    die "cannot write $BNU_QEMU_DIR; create it for this user or set BNU_QEMU_DIR"
  [[ -w $BNU_QEMU_DIR ]] || die "state directory is not writable: $BNU_QEMU_DIR"
}

require_free_gib() {
  local required=$1 available_kib available_gib
  available_kib=$(df -Pk "$BNU_QEMU_DIR" | awk 'NR == 2 {print $4}')
  [[ $available_kib =~ ^[0-9]+$ ]] || die "could not determine free space below $BNU_QEMU_DIR"
  available_gib=$((available_kib / 1024 / 1024))
  (( available_gib >= required )) ||
    die "$BNU_QEMU_DIR has ${available_gib} GiB free; this setup phase requires at least ${required} GiB free"
}

require_kvm() {
  [[ -e /dev/kvm ]] || die "/dev/kvm is absent; this matrix intentionally has no software-emulation fallback"
  [[ -r /dev/kvm && -w /dev/kvm ]] ||
    die "/dev/kvm is not accessible; add this user to the host's KVM group and start a new login session"
}

find_ovmf() {
  local kind=$1 candidate
  local -a code=(
    /usr/share/edk2/OvmfX64/OVMF_CODE.fd
    /usr/share/OVMF/OVMF_CODE.fd
    /usr/share/OVMF/OVMF_CODE_4M.fd
    /usr/share/edk2-ovmf/x64/OVMF_CODE.fd
    /usr/share/edk2/ovmf/OVMF_CODE.fd
    /usr/share/edk2/x64/OVMF_CODE.fd
  )
  local -a vars=(
    /usr/share/edk2/OvmfX64/OVMF_VARS.fd
    /usr/share/OVMF/OVMF_VARS.fd
    /usr/share/OVMF/OVMF_VARS_4M.fd
    /usr/share/edk2-ovmf/x64/OVMF_VARS.fd
    /usr/share/edk2/ovmf/OVMF_VARS.fd
    /usr/share/edk2/x64/OVMF_VARS.fd
  )
  local -a candidates
  if [[ $kind == code ]]; then candidates=("${code[@]}"); else candidates=("${vars[@]}"); fi
  for candidate in "${candidates[@]}"; do
    [[ -r $candidate ]] && { printf '%s\n' "$candidate"; return; }
  done
  die "could not find OVMF $kind firmware; set BNU_OVMF_CODE and BNU_OVMF_VARS explicitly"
}

ovmf_code() { printf '%s\n' "${BNU_OVMF_CODE:-$(find_ovmf code)}"; }
ovmf_vars() { printf '%s\n' "${BNU_OVMF_VARS:-$(find_ovmf vars)}"; }

download() {
  local url=$1 output=$2
  [[ -s $output ]] && { note "using cached $(basename -- "$output")"; return; }
  run curl --fail --location --retry 4 --retry-delay 2 --continue-at - --output "$output.part" "$url"
  run mv -- "$output.part" "$output"
}

prepare_gnupg() {
  local gnupg=$1 bundle=$BNU_QEMU_DIR/gentoo-service-keys.gpg
  run mkdir -p -- "$gnupg"
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then chmod 700 "$gnupg"; fi
  download https://qa-reports.gentoo.org/output/service-keys.gpg "$bundle"
  run gpg --batch --homedir "$gnupg" --import "$bundle"
}

verify_detached() {
  local gnupg=$1 signature=$2 artifact=$3
  run gpg --batch --homedir "$gnupg" --status-fd 1 --verify "$signature" "$artifact"
}

create_overlay() {
  local base=$1 overlay=$2
  [[ -s $overlay ]] && { note "using existing overlay $overlay"; return; }
  run qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$overlay"
}

ensure_ssh_key() {
  BNU_QEMU_SSH_KEY=${BNU_QEMU_SSH_KEY:-$BNU_QEMU_DIR/id_ed25519}
  if [[ ! -s $BNU_QEMU_SSH_KEY ]]; then
    run ssh-keygen -q -t ed25519 -N '' -f "$BNU_QEMU_SSH_KEY"
  fi
  export BNU_QEMU_SSH_KEY
}

create_seed_iso() {
  local output=$1 seed_dir
  [[ -s $output ]] && return
  ensure_ssh_key
  seed_dir=$(mktemp -d "${TMPDIR:-/tmp}/bnu-seed.XXXXXX")
  trap 'rm -rf -- "$seed_dir"' RETURN
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then
    cat >"$seed_dir/meta-data" <<EOF
instance-id: bnu-gentoo
local-hostname: bnu-gentoo
EOF
    cat >"$seed_dir/user-data" <<EOF
#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: root
    lock_passwd: true
    shell: /bin/bash
    ssh_authorized_keys:
      - $(<"$BNU_QEMU_SSH_KEY.pub")
runcmd:
  - [ sh, -c, 'touch /var/lib/bnu-cloud-ready' ]
EOF
  fi
  if command -v xorriso >/dev/null 2>&1; then
    run xorriso -as mkisofs -quiet -output "$output" -volid cidata -joliet -rock \
      "$seed_dir/user-data" "$seed_dir/meta-data"
  elif command -v genisoimage >/dev/null 2>&1; then
    run genisoimage -quiet -output "$output" -volid cidata -joliet -rock \
      "$seed_dir/user-data" "$seed_dir/meta-data"
  else
    die "missing xorriso or genisoimage (needed for the NoCloud seed)"
  fi
  trap - RETURN
  rm -rf -- "$seed_dir"
}

ssh_options() {
  printf '%s\0' -i "$BNU_QEMU_SSH_KEY" -p "$BNU_QEMU_SSH_PORT" \
    -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
}

guest_ssh() {
  local -a options=()
  while IFS= read -r -d '' item; do options+=("$item"); done < <(ssh_options)
  ssh "${options[@]}" root@127.0.0.1 "$@"
}

guest_scp() {
  local -a options=()
  while IFS= read -r -d '' item; do options+=("$item"); done < <(ssh_options)
  scp "${options[@]/-p/-P}" "$@"
}

wait_for_ssh() {
  local deadline=$((SECONDS + BNU_QEMU_TIMEOUT))
  while (( SECONDS < deadline )); do
    if guest_ssh 'test -e /var/lib/bnu-cloud-ready || test -e /var/lib/bnu-provisioned' >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  die "guest SSH did not become ready within ${BNU_QEMU_TIMEOUT}s"
}

start_vm() {
  local image=$1 name=$2 payload=${3:-} seed=${4:-} extra_disk=${5:-}
  local run_dir=$BNU_QEMU_DIR/run/$name vars pidfile serial
  require_kvm
  require_command qemu-system-x86_64
  require_command qemu-img
  ensure_ssh_key
  run mkdir -p -- "$run_dir"
  vars=$run_dir/OVMF_VARS.fd
  pidfile=$run_dir/qemu.pid
  serial=$run_dir/serial.log
  if [[ $BNU_QEMU_DRY_RUN != 1 && -s $pidfile ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; then
    die "VM $name is already running (pid $(<"$pidfile"))"
  fi
  run cp -- "$(ovmf_vars)" "$vars"
  local -a drives=(
    -drive "if=pflash,format=raw,readonly=on,file=$(ovmf_code)"
    -drive "if=pflash,format=raw,file=$vars"
    -drive "if=virtio,format=qcow2,file=$image,cache=writeback,discard=unmap"
  )
  [[ -n $payload ]] && drives+=( -drive "if=virtio,format=raw,readonly=on,file=$payload" )
  [[ -n $extra_disk ]] && drives+=( -drive "if=virtio,format=qcow2,file=$extra_disk,cache=writeback,discard=unmap" )
  [[ -n $seed ]] && drives+=( -drive "media=cdrom,format=raw,readonly=on,file=$seed" )
  run qemu-system-x86_64 \
    -name "$name" -machine q35,accel=kvm -cpu host -smp "$BNU_QEMU_CPUS" -m "$BNU_QEMU_MEMORY" \
    "${drives[@]}" -device virtio-net-pci,netdev=net0 \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${BNU_QEMU_SSH_PORT}-:22" \
    -display none -serial "file:$serial" -monitor none -daemonize -pidfile "$pidfile"
  [[ $BNU_QEMU_DRY_RUN == 1 ]] || wait_for_ssh
}

stop_vm() {
  local name=$1 pidfile=$BNU_QEMU_DIR/run/$name/qemu.pid deadline
  [[ -s $pidfile ]] || return
  guest_ssh 'sync; systemctl poweroff || poweroff' >/dev/null 2>&1 || true
  deadline=$((SECONDS + 60))
  while kill -0 "$(<"$pidfile")" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
  if kill -0 "$(<"$pidfile")" 2>/dev/null; then
    note "guest did not stop cleanly; terminating only QEMU pid $(<"$pidfile")"
    kill -TERM "$(<"$pidfile")" 2>/dev/null || true
  fi
}
