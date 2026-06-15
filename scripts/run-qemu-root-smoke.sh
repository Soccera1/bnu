#!/bin/sh
# Boot bnu in a root initramfs guest and exercise privileged file operations.
# Set BNU_QEMU_KERNEL and BNU_QEMU_INITRAMFS to select a matching host kernel
# and initramfs.  BUN may override the Bun executable.
set -eu

: "${BNU_QEMU_KERNEL:?set BNU_QEMU_KERNEL to a kernel image}"
: "${BNU_QEMU_INITRAMFS:?set BNU_QEMU_INITRAMFS to a zstd initramfs image}"

root=$(mktemp -d "${TMPDIR:-/tmp}/bnu-qemu-root.XXXXXX")
initrd=$(mktemp "${TMPDIR:-/tmp}/bnu-qemu-initramfs.XXXXXX.img")
serial=$(mktemp "${TMPDIR:-/tmp}/bnu-qemu-serial.XXXXXX.log")
cleanup() { rm -rf "$root" "$initrd" "$serial"; }
trap cleanup EXIT HUP INT TERM

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bun_command=${BUN:-bun}
case "$bun_command" in
  */*) ;;
  *) bun_command=$(command -v "$bun_command") ;;
esac
bun=$(readlink -f "$bun_command")
qemu_memory=${BNU_QEMU_MEMORY:-1536M}

mkdir -p "$root"
if command -v lsinitrd >/dev/null 2>&1; then
  if ! (cd "$root" && lsinitrd --unpack "$BNU_QEMU_INITRAMFS" >/dev/null 2>&1); then
    test -e "$root/bin/sh" || { echo "failed to unpack initramfs: $BNU_QEMU_INITRAMFS" >&2; exit 2; }
  fi
else
  case $(file -b "$BNU_QEMU_INITRAMFS") in
    *Zstandard*) decompressor='zstd -dc' ;;
    *gzip*) decompressor='gzip -dc' ;;
    *XZ*) decompressor='xz -dc' ;;
    *LZ4*) decompressor='lz4 -dc' ;;
    *cpio*) decompressor=cat ;;
    *) echo "unsupported initramfs compression: $BNU_QEMU_INITRAMFS" >&2; exit 2 ;;
  esac
  if ! (cd "$root" && $decompressor "$BNU_QEMU_INITRAMFS" | cpio -idmu 2>/dev/null); then
    test -e "$root/bin/sh" || { echo "failed to unpack initramfs: $BNU_QEMU_INITRAMFS" >&2; exit 2; }
  fi
fi
mkdir -p "$root/opt/bnu/bin" "$root/opt/bnu/src" "$root/usr/bin"
cp "$bun" "$root/usr/bin/bun"
cp "$repo/bin/bnu.js" "$root/opt/bnu/bin/bnu.js"
cp "$repo/src/coreutils.js" "$root/opt/bnu/src/coreutils.js"

ldd "$bun" | awk '/=> \/[^ ]+/ { print $3 } /^\// { print $1 }' | while IFS= read -r library; do
  test -n "$library" || continue
  mkdir -p "$root$(dirname "$library")"
  cp -L "$library" "$root$library"
done

cat >"$root/bnu-qemu-test.sh" <<'EOF'
#!/bin/sh
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
set -eu
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

echo 'BNU-QEMU: guest-ready'
sed -n 's/^Uid:.*/BNU-QEMU: &/p' /proc/self/status
mkdir -p /tmp/bnu-qemu-test/src /tmp/bnu-qemu-test/dst
printf 'root-owned\n' >/tmp/bnu-qemu-test/src/file
/usr/bin/bun /opt/bnu/bin/bnu.js chmod 4755 /tmp/bnu-qemu-test/src/file
stat -c 'BNU-QEMU: source-mode=%a uid=%u gid=%g' /tmp/bnu-qemu-test/src/file
/usr/bin/bun /opt/bnu/bin/bnu.js cp -p /tmp/bnu-qemu-test/src/file /tmp/bnu-qemu-test/dst/file
stat -c 'BNU-QEMU: copied-mode=%a uid=%u gid=%g' /tmp/bnu-qemu-test/dst/file
test "$(stat -c %a /tmp/bnu-qemu-test/dst/file)" = 4755
/usr/bin/bun /opt/bnu/bin/bnu.js touch /tmp/bnu-qemu-test/src/special-bits
/usr/bin/bun /opt/bnu/bin/bnu.js chmod 6751 /tmp/bnu-qemu-test/src/special-bits
/usr/bin/bun /opt/bnu/bin/bnu.js cp -p /tmp/bnu-qemu-test/src/special-bits /tmp/bnu-qemu-test/dst/special-bits
test "$(stat -c %a /tmp/bnu-qemu-test/src/special-bits)" = "$(stat -c %a /tmp/bnu-qemu-test/dst/special-bits)"
echo 'BNU-QEMU: special-bits-copy-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js mkfifo /tmp/bnu-qemu-test/pipe
test -p /tmp/bnu-qemu-test/pipe && echo 'BNU-QEMU: fifo-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js mknod /tmp/bnu-qemu-test/null c 1 3
test -c /tmp/bnu-qemu-test/null && echo 'BNU-QEMU: char-device-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chown 123:456 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %u /tmp/bnu-qemu-test/dst/file)" = 123
test "$(stat -c %g /tmp/bnu-qemu-test/dst/file)" = 456
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp 0 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %g /tmp/bnu-qemu-test/dst/file)" = 0
/usr/bin/bun /opt/bnu/bin/bnu.js mkdir -p /tmp/bnu-qemu-test/dst/tree/nested
printf 'nested\n' >/tmp/bnu-qemu-test/dst/tree/nested/file
ln -s nested/file /tmp/bnu-qemu-test/dst/tree/link
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp -R 456 /tmp/bnu-qemu-test/dst/tree
test "$(stat -c %g /tmp/bnu-qemu-test/dst/tree)" = 456
test "$(stat -c %g /tmp/bnu-qemu-test/dst/tree/nested/file)" = 456
echo 'BNU-QEMU: recursive-chgrp-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp -h 123 /tmp/bnu-qemu-test/dst/tree/link
test "$(stat -c %g /tmp/bnu-qemu-test/dst/tree/link)" = 123
echo 'BNU-QEMU: symlink-chgrp-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chown --from=123:0 456:789 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %u /tmp/bnu-qemu-test/dst/file)" = 456
test "$(stat -c %g /tmp/bnu-qemu-test/dst/file)" = 789
echo 'BNU-QEMU: conditional-chown-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp --from=789 0 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %g /tmp/bnu-qemu-test/dst/file)" = 0
echo 'BNU-QEMU: conditional-chgrp-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chown 0:1 /tmp/bnu-qemu-test/dst/file
/usr/bin/bun /opt/bnu/bin/bnu.js chown -v --from=42 43 /tmp/bnu-qemu-test/dst/file >/tmp/bnu-qemu-test/chown-verbose.out
IFS= read -r chown_verbose < /tmp/bnu-qemu-test/chown-verbose.out
test "$chown_verbose" = "ownership of '/tmp/bnu-qemu-test/dst/file' retained as root"
echo 'BNU-QEMU: conditional-chown-verbose-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chown 0:1 /tmp/bnu-qemu-test/dst/file
/usr/bin/bun /opt/bnu/bin/bnu.js chown --from=0:1 2:010 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %u:%g /tmp/bnu-qemu-test/dst/file)" = 2:10
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp 1 /tmp/bnu-qemu-test/dst/file
/usr/bin/bun /opt/bnu/bin/bnu.js chgrp --from=:1 010 /tmp/bnu-qemu-test/dst/file
test "$(stat -c %g /tmp/bnu-qemu-test/dst/file)" = 10
echo 'BNU-QEMU: upstream-from-syntax-ok'
/usr/bin/bun /opt/bnu/bin/bnu.js chown -h 321:654 /tmp/bnu-qemu-test/dst/tree/link
test "$(stat -c %u /tmp/bnu-qemu-test/dst/tree/link)" = 321
test "$(stat -c %g /tmp/bnu-qemu-test/dst/tree/link)" = 654
echo 'BNU-QEMU: symlink-chown-ok'
date_before=$(/usr/bin/bun /opt/bnu/bin/bnu.js date -u +%s)
date_target=$((date_before + 2))
date_set=$(/usr/bin/bun /opt/bnu/bin/bnu.js date -u --set "@$date_target" +%s)
date_observed=$(/usr/bin/bun /opt/bnu/bin/bnu.js date -u +%s)
test "$date_set" = "$date_target"
test "$date_observed" -ge "$date_target"
test "$date_observed" -le $((date_target + 1))
echo 'BNU-QEMU: clock-set-ok'
posix_target=$((date_observed + 2))
posix_operand=$(/usr/bin/bun /opt/bnu/bin/bnu.js date -u -d "@$posix_target" +%m%d%H%M%Y.%S)
/usr/bin/bun /opt/bnu/bin/bnu.js date -u "$posix_operand" >/dev/null
posix_observed=$(/usr/bin/bun /opt/bnu/bin/bnu.js date -u +%s)
test "$posix_observed" -ge "$posix_target"
test "$posix_observed" -le $((posix_target + 1))
echo 'BNU-QEMU: positional-clock-set-ok'
echo 'BNU-QEMU: ownership-ok'
echo 'BNU-QEMU: completed'
poweroff -f
EOF
chmod 755 "$root/bnu-qemu-test.sh"

(cd "$root" && find . -print0 | cpio --null -o -H newc | zstd -T1 -3 -f -o "$initrd")
test -r /dev/kvm && test -w /dev/kvm || {
  echo '/dev/kvm is not accessible; the QEMU tests do not fall back to software emulation' >&2
  exit 2
}
set -- -enable-kvm -cpu host
qemu_status=0
timeout 60s qemu-system-x86_64 "$@" -m "$qemu_memory" -display none -serial "file:$serial" -no-reboot \
  -kernel "$BNU_QEMU_KERNEL" -initrd "$initrd" -append 'console=ttyS0 rdinit=/bnu-qemu-test.sh' || qemu_status=$?
if ! rg -q '^BNU-QEMU: completed\r?$' "$serial"; then
  echo "QEMU exited with status $qemu_status before the smoke test completed" >&2
  rg 'BNU-QEMU|bnu:|chown:|chgrp:|Kernel panic|not found|error while loading|failed' "$serial" >&2 || :
  exit 1
fi
rg 'BNU-QEMU' "$serial"
