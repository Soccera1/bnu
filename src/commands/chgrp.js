#!/usr/bin/env bun

import { groupName, parseOptions } from "../shared/common.js";
import { UsageError, VERSION, stderr, stdout } from "../shared/diagnostics.js";
import { referenceStat, resolveGroup } from "../shared/filesystem.js";
import { showGenericHelp } from "../shared/help.js";
import { chgrpErrorLine, chownFailureVerboseLine, chownMetaOption, chownPath, normalizeChownArgs, resolveChownOwnerGroupSpec } from "../shared/ownership.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function chgrpCmd(args) {
  const { opts, operands } = parseOptions(normalizeChownArgs(args), { short: { R: false, c: false, f: false, h: false, H: false, L: false, P: false, v: false }, long: { changes: false, recursive: false, silent: false, quiet: false, dereference: false, "no-dereference": false, from: "value", reference: "value", "preserve-root": false, "no-preserve-root": false, verbose: false, help: false, version: false } });
  let fromUid = null;
  let fromGid = null;
  if (opts.from != null) {
    // A bare --from value uses the same user-like parser as chown (and its
    // diagnostics), but denotes that numeric ID as the current group.  With
    // OWNER:GROUP syntax, GNU uses the group portion.
    const from = await resolveChownOwnerGroupSpec(opts.from, { warnDot: true, warningCommand: "chgrp" });
    fromGid = from.gid ?? from.uid;
  }
  if (opts.help) {
    showGenericHelp("chgrp");
    return 0;
  }
  if (opts.version) {
    stdout(`${VERSION}\n`);
    return 0;
  }
  if (opts.reference != null && operands.length < 1) throw new UsageError("missing operand", true);
  if (opts.reference == null && operands.length < 1) throw new UsageError("missing operand", true);
  if (opts.reference == null && operands.length < 2) throw new UsageError(`missing operand after '${operands[0]}'`, true);
  const files = opts.reference != null ? operands : operands.slice(1);
  const gid = opts.reference != null ? (await referenceStat(opts.reference)).gid : await resolveGroup(operands[0]);
  let failed = false;
  const dereference = !(opts.h || opts["no-dereference"]) || opts.dereference;
  const traversal = opts.L ? "L" : opts.H ? "H" : "P";
  const preserveRoot = !!opts["preserve-root"] && !opts["no-preserve-root"];
  const changes = opts.c || opts.changes;
  const verbose = opts.v || opts.verbose;
  const failureSpec = opts.reference != null ? await groupName(gid) : operands[0];
  for (const file of files) {
    try {
      const ok = await chownPath(file, null, gid, opts.R || opts.recursive, { dereference, traversal, preserveRoot, command: "chgrp", fromUid, fromGid, changes, verbose, silent: opts.f || opts.silent || opts.quiet, reportUid: false, reportGid: gid != null, failureKind: "group", failureSpec }, true, file);
      if (!ok) failed = true;
    } catch (error) {
      failed = true;
      if (verbose) stdout(chownFailureVerboseLine(file, { failureKind: "group", failureSpec }));
      if (!(opts.f || opts.silent || opts.quiet)) stderr(chgrpErrorLine(file, error));
    }
  }
  return failed ? 1 : 0;
}

const singleCall = defineCommand("chgrp", chgrpCmd, chownMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
