#!/usr/bin/env bash
# Download and authenticate the official Gentoo images used by the matrix.

set -Eeuo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/qemu/download-images.sh [--dry-run] [--only NAME]

NAME is cloud, selinux, hurd, or all (the default). Files are cached beneath
BNU_QEMU_DIR, which defaults to /var/tmp/bnu-qemu.
EOF
}

only=all
while (($#)); do
  case $1 in
    --dry-run) BNU_QEMU_DRY_RUN=1 ;;
    --only) [[ $# -ge 2 ]] || die "--only needs a value"; only=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ $only =~ ^(all|cloud|selinux|hurd)$ ]] || die "--only must be cloud, selinux, hurd, or all"

for command in curl gpg qemu-img; do require_command "$command"; done
ensure_state_dir
gnupg=$BNU_QEMU_DIR/gnupg
prepare_gnupg "$gnupg"

signed_manifest_path() {
  local url=$1 pattern=$2 name=$3 path
  local manifest=$BNU_QEMU_DIR/$name
  local plain=$BNU_QEMU_DIR/$name.plain
  download "$url" "$manifest"
  if [[ $BNU_QEMU_DRY_RUN == 1 ]]; then
    printf 'DRY-RUN/%s\n' "$pattern"
    return
  fi
  gpg --batch --homedir "$gnupg" --output "$plain.tmp" --decrypt "$manifest"
  mv -- "$plain.tmp" "$plain"
  path=$(awk -v pattern="$pattern" '$1 !~ /^#/ && $1 ~ pattern { print $1; exit }' "$plain")
  [[ -n $path ]] || die "no $pattern artifact found in $url"
  printf '%s\n' "$path"
}

fetch_signed_artifact() {
  local url=$1 output=$2
  download "$url" "$output"
  download "$url.asc" "$output.asc"
  verify_detached "$gnupg" "$output.asc" "$output"
}

autobuilds=https://distfiles.gentoo.org/releases/amd64/autobuilds
if [[ $only == all || $only == cloud ]]; then
  run mkdir -p -- "$BNU_QEMU_DIR/cloud"
  cloud_path=$(signed_manifest_path "$autobuilds/latest-qcow2.txt" 'di-amd64-cloudinit-.*\.qcow2$' latest-qcow2.txt)
  cloud_output=$BNU_QEMU_DIR/cloud/gentoo-cloudinit-amd64.qcow2
  fetch_signed_artifact "$autobuilds/$cloud_path" "$cloud_output"
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then printf '%s\n' "$cloud_path" >"$cloud_output.source"; fi
fi

if [[ $only == all || $only == selinux ]]; then
  run mkdir -p -- "$BNU_QEMU_DIR/selinux"
  selinux_path=$(signed_manifest_path \
    "$autobuilds/latest-stage3-amd64-hardened-selinux-systemd.txt" \
    'stage3-amd64-hardened-selinux-systemd-.*\.tar\.xz$' \
    latest-stage3-amd64-hardened-selinux-systemd.txt)
  selinux_output=$BNU_QEMU_DIR/selinux/stage3-amd64-hardened-selinux-systemd.tar.xz
  fetch_signed_artifact "$autobuilds/$selinux_path" "$selinux_output"
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then printf '%s\n' "$selinux_path" >"$selinux_output.source"; fi
fi

if [[ $only == all || $only == hurd ]]; then
  run mkdir -p -- "$BNU_QEMU_DIR/hurd-gentoo-amd64"
  hurd_base=https://distfiles.gentoo.org/experimental/amd64/hurd/hurd-x86_64-preview.qcow2
  hurd_image=$BNU_QEMU_DIR/hurd-gentoo-amd64/hurd-x86_64-preview.qcow2
  download "$hurd_base" "$hurd_image"
  download "$hurd_base.sig" "$hurd_image.sig"
  download "$hurd_base.sha512" "$hurd_image.sha512"
  # The experimental Hurd preview is signed by its Gentoo developer rather
  # than the automated release key. Fetch its key block over HTTPS from
  # Gentoo's own keyserver and assert the exact signing-subkey fingerprint.
  hurd_signer=FD19E6D31B192EE4DC63EAD3DC2B16215ED5412A
  if [[ $BNU_QEMU_DRY_RUN == 1 ]] || ! gpg --batch --homedir "$gnupg" --list-keys "$hurd_signer" >/dev/null 2>&1; then
    hurd_key=$BNU_QEMU_DIR/hurd-gentoo-amd64/signer-$hurd_signer.asc
    download "https://keys.gentoo.org/pks/lookup?op=get&search=0x$hurd_signer" "$hurd_key"
    run gpg --batch --homedir "$gnupg" --import "$hurd_key"
  fi
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then
    gpg --batch --homedir "$gnupg" --with-colons --fingerprint "$hurd_signer" |
      awk -F: '$1 == "fpr" {print $10}' | grep -Fxq "$hurd_signer" ||
      die "Gentoo Hurd signing-key fingerprint did not match $hurd_signer"
  fi
  verify_detached "$gnupg" "$hurd_image.sig" "$hurd_image"
  if [[ $BNU_QEMU_DRY_RUN != 1 ]]; then
    (cd -- "$(dirname -- "$hurd_image")" && sha512sum --check "$(basename -- "$hurd_image.sha512")")
  else
    note "would verify the Hurd SHA-512 manifest"
  fi
  create_overlay "$hurd_image" "$BNU_QEMU_DIR/hurd-gentoo-amd64/bnu-matrix-overlay.qcow2"
fi

note "verified Gentoo artifacts are in $BNU_QEMU_DIR"
