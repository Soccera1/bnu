#!/usr/bin/env bun

import { parseOptions } from "../shared/common.js";
import { UsageError, VERSION, stderr, stdout } from "../shared/diagnostics.js";
import { referenceStat } from "../shared/filesystem.js";
import { showGenericHelp } from "../shared/help.js";
import { chownErrorLine, chownFailureVerboseLine, chownMetaOption, chownOwnershipDisplay, chownPath, normalizeChownArgs, parseChownSpec, resolveChownOwnerGroupSpec } from "../shared/ownership.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function chownCmd(args) {
  const { opts, operands } = parseOptions(normalizeChownArgs(args), { short: { R: false, c: false, f: false, h: false, H: false, L: false, P: false, v: false }, long: { changes: false, recursive: false, silent: false, quiet: false, dereference: false, "no-dereference": false, from: "value", reference: "value", "preserve-root": false, "no-preserve-root": false, verbose: false, help: false, version: false } });
  const from = opts.from == null ? null : await resolveChownOwnerGroupSpec(opts.from);
  if (opts.help) {
    showGenericHelp("chown");
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
  let uid;
  let gid;
  if (opts.reference != null) {
    const ref = await referenceStat(opts.reference);
    uid = ref.uid;
    gid = ref.gid;
  } else {
    ({ uid, gid } = await resolveChownOwnerGroupSpec(operands[0], { warnDot: true }));
  }
  const ownershipSpec = opts.reference != null ? await chownOwnershipDisplay(uid, gid, { reportUid: true, reportGid: true }) : operands[0];
  const parsedOwnershipSpec = opts.reference == null ? parseChownSpec(operands[0]) : null;
  const failureKind = uid == null && gid != null ? "group" : "ownership";
  const failureSpec = uid == null && gid == null ? null : failureKind === "group" && parsedOwnershipSpec ? parsedOwnershipSpec.groupPart : ownershipSpec;
  const fromUid = from?.uid ?? null;
  const fromGid = from?.gid ?? null;
  let failed = false;
  const dereference = !(opts.h || opts["no-dereference"]) || opts.dereference;
  const traversal = opts.L ? "L" : opts.H ? "H" : "P";
  const preserveRoot = !!opts["preserve-root"] && !opts["no-preserve-root"];
  const changes = opts.c || opts.changes;
  const verbose = opts.v || opts.verbose;
  for (const file of files) {
    try {
      const ok = await chownPath(file, uid, gid, opts.R || opts.recursive, { dereference, traversal, preserveRoot, command: "chown", fromUid, fromGid, changes, verbose, silent: opts.f || opts.silent || opts.quiet, reportUid: uid != null, reportGid: gid != null, failureKind, failureSpec }, true, file);
      if (!ok) failed = true;
    } catch (error) {
      failed = true;
      if (verbose) stdout(chownFailureVerboseLine(file, { failureKind, failureSpec }));
      if (!(opts.f || opts.silent || opts.quiet)) stderr(chownErrorLine(file, error));
    }
  }
  return failed ? 1 : 0;
}

const singleCall = defineCommand("chown", chownCmd, chownMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
