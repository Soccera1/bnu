export const commandNames = Object.freeze([
  "[", "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "coreutils",
  "cp", "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname", "du",
  "echo", "env", "expand", "expr", "factor", "false", "fmt", "fold", "ginstall",
  "groups", "head", "hostid", "hostname", "id", "install", "join", "kill", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp", "mv",
  "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste", "pathchk", "pinky",
  "pr", "printenv", "printf", "ptx", "pwd", "readlink", "realpath", "rm", "rmdir",
  "runcon", "seq", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "shred", "shuf", "sleep", "sm3sum", "sort", "split", "stat", "stdbuf", "stty",
  "sum", "sync", "tac", "tail", "tee", "test", "timeout", "touch", "tr", "true",
  "truncate", "tsort", "tty", "uname", "unexpand", "uniq", "unlink", "uptime",
  "users", "vdir", "wc", "who", "whoami", "yes",
]);

const commandSet = new Set(commandNames);

export function hasCommand(name) {
  return commandSet.has(name);
}

export async function loadCommand(name) {
  if (!hasCommand(name)) return null;
  const path = new URL(`../commands/${encodeURIComponent(name)}.js`, import.meta.url);
  return (await import(path.href)).default;
}
