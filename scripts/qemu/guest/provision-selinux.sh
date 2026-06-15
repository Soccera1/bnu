#!/usr/bin/env bash
# Run in the standard Gentoo builder. Payload=/dev/vdb, target=/dev/vdc.
set -Eeuo pipefail

target=/mnt/bnu-target
payload=/mnt/bnu-payload
mkdir -p "$target" "$payload"
mount -o ro /dev/vdb "$payload"
stage=$payload/bnu/artifacts/stage3-amd64-hardened-selinux-systemd.tar.xz
[[ -r $stage ]] || { echo "SELinux stage3 is absent from payload" >&2; exit 2; }

wipefs -a /dev/vdc
parted -s /dev/vdc mklabel gpt
parted -s /dev/vdc mkpart ESP fat32 1MiB 513MiB
parted -s /dev/vdc set 1 esp on
parted -s /dev/vdc mkpart gentoo xfs 513MiB 100%
udevadm settle
mkfs.vfat -F 32 -n EFI /dev/vdc1
mkfs.xfs -f -L gentoo /dev/vdc2
mount /dev/vdc2 "$target"
mkdir -p "$target/boot/efi"
mount /dev/vdc1 "$target/boot/efi"
tar --numeric-owner --acls --xattrs --xattrs-include='*' --selinux -xpf "$stage" -C "$target"

root_uuid=$(blkid -s UUID -o value /dev/vdc2)
efi_uuid=$(blkid -s UUID -o value /dev/vdc1)
cat >"$target/etc/fstab" <<EOF
UUID=$root_uuid / xfs defaults 0 1
UUID=$efi_uuid /boot/efi vfat umask=0077 0 2
/swapfile none swap sw 0 0
EOF
cp -L /etc/resolv.conf "$target/etc/resolv.conf"
cat >>"$target/etc/portage/make.conf" <<'EOF'
MAKEOPTS="-j1"
EMERGE_DEFAULT_OPTS="--jobs=1 --load-average=2 --nospinner"
SELINUX_POLICY_TYPES="mcs mls strict"
EOF
mkdir -p "$target/etc/portage/package.use"
cat >"$target/etc/portage/package.use/bnu-selinux" <<'EOF'
sys-apps/systemd selinux
sys-apps/coreutils acl caps xattr
sys-process/procps selinux
EOF
cat >"$target/etc/selinux/config" <<'EOF'
SELINUX=permissive
SELINUXTYPE=mls
EOF
mkdir -p "$target/etc/systemd/network" "$target/root/.ssh"
cat >"$target/etc/systemd/network/20-wired.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=yes
EOF
install -m 600 /dev/null "$target/root/.ssh/authorized_keys"
cat /root/.ssh/authorized_keys >"$target/root/.ssh/authorized_keys"
chmod 700 "$target/root/.ssh"

for fs in dev proc sys run; do mount --rbind "/$fs" "$target/$fs"; mount --make-rslave "$target/$fs"; done
chroot "$target" /usr/bin/env MAKEOPTS=-j1 EMERGE_DEFAULT_OPTS='--jobs=1 --load-average=2 --nospinner' \
  emerge --ask=n --verbose=n net-misc/openssh net-misc/dhcpcd sec-policy/selinux-base \
  sec-policy/selinux-base-policy sys-apps/policycoreutils sys-boot/grub:2 \
  sys-fs/dosfstools sys-fs/xfsprogs sys-kernel/gentoo-kernel-bin

cat >"$target/etc/default/grub" <<'EOF'
GRUB_CMDLINE_LINUX="console=ttyS0 lsm=selinux security=selinux selinux=1 enforcing=0"
GRUB_TERMINAL="serial console"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"
EOF
chroot "$target" systemctl enable sshd systemd-networkd systemd-resolved
chroot "$target" grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=Gentoo --removable --no-nvram
chroot "$target" grub-mkconfig -o /boot/grub/grub.cfg
chroot "$target" semodule -B || true
fallocate -l 2G "$target/swapfile"
chmod 600 "$target/swapfile"
mkswap "$target/swapfile"
touch "$target/.autorelabel" "$target/var/lib/bnu-provisioned" "$target/var/lib/bnu-selinux-mls"
sync
