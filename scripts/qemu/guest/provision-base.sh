#!/usr/bin/env bash
set -Eeuo pipefail

export MAKEOPTS=-j1
export EMERGE_DEFAULT_OPTS='--jobs=1 --load-average=2 --nospinner'
mkdir -p /etc/portage/package.use /etc/portage/package.accept_keywords
grep -q '^MAKEOPTS=' /etc/portage/make.conf 2>/dev/null || printf '\nMAKEOPTS="-j1"\n' >>/etc/portage/make.conf
grep -q '^EMERGE_DEFAULT_OPTS=' /etc/portage/make.conf 2>/dev/null ||
  printf 'EMERGE_DEFAULT_OPTS="--jobs=1 --load-average=2 --nospinner"\n' >>/etc/portage/make.conf

if [[ ${BNU_REFRESH_PORTAGE:-0} == 1 ]]; then emerge --sync; fi
emerge --ask=n --verbose=n \
  app-arch/xz-utils app-shells/bash dev-lang/perl dev-lang/python \
  net-misc/openssh sys-apps/acl sys-apps/attr sys-apps/coreutils \
  sys-apps/util-linux sys-block/parted sys-devel/binutils sys-devel/gcc \
  sys-devel/make sys-fs/dosfstools sys-fs/e2fsprogs sys-fs/xfsprogs \
  sys-libs/libcap sys-process/procps sys-process/psmisc

if [[ ! -e /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi
swapon /swapfile 2>/dev/null || true
systemctl enable sshd 2>/dev/null || rc-update add sshd default 2>/dev/null || true
touch /var/lib/bnu-provisioned
