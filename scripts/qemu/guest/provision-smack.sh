#!/usr/bin/env bash
# Run inside an overlay of the completed SELinux guest.
set -Eeuo pipefail

export MAKEOPTS=-j1
export EMERGE_DEFAULT_OPTS='--jobs=1 --load-average=2 --nospinner'
swapon /swapfile 2>/dev/null || true
emerge --ask=n --verbose=n sys-apps/kmod sys-kernel/dracut sys-kernel/gentoo-sources
eselect kernel set "$(eselect kernel list | awk '/gentoo/ {gsub(/\[|\]/, "", $1); n=$1} END {print n}')"
kernel=/usr/src/linux
cd "$kernel"
if [[ -r /proc/config.gz ]]; then
  zcat /proc/config.gz >.config
else
  cp "/boot/config-$(uname -r)" .config
fi
scripts/config --enable SECURITY --enable SECURITYFS --enable SECURITY_SMACK
scripts/config --disable DEBUG_INFO_BTF --disable DEBUG_INFO_BTF_MODULES
scripts/config --enable VIRTIO --enable VIRTIO_PCI --enable VIRTIO_BLK --enable VIRTIO_NET
scripts/config --enable EXT4_FS --enable XFS_FS --enable VFAT_FS --enable ISO9660_FS
scripts/config --set-str LOCALVERSION '-smack-bnu'
make olddefconfig
make -j1
make -j1 modules_install
version=$(make -s kernelrelease)
cp arch/x86/boot/bzImage "/boot/vmlinuz-$version"
cp .config "/boot/config-$version"
cp System.map "/boot/System.map-$version"
dracut --force "/boot/initramfs-$version.img" "$version"
sed -i 's/lsm=selinux/security=smack lsm=smack/; s/security=selinux//; s/selinux=1//; s/enforcing=0//' /etc/default/grub
grub-mkconfig -o /boot/grub/grub.cfg
touch /var/lib/bnu-smack
sync
