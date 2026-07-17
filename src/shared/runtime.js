import { commandNames, loadCommand } from "./catalog.js";
import { InvocationError, UsageError, VERSION, commandUsageHint, emittedDiagnosticHints, fail, gnulyCorrectDiagnostics, stderr, stdout } from "./diagnostics.js";
import { showGenericHelp } from "./help.js";

export const USAGE_STATUS_2 = new Set(["dir", "ls", "printenv", "sort", "tty", "vdir"]);

export const OUTPUT_ERROR_STATUS = new Map([
  ["[", 2],
  ["chroot", 125],
  ["dir", 2],
  ["env", 125],
  ["expr", 3],
  ["ls", 2],
  ["nice", 125],
  ["nohup", 125],
  ["printenv", 2],
  ["runcon", 125],
  ["sort", 2],
  ["stdbuf", 125],
  ["timeout", 125],
  ["tty", 3],
  ["vdir", 2],
]);

export async function main(argv) {
  emittedDiagnosticHints.clear();
  const [program, ...args] = argv;
  if (!program || program === "--help") {
    stdout(`Usage: bnu COMMAND [ARG]...\nImplemented commands: ${commandNames.join(", ")}\n`);
    return 0;
  }
  if (program === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  const command = await loadCommand(program);
  if (!command) return fail("bnu", `unknown command '${program}'`);
  return command(args);
}

export async function executeCommand(program, command, metaOptionForCommand, args) {
  emittedDiagnosticHints.clear();
  try {
    const metaOption = metaOptionForCommand?.(args) ?? null;
    if (metaOption === "--help") {
      showGenericHelp(program);
      return 0;
    }
    if (metaOption === "--version") {
      stdout(`${VERSION}\n`);
      return 0;
    }
    return await command(args);
  } catch (error) {
    if (error instanceof InvocationError) {
      if (error.message) stderr(`${program}: ${error.message}\n`, true);
      else if (!gnulyCorrectDiagnostics()) stderr(`Hint: ${commandUsageHint(program, "Add the required command or argument")}\n`);
      if (error.showHelp) stderr(`Try '${program} --help' for more information.\n`);
      return error.code;
    }
    if (error instanceof UsageError) {
      stderr(`${program}: ${error.message}\n`, true);
      if (error.showHelp) stderr(`Try '${program} --help' for more information.\n`);
      return USAGE_STATUS_2.has(program) ? 2 : 1;
    }
    if (isOutputWriteError(error)) {
      const status = OUTPUT_ERROR_STATUS.get(program) ?? (USAGE_STATUS_2.has(program) ? 2 : 1);
      return fail(program, `write error: ${outputWriteErrorMessage(error)}`, status);
    }
    return fail(program, error.message || String(error), USAGE_STATUS_2.has(program) ? 2 : 1);
  }
}

export function isOutputWriteError(error) {
  return error?.code === "ENOSPC" || error?.code === "EIO";
}

export function outputWriteErrorMessage(error) {
  if (error?.code === "EPIPE") return "Broken pipe";
  if (error?.code === "ENOSPC") return "No space left on device";
  if (error?.code === "EIO") return "Input/output error";
  return error?.message || String(error);
}
