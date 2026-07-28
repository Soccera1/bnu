import { commandNames } from "./catalog.js";
import { writeSync } from "node:fs";
import { COMMAND_HELP_OPTIONS } from "./help-options.js";
import { SPECIAL_HELP } from "./help.js";
import { isOutputWriteError } from "./runtime.js";

export const VERSION = "bnu 9.11";

export class UsageError extends Error {
  constructor(message, showHelp = false) {
    super(message);
    this.showHelp = showHelp;
  }
}

export class InvocationError extends UsageError {
  constructor(message, code = 125, showHelp = true) {
    super(message, showHelp);
    this.code = code;
  }
}

export const emittedDiagnosticHints = new Set();

export function stdout(data = "") {
  try {
    writeAllSync(1, data instanceof Uint8Array ? data : String(data));
  } catch (error) {
    if (error?.code === "EPIPE") process.exit(0);
    throw error;
  }
}

export function stderr(data = "", ensureHint = false) {
  const text = String(data);
  writeAllSync(2, gnulyCorrectDiagnostics() ? text : enhanceDiagnostic(text, ensureHint));
}

export function gnulyCorrectDiagnostics() {
  const value = process.env.GNULY_CORRECT;
  return value !== undefined && !/^(?:|0|false)$/i.test(value);
}

export function enhanceDiagnostic(text, ensureHint = false) {
  if (!text.endsWith("\n") || /^(?:Hint|Warning):/m.test(text)) return text;
  const firstLine = text.split("\n", 1)[0];
  if (!/^[^:\n]+:\s/.test(firstLine) || /:\s*(?:warning|debug):?\s/i.test(firstLine)) return text;
  const program = firstLine.slice(0, firstLine.indexOf(":"));
  const hint = diagnosticHint(program, text) ?? (ensureHint ? genericDiagnosticHint(program) : null);
  if (!hint || emittedDiagnosticHints.has(hint)) return text;
  emittedDiagnosticHints.add(hint);
  const tryLine = text.indexOf("\nTry '");
  if (tryLine !== -1) return `${text.slice(0, tryLine + 1)}Hint: ${hint}\n${text.slice(tryLine + 1)}`;
  return `${text}Hint: ${hint}\n`;
}

export function diagnosticHint(program, diagnostic) {
  if (program === "comm" && /^comm: -\n?$/.test(diagnostic)) {
    return "Use standard input for only one input file; the other operand must name a file.";
  }
  const unknownCommand = diagnostic.match(/unknown command ['‘]([^'’]+)['’]/)?.[1];
  if (unknownCommand) {
    const suggestion = closestValue(unknownCommand, commandNames);
    return suggestion
      ? `Did you mean '${suggestion}'? Run 'bnu --help' to list commands.`
      : "Run 'bnu --help' to list available commands.";
  }
  const longOption = diagnostic.match(/unrecognized option ['‘](--[^'’=]+)(?:=[^'’]*)?['’]/)?.[1];
  if (longOption) {
    const suggestion = closestLongOption(program, longOption);
    return suggestion
      ? `Did you mean '${suggestion}'? Run '${program} --help' to see all options.`
      : `Check the option spelling, or run '${program} --help' to see all options.`;
  }
  if (/invalid option -- |option .* is ambiguous/.test(diagnostic)) {
    return `Check the option spelling, or run '${program} --help' to see all options.`;
  }
  if (/option .*requires an argument|option requires an argument/.test(diagnostic)) {
    const option = diagnostic.match(/option ['‘](--[^'’]+)['’] requires/)?.[1]
      ?? diagnostic.match(/option requires an argument -- ['‘]([^'’]+)['’]/)?.[1];
    return option?.startsWith("--")
      ? `Provide the missing value as '${option}=VALUE' or '${option} VALUE'.`
      : option
        ? `Provide the missing value after '-${option}'.`
        : `Provide a value for the option. Run '${program} --help' for the expected form.`;
  }
  if (/doesn't allow an argument/.test(diagnostic)) {
    const option = diagnostic.match(/option ['‘](--[^'’]+)['’]/)?.[1];
    return option ? `Use '${option}' by itself; this flag does not take a value.` : "Remove the value supplied to this flag.";
  }
  if (/missing operand|missing file operand|a command must be given/.test(diagnostic)) {
    return commandUsageHint(program, "Add the required argument");
  }
  if (/extra operand|extra argument|too many arguments/.test(diagnostic)) {
    return commandUsageHint(program, "Remove the extra argument");
  }
  if (/mutually exclusive|cannot combine|may not be combined|are incompatible|conflicting .* specifiers|cannot specify .* more than one source/.test(diagnostic)) {
    return "Remove one of the conflicting options and try again.";
  }
  if (/ambiguous argument/.test(diagnostic)) {
    return `Use a complete, unambiguous value. Run '${program} --help' for accepted values.`;
  }
  if (/Valid arguments are:/.test(diagnostic)) {
    return "Choose one of the valid values listed above and try again.";
  }
  if (/multiple .* (?:specified|sources)|used more than once/.test(diagnostic)) {
    return "Keep only one value for this setting, or remove the duplicate option.";
  }
  if (/only one .* may be specified|cannot .* in more than one way/.test(diagnostic)) {
    return "Select one operating mode and remove the other mode options.";
  }
  if (/delimiter must be a single character|multi-character (?:tab|separator)|separator cannot be empty|empty (?:tab|record separator)/.test(diagnostic)) {
    return "Use exactly one character as the delimiter or separator.";
  }
  if (/numbered from 1|field number is zero|character offset is zero/.test(diagnostic)) {
    return "Use a position of 1 or greater; zero is not a valid field or character position.";
  }
  if (/invalid decreasing range|range-endpoints .* reverse|tab sizes must be ascending/.test(diagnostic)) {
    return "Put the lower position first and list ranges in ascending order.";
  }
  if (/invalid range with no endpoint|invalid .* range|invalid field specification/.test(diagnostic)) {
    return "Use a range such as 'N', 'N-M', 'N-', or '-M' with valid positive positions.";
  }
  if (/meaningless|meaningful only|only supported|does not support|only when|makes sense/.test(diagnostic)) {
    return "Remove the option that has no effect here, or enable the mode that option requires.";
  }
  if (/no lines to repeat/.test(diagnostic)) {
    return "Provide non-empty input, or remove --repeat.";
  }
  if (/missing (?:encoding type|mode)|must specify .* mode|must specify a list/.test(diagnostic)) {
    return commandUsageHint(program, "Select the required mode");
  }
  if (/template .* must end in X|too few X's in template|invalid (?:template|suffix).*directory separator/.test(diagnostic)) {
    return "Use a template ending in at least three X characters and keep any suffix free of '/'.";
  }
  if (/out of range|overflow|value too (?:large|small)/i.test(diagnostic)) {
    return "Choose a value within the supported range and try again.";
  }
  if (/invalid zero-length file name|empty file name/.test(diagnostic)) {
    return "Remove the empty path entry from the input list.";
  }
  if (/when reading file names from standard input, no file name of '-' allowed/.test(diagnostic)) {
    return "Remove '-' from the file-name list; standard input is already being used for that list.";
  }
  if (/No such file or directory|No such device or address/.test(diagnostic)) {
    return "Check that the path exists and is spelled correctly.";
  }
  if (/Permission denied|Operation not permitted/.test(diagnostic)) {
    return "Check the file permissions and whether this operation needs additional privileges.";
  }
  if (/Is a directory/.test(diagnostic)) {
    return "Use a file instead, or select an option that supports directories.";
  }
  if (/Not a directory/.test(diagnostic)) {
    return "Check that every parent component of the path is a directory.";
  }
  if (/Directory not empty/.test(diagnostic)) {
    return "Remove the directory contents first, or use the command's recursive option if appropriate.";
  }
  if (/File exists/.test(diagnostic)) {
    return "Choose a different destination or remove the existing one first.";
  }
  if (/No space left on device/.test(diagnostic)) {
    return "Free some space on the destination filesystem and try again.";
  }
  if (/Disk quota exceeded/.test(diagnostic)) {
    return "Free space within your quota or choose a different destination.";
  }
  if (/File too large/.test(diagnostic)) {
    return "Use a smaller output or a filesystem that supports larger files.";
  }
  if (/File name too long/.test(diagnostic)) {
    return "Shorten the file name or one of its parent directory names.";
  }
  if (/Read-only file system/.test(diagnostic)) {
    return "Choose a writable destination or remount the filesystem read-write.";
  }
  if (/Too many open files/.test(diagnostic)) {
    return "Close unused file descriptors or raise the process file-descriptor limit.";
  }
  if (/Cannot allocate memory|Out of memory/.test(diagnostic)) {
    return "Reduce the input size or memory usage, or make more memory available.";
  }
  if (/Device or resource busy|Text file busy/.test(diagnostic)) {
    return "Wait for the resource to become available or stop the process currently using it.";
  }
  if (/Invalid cross-device link/.test(diagnostic)) {
    return "Use a copy followed by removal when moving data between filesystems.";
  }
  if (/Operation not supported|Not supported/.test(diagnostic)) {
    return "Choose an operation supported by this filesystem or platform.";
  }
  if (/Bad file descriptor/.test(diagnostic)) {
    return "Check that the referenced input or output descriptor is open and usable.";
  }
  if (/Input\/output error/.test(diagnostic)) {
    return "Check the device and filesystem health, then retry the operation.";
  }
  if (/Too many levels of symbolic links/.test(diagnostic)) {
    return "Check the path for a symbolic-link loop.";
  }
  if (/input is not in sorted order|: is not sorted:/.test(diagnostic)) {
    return "Sort each input using the same comparison rules, then try again.";
  }
  if (/omitting directory/.test(diagnostic)) {
    return `Add the recursive option if you intend ${program} to process a directory tree.`;
  }
  if (/are the same file/.test(diagnostic)) {
    return "Choose a destination that is different from the source.";
  }
  if (/no such user|no such group/.test(diagnostic)) {
    return "Check that the account name exists, or use a numeric ID where supported.";
  }
  if (/no login name/.test(diagnostic)) {
    return "Run this from a login session, or use a command such as 'whoami' for the effective user.";
  }
  if (/cannot skip past end|cannot skip to specified offset/.test(diagnostic)) {
    return "Reduce the requested offset so it falls within the available input.";
  }
  if (/input contains a loop/.test(diagnostic)) {
    return "Remove a dependency cycle from the input graph and try again.";
  }
  if (/input contains an odd number of tokens/.test(diagnostic)) {
    return "Provide dependency tokens in pairs: one item followed by the item that depends on it.";
  }
  if (/not listing already-listed directory/.test(diagnostic)) {
    return "Check the directory tree for a cycle, usually caused by a symbolic link.";
  }
  if (/no files remaining/.test(diagnostic)) {
    return "Check the input paths, or use --retry when following names that may reappear.";
  }
  if (/no file systems processed/.test(diagnostic)) {
    return "Check the requested paths and filesystem-type filters.";
  }
  if (/couldn't get boot time/.test(diagnostic)) {
    return "Check that the system exposes readable boot-time accounting information.";
  }
  if (/no input from|cannot read file names from/.test(diagnostic)) {
    return "Check that the file-name list is readable and contains valid entries.";
  }
  if (/using '-' to denote standard input does not work in file system mode/.test(diagnostic)) {
    return "Name a filesystem path instead of '-' when using filesystem mode.";
  }
  if (/regular expression has length zero|invalid (?:regular expression|pattern)/.test(diagnostic)) {
    return "Use a non-empty, valid regular expression for the selected command.";
  }
  if (/match not found/.test(diagnostic)) {
    return "Adjust the pattern so it matches the input, or remove that split point.";
  }
  if (/line number .* smaller than preceding|line number .* same as preceding/.test(diagnostic)) {
    return "List split line numbers once each and in strictly increasing order.";
  }
  if (/starting page number .* exceeds page count/.test(diagnostic)) {
    return "Choose a starting page that exists in the input.";
  }
  if (/closing delimiter .* missing|integer expected after delimiter/.test(diagnostic)) {
    return "Close the pattern delimiter and place any numeric offset after it.";
  }
  if (/syntax error|unexpected argument|expecting ['‘]?\)|Unmatched|Trailing backslash/.test(diagnostic)) {
    return "Correct the expression syntax, balancing parentheses, escapes, and operators.";
  }
  if (/non-integer argument/.test(diagnostic)) {
    return "Use integer operands for arithmetic operations.";
  }
  if (/division by zero/.test(diagnostic)) {
    return "Use a nonzero divisor.";
  }
  if (/format .* (?:ends in %|has no % directive|has too many % directives|has unknown .* directive)|invalid precision in format/.test(diagnostic)) {
    return invalidValueHint(program, diagnostic);
  }
  if (/checksum.*(?:did NOT match|mismatch)|computed checksum.*not match/i.test(diagnostic)) {
    return "Verify that the file and expected checksum came from the same source.";
  }
  if (/no properly formatted checksum lines found|improperly formatted .* checksum line/.test(diagnostic)) {
    return "Check the checksum file format and selected checksum algorithm.";
  }
  if (/failed to set locale/.test(diagnostic)) {
    return "Select an installed locale, for example by setting LC_ALL=C.";
  }
  if (/Host name lookup failure/.test(diagnostic)) {
    return "Check the host name and DNS or hosts-file configuration.";
  }
  if (/can't open/.test(diagnostic)) {
    return "Check that the file exists and is readable.";
  }
  if (/this system doesn't provide/.test(diagnostic)) {
    return "Choose a data type or feature supported by this platform.";
  }
  if (/cannot fstat|failed to stat|cannot stat|cannot access|failed to access/.test(diagnostic)) {
    return "Check that the path exists and that its metadata is accessible.";
  }
  if (/cannot unlink|cannot remove|failed to remove/.test(diagnostic)) {
    return "Check that the path exists, is writable, and is not protected or in use.";
  }
  if (/failed to run command|cannot run|could not run|failed to execute|not found in PATH/.test(diagnostic)) {
    return "Check that the command exists, is executable, and is available on PATH.";
  }
  if (/cannot create link|failed to create link/.test(diagnostic)) {
    return "Check the source, destination, permissions, and filesystem link support.";
  }
  if (/input file is output file/.test(diagnostic)) {
    return "Choose an output path different from the input path.";
  }
  if (/cannot (?:copy|move) a directory.*into itself|cannot move .* subdirectory of itself/.test(diagnostic)) {
    return "Choose a destination outside the source directory tree.";
  }
  if (/will not overwrite just-created/.test(diagnostic)) {
    return "Give each source a distinct destination name instead of targeting the same newly created path.";
  }
  if (/target .* is not a directory|target directory .*Not a directory|destination must be a directory/.test(diagnostic)) {
    return "Use an existing directory as the destination, or provide only one source file.";
  }
  if (/not writing through dangling symlink/.test(diagnostic)) {
    return "Repair or remove the dangling destination symlink, then try again.";
  }
  if (/inter-device move failed.*--no-copy specified/.test(diagnostic)) {
    return "Remove --no-copy to allow a copy-and-delete move between filesystems.";
  }
  if (/cannot do --relative without --symbolic/.test(diagnostic)) {
    return "Add --symbolic when using --relative, or remove --relative.";
  }
  if (/preserve-root/.test(diagnostic) && /unrecognized|may not abbreviate/.test(diagnostic)) {
    return "Use the full option '--no-preserve-root', or use '--preserve-root=all'.";
  }
  if (/dangerous to operate recursively/.test(diagnostic)) {
    return "Verify the path carefully; use --no-preserve-root only if removing this protected root is intentional.";
  }
  if (/skipping .*different device|--preserve-root=all is in effect/.test(diagnostic)) {
    return "Remove --one-file-system/--preserve-root=all only if crossing this filesystem boundary is intentional.";
  }
  if (/--skip-chdir only permitted/.test(diagnostic)) {
    return "Use --skip-chdir only with NEWROOT '/', or remove --skip-chdir.";
  }
  if (/security context|SELinux|SMACK/.test(diagnostic) && /cannot|failed|invalid/.test(diagnostic)) {
    return "Use a valid security label and verify that the required security module is enabled.";
  }
  if (/backing up .* might destroy source/.test(diagnostic)) {
    return "Choose a different backup suffix or move the source away from the backup path.";
  }
  if (/through just-created symlink/.test(diagnostic)) {
    return "Remove the conflicting symbolic link or choose a different destination tree.";
  }
  if (/not replacing|cannot overwrite/.test(diagnostic)) {
    return `Choose a different destination or review '${program} --help' for overwrite options.`;
  }
  if (/\binvalid\b|not a valid|\bunsupported\b/i.test(diagnostic)) {
    return invalidValueHint(program, diagnostic);
  }
  if (/cannot open|failed to open|error reading|read error/.test(diagnostic)) {
    return "Check that the input exists and is readable.";
  }
  if (/cannot create|failed to create|error writing|write error/.test(diagnostic)) {
    return "Check that the destination exists, is writable, and has enough free space.";
  }
  if (/ignoring non-option arguments/.test(diagnostic)) {
    return `Remove the operands; '${program}' does not use positional arguments.`;
  }
  if (informationalDiagnostic(program, diagnostic)) return null;
  if (/(?:^|:\s)(?:cannot|could not|failed|error|invalid|unrecognized|unknown|missing|extra|refusing|unable|must|requires?|may not)\b/im.test(diagnostic)) {
    return genericDiagnosticHint(program);
  }
  // Direct command implementations sometimes return terse GNU diagnostics
  // without a standard error keyword. Once progress/debug output is excluded,
  // still give those failures command-specific recovery guidance.
  return invalidValueHint(program, diagnostic);
}

export function genericDiagnosticHint(program) {
  return `Review the arguments and current system state, then run '${program} --help' if the problem persists.`;
}

export function commandUsageHint(program, action) {
  const helpProgram = program === "ginstall" ? "install" : program;
  const usage = SPECIAL_HELP[helpProgram]?.usage?.split("\n", 1)[0]?.replace(/^Usage:\s*/, "");
  return usage
    ? `${action}. Expected form: ${usage}.`
    : `${action}. Run '${program} --help' for the expected form.`;
}

export function informationalDiagnostic(program, diagnostic) {
  if (program === "sort" && /text ordering performed|key \d+ has zero width|numeric and spans multiple fields|leading blanks are significant|field separator|numbers use|options? .* (?:is|are) ignored|only applies to last-resort comparison/.test(diagnostic)) return true;
  if (program === "date" && (/only using last of multiple/.test(diagnostic) || (/date: output format:/.test(diagnostic) && !/date: error:/.test(diagnostic)))) return true;
  if (program === "cksum" && /using generic checksum implementation/.test(diagnostic)) return true;
  if (program === "numfmt" && /--header ignored|grouping has no effect|no conversion option specified|failed to convert some/.test(diagnostic)) return true;
  if (program === "timeout" && /sending signal/.test(diagnostic)) return true;
  if (program === "shred" && /: (?:pass \d+\/\d+|removing|renamed to|removed)/.test(diagnostic)) return true;
  if (program === "tail" && /using .* mode|has appeared;|has been replaced;|file truncated|reverting to polling/.test(diagnostic)) return true;
  if (program === "executing" || program === "argv0") return true;
  return false;
}

export function invalidValueHint(program, diagnostic) {
  if (/Valid arguments are:/.test(diagnostic)) return "Choose one of the valid values listed above and try again.";
  const hints = {
    basename: "Check the suffix and file-name arguments shown by 'basename --help'.",
    basenc: "Check that the input uses the selected encoding and has valid padding.",
    base32: "Check that the input is valid base32 data and has correct padding.",
    base64: "Check that the input is valid base64 data and has correct padding.",
    cat: "Check the input paths and use '-' only when the data should come from standard input.",
    chcon: "Use a complete security context, or valid user, role, type, and range components.",
    chroot: "Provide a valid new root, user/group specification, and executable command.",
    chmod: "Use an octal mode such as '755' or a symbolic mode such as 'u+x'.",
    chown: "Use OWNER, OWNER:GROUP, or a numeric user and group ID.",
    chgrp: "Use an existing group name or a numeric group ID.",
    cksum: "Choose a supported algorithm and a digest length valid for that algorithm.",
    csplit: "Use a positive line number or a valid /REGEXP/ split pattern.",
    comm: "Provide exactly two sorted inputs and select valid output columns.",
    cp: "Check the copy mode, preservation attributes, and source/destination form.",
    cut: "Use positive byte, character, or field positions such as '1-3,7'.",
    date: "Use a recognized date such as '2026-07-13 14:30' or an ISO 8601 value.",
    dd: "Use NAME=VALUE operands and a byte count such as '4K', '1M', or a positive integer.",
    df: "Use a supported output field, filesystem type, or block-size value.",
    dircolors: "Check the terminal type and dircolors database syntax.",
    du: "Use a valid depth, threshold, time style, or block-size value.",
    env: "Check the environment assignment, signal name, or quoting in the -S string.",
    expand: "Use positive, ascending tab stops or a positive repeating tab size.",
    expr: "Use integer operands where arithmetic is required and check the expression syntax.",
    factor: "Provide one or more positive integers.",
    fmt: "Use a positive width, with the goal width no larger than the maximum width.",
    fold: "Use a positive line width and select at most one width-counting mode.",
    groups: "Use an existing user name, or omit it to inspect the current process.",
    head: "Use a nonnegative count, optionally with a size suffix such as K or M.",
    hostname: "Provide a readable file or a valid host name supported by the selected operation.",
    id: "Select a compatible output mode and use an existing user name or numeric ID.",
    install: "Check the mode, owner/group, context, and source/destination form.",
    join: "Use file number 1 or 2 and field numbers starting at 1.",
    kill: "Use a valid signal name/number and a numeric process ID.",
    mkdir: "Use an octal mode such as '755' or a symbolic mode such as 'u=rwx'.",
    mkfifo: "Use an octal mode such as '644' or a symbolic mode.",
    mknod: "Use type 'b', 'c', 'u', or 'p' and valid major/minor device numbers where required.",
    mktemp: "Use a template ending in at least three X characters, for example 'tmp.XXXXXX'.",
    mv: "Check the update/backup mode and provide a valid source and destination.",
    nice: "Use an integer adjustment and provide a command to execute.",
    nl: "Check the numbering style, numeric width, and regular-expression syntax.",
    numfmt: "Use a valid numeric field/range and a supported scaling or format value.",
    nproc: "Use a nonnegative integer with --ignore.",
    od: "Use a supported type string and an address radix of d, o, x, or n.",
    paste: "Use a valid delimiter list; escape a trailing backslash.",
    pr: "Use positive page dimensions and a page range such as '2' or '2:5'.",
    printf: "Check the conversion directive and ensure each '%' starts a supported format conversion.",
    pwd: "Use only -L or -P; remove positional arguments.",
    readlink: "Choose a supported canonicalization mode and provide a valid path.",
    realpath: "Choose a supported canonicalization mode and provide a valid path.",
    rm: "Check the interactive/preserve-root mode and the recursive removal options.",
    rmdir: "Name empty directories, or use --ignore-fail-on-non-empty when appropriate.",
    runcon: "Provide a valid security context or context components followed by a command.",
    seq: "Use finite numeric operands, a nonzero increment, and a floating-point output format.",
    shuf: "Use a positive count or an input range in LO-HI form.",
    shred: "Use a positive pass count, valid size, and supported removal mode.",
    sleep: "Use one or more nonnegative durations, optionally suffixed with s, m, h, or d.",
    sort: "Check the key syntax, numeric size, and selected ordering mode.",
    split: "Use a positive chunk size/count and a suffix that does not contain '/'.",
    stdbuf: "Use buffering mode 'L', '0', or a positive size such as '4K'.",
    stty: "Use a supported terminal mode, control character, or numeric speed.",
    stat: "Use a supported format, cache policy, or filesystem mode.",
    tail: "Use a nonnegative count, valid PID, or supported --follow mode.",
    tee: "Use a supported --output-error mode and writable output files.",
    test: "Check the expression arity, operators, integer operands, and balanced parentheses.",
    timeout: "Use a nonnegative duration such as '30s', '5m', or '1h'.",
    touch: "Use a recognized date, [[CC]YY]MMDDhhmm[.ss], or a valid reference file.",
    tr: "Check the character sets, ranges, classes, escapes, and repeat counts.",
    truncate: "Use an absolute size or a signed adjustment such as '+1K' or '-512'.",
    tsort: "Provide whitespace-separated dependency pairs and remove dependency cycles.",
    uniq: "Use nonnegative skip/count values and a supported grouping method.",
    unexpand: "Use positive, ascending tab stops or a positive repeating tab size.",
    wc: "Use a supported count/total mode and valid input or --files0-from list.",
  };
  return hints[program] ?? `Check the value's format. Run '${program} --help' for accepted values.`;
}

export function closestLongOption(program, badOption) {
  const helpProgram = program === "ginstall" ? "install" : program;
  const options = [...new Set([...(COMMAND_HELP_OPTIONS[helpProgram] ?? []), "--help", "--version"])]
    .filter((option) => option.startsWith("--"))
    .map((option) => option.split("=", 1)[0]);
  const closest = closestValue(badOption.slice(2), options.map((option) => option.slice(2)));
  return closest == null ? null : `--${closest}`;
}

export function closestValue(value, candidates) {
  if (!candidates.length) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(value.length / 3)) ? best : null;
}

export function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function writeAllSync(fd, data) {
  const buffer = data instanceof Uint8Array ? data : encodeSurrogateEscapedString(String(data));
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written === 0) throw Object.assign(new Error("write returned 0"), { code: "EIO" });
    offset += written;
  }
}

export function encodeSurrogateEscapedString(text) {
  const chunks = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      chunks.push(Buffer.from(plain));
      plain = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc80 && code <= 0xdcff) {
      flush();
      chunks.push(Buffer.from([code - 0xdc00]));
    } else {
      plain += text[i];
    }
  }
  flush();
  return Buffer.concat(chunks);
}

export function fail(program, message, code = 1) {
  try {
    stderr(`${program}: ${message}\n`, true);
  } catch (error) {
    if (isOutputWriteError(error)) return code;
    throw error;
  }
  return code;
}
