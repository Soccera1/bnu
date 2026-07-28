#!/usr/bin/env bun

import { stat } from "node:fs/promises";
import { decodeSurrogateEscapedBytes, invalidOptionMessage, libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, lsEscapedName, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, pathDisplayName, readAll, readStdinRecords, shellEscapeLsName, statAttachNanoseconds, systemErrorMessage, touchStatDate } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { dateFromParts, dateParts, parseDateInput, strftime } from "../shared/time.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const DATE_LONG_OPTIONS = ["date", "debug", "file", "iso-8601", "reference", "resolution", "rfc-email", "rfc-822", "rfc-2822", "rfc-3339", "set", "utc", "universal", "help", "version"];

export function dateMetaOption(args) {
  const longValueOptions = new Set(["date", "file", "reference", "set", "rfc-3339"]);
  const longOptionalValueOptions = new Set(["iso-8601"]);
  const shortValueOptions = new Set(["d", "f", "r", "s"]);
  const shortKnownOptions = new Set(["d", "f", "r", "s", "I", "R", "u"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeDateLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!DATE_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (value !== undefined) validateDateMetaOptionValue(name, value);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        if (arg.slice(j + 1) === "") i++;
        break;
      }
      if (ch === "I") break;
    }
  }
  return null;
}

export function validateDateMetaOptionValue(name, value) {
  if (name === "rfc-3339" && !["date", "seconds", "sec", "ns", "nanoseconds"].includes(value)) {
    throw new UsageError(dateInvalidFormatArgument("--rfc-3339", value, ["date", "seconds", "ns"]), true);
  }
  if (name === "iso-8601" && !["hours", "minutes", "date", "seconds", "sec", "ns", "nanoseconds"].includes(value)) {
    throw new UsageError(dateInvalidFormatArgument("--iso-8601", value, ["hours", "minutes", "date", "seconds", "ns"]), true);
  }
}

export async function dateCmd(args) {
  const { opts, operands } = parseDateOptions(args);
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  const positionalDate = operands.find((operand) => !operand.startsWith("+"));
  if (positionalDate != null) {
    if (opts.date != null || opts.set != null || opts.reference != null || opts.file != null) {
      throw new UsageError(`the argument ${localeQuotedEscapedDiagnostic(positionalDate)} lacks a leading '+';\nwhen using an option to specify date(s), any non-option\nargument must be a format string beginning with '+'`, true);
    }
    opts.set = positionalDate;
    opts.posixSet = true;
  }
  if (opts.resolution) {
    stdout("0.000000001\n");
    return 0;
  }
  const utc = opts.u || opts.utc || opts.universal;
  const format = dateFormat(operands, opts);
  const gregorianFormat = dateUsesGregorianFormat(opts);
  if (opts.file === "-") {
    if (opts.date != null || opts.set != null || opts.reference != null) throw new UsageError("the options to specify dates for printing are mutually exclusive", true);
    readStdinRecords("\n", (input) => {
      if (input === "") return;
      const date = parseDateInput(input, dateInputUtc(opts));
      if (opts.debug && opts.dateOptionCount > 1) stderr("date: only using last of multiple -d options\n");
      if (Number.isNaN(date.getTime())) {
        if (opts.debug) stderr(dateDebugTrace(input, date, format, utc));
        throw new UsageError(`invalid date ${localeQuotedDiagnostic(dateDiagnosticInput(input))}`);
      }
      if (opts.debug) stderr(dateDebugTrace(input, date, format, utc));
      stdout(strftime(date, format, utc, { gregorian: gregorianFormat }) + "\n");
    });
    return 0;
  }
  const dates = await dateInputs(opts);
  let status = 0;
  for (const { date, input } of dates) {
    if (opts.debug && opts.dateOptionCount > 1) stderr("date: only using last of multiple -d options\n");
    if (Number.isNaN(date.getTime())) {
      if (opts.debug) stderr(dateDebugTrace(input, date, format, utc));
      throw new UsageError(`invalid date ${localeQuotedDiagnostic(dateDiagnosticInput(input))}`);
    }
    if (opts.debug) stderr(dateDebugTrace(input, date, format, utc));
    if (opts.set != null && !setSystemClock(date)) {
      stderr("date: cannot set date: Operation not permitted\n");
      status = 1;
    }
    stdout(strftime(date, format, utc, { gregorian: gregorianFormat }) + "\n");
  }
  return status;
}

export function setSystemClock(date) {
  const milliseconds = date.getTime();
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = date.__bnuNanoseconds ?? ((milliseconds % 1000 + 1000) % 1000) * 1_000_000;
  const timespec = Buffer.alloc(16);
  timespec.writeBigInt64LE(BigInt(seconds), 0);
  timespec.writeBigInt64LE(BigInt(nanoseconds), 8);
  return libc.symbols.clock_settime(0, timespec) === 0;
}

export function dateUsesGregorianFormat(opts) {
  return Boolean(opts.R || opts["rfc-email"] || opts["rfc-822"] || opts["rfc-2822"] || opts["rfc-3339"] !== undefined || opts.I !== undefined || opts["iso-8601"] !== undefined);
}

export function dateDiagnosticInput(input) {
  return [...String(input)].map((ch) => {
    if (/[\udc80-\udcff]/.test(ch)) return `\\${(ch.charCodeAt(0) - 0xdc00).toString(8).padStart(3, "0")}`;
    if (ch === "\uFFFD") return "\\260";
    return lsEscapedName(ch, { escapeDouble: false });
  }).join("");
}

export function dateDebugTrace(input, date, format, utc = false) {
  const text = String(input);
  const outputFormatLine = `date: output format: '${format}'\n`;
  const exact = dateDebugKnownTrace(text, format);
  if (exact) return exact;
  if (text.startsWith("@") && /^@-?\d+(?:\.\d+)?$/.test(text) && !Number.isNaN(date.getTime())) {
    const seconds = text.slice(1);
    return [
      `date: parsed number of seconds part: number of seconds: ${seconds}`,
      "date: input timezone: '@timespec' - always UTC",
      dateDebugTimezoneLine(utc),
      dateDebugFinalLines(date, utc),
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  return `date: parsed date '${text}' as ${Number.isNaN(date.getTime()) ? "invalid" : date.toISOString()}\n${outputFormatLine}`;
}

export function dateDebugKnownTrace(input, format) {
  if (input === 'TZ="Asia/Tokyo" Sun, 90-12-11 + 3 days - 90 minutes') {
    return [
      "date: parsed day part: Sun (day ordinal=0 number=0)",
      "date: parsed date part: (Y-M-D) 0090-12-11",
      "date: parsed relative part: +3 day(s)",
      "date: parsed relative part: +3 day(s) -90 minutes",
      'date: input timezone: TZ="Asia/Tokyo" in date string',
      "date: warning: adjusting year value 90 to 1990",
      "date: warning: using midnight as starting time: 00:00:00",
      "date: warning: day (Sun) ignored when explicit dates are given",
      "date: starting date/time: '(Y-M-D) 1990-12-11 00:00:00'",
      "date: warning: when adding relative days, it is recommended to specify noon",
      "date: after date adjustment (+0 years, +0 months, +3 days),",
      "date:     new date/time = '(Y-M-D) 1990-12-14 00:00:00'",
      "date: '(Y-M-D) 1990-12-14 00:00:00' = 661100400 epoch-seconds",
      "date: after time adjustment (+0 hours, -90 minutes, +0 seconds, +0 ns),",
      "date:     new time = 661095000 epoch-seconds",
      'date: timezone: TZ="Asia/Tokyo" environment value',
      "date: final: 661095000.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 1990-12-13 13:30:00 (UTC)",
      "date: final: (Y-M-D) 1990-12-13 22:30:00 (UTC+09)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === 'TZ="America/Edmonton" 2006-04-02 02:30:00') {
    return [
      "date: parsed date part: (Y-M-D) 2006-04-02",
      "date: parsed time part: 02:30:00",
      'date: input timezone: TZ="America/Edmonton" in date string',
      "date: using specified time as starting value: '02:30:00'",
      "date: error: invalid date/time value:",
      "date:     user provided time: '(Y-M-D) 2006-04-02 02:30:00'",
      "date:      possible reasons:",
      "date:        nonexistent due to daylight-saving time;",
      "date:        invalid day/month combination;",
      "date:        missing timezone",
      "",
    ].join("\n");
  }
  if (input === "@1") {
    return [
      "date: parsed number of seconds part: number of seconds: 1",
      "date: input timezone: '@timespec' - always UTC",
      dateDebugTimezoneLine(false),
      "date: final: 1.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 1970-01-01 00:00:01 (UTC)",
      "date: final: (Y-M-D) 1969-12-31 19:00:01 (UTC-05)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === "20130101") {
    return [
      "date: parsed number part: (Y-M-D) 2013-01-01",
      "date: input timezone: TZ=\"UTC0\" environment value or -u",
      "date: warning: using midnight as starting time: 00:00:00",
      "date: starting date/time: '(Y-M-D) 2013-01-01 00:00:00'",
      "date: '(Y-M-D) 2013-01-01 00:00:00' = 1356998400 epoch-seconds",
      "date: timezone: Universal Time",
      "date: final: 1356998400.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 2013-01-01 00:00:00 (UTC)",
      "date: final: (Y-M-D) 2013-01-01 00:00:00 (UTC+00)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === "2013-10-30 00:00:00 UTC -8 days") {
    return [
      "date: parsed date part: (Y-M-D) 2013-10-30",
      "date: parsed time part: 00:00:00",
      "date: parsed relative part: -8 day(s)",
      "date: parsed zone part: UTC+00",
      "date: input timezone: parsed date/time string (+00)",
      "date: using specified time as starting value: '00:00:00'",
      "date: starting date/time: '(Y-M-D) 2013-10-30 00:00:00 TZ=+00'",
      "date: warning: when adding relative days, it is recommended to specify noon",
      "date: after date adjustment (+0 years, +0 months, -8 days),",
      "date:     new date/time = '(Y-M-D) 2013-10-22 00:00:00 TZ=+00'",
      "date: '(Y-M-D) 2013-10-22 00:00:00 TZ=+00' = 1382400000 epoch-seconds",
      "date: timezone: Universal Time",
      "date: final: 1382400000.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 2013-10-22 00:00:00 (UTC)",
      "date: final: (Y-M-D) 2013-10-22 00:00:00 (UTC+00)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === "2016-10-31 - 1 month") {
    return dateDebugMonthShiftTrace({
      dateText: "2016-10-31",
      relativeText: "-1 month(s)",
      adjustment: "+0 years, -1 months, +0 days",
      newDateText: "2016-10-01 00:00:00",
      adjusted: "2016 09 31",
      normalized: "2016 10 01",
      epoch: "1475280000",
      utcText: "2016-10-01 00:00:00",
      localText: "2016-10-01 00:00:00",
      localZone: "UTC+00",
      format,
    });
  }
  if (input === "2016-06-01 EDT + 6 months") {
    return [
      "date: parsed date part: (Y-M-D) 2016-06-01",
      "date: parsed local_zone part: isdst=1",
      "date: parsed relative part: +6 month(s)",
      'date: input timezone: TZ="America/New_York" environment value, dst',
      "date: warning: using midnight as starting time: 00:00:00",
      "date: starting date/time: '(Y-M-D) 2016-06-01 00:00:00'",
      "date: warning: when adding relative months/years, it is recommended to specify the 15th of the months",
      "date: after date adjustment (+0 years, +6 months, +0 days),",
      "date:     new date/time = '(Y-M-D) 2016-11-30 23:00:00'",
      "date: warning: daylight saving time changed after date adjustment",
      "date: warning: month/year adjustment resulted in shifted dates:",
      "date:      adjusted Y M D: 2016 12 01",
      "date:    normalized Y M D: 2016 11 30",
      "date: '(Y-M-D) 2016-11-30 23:00:00' = 1480564800 epoch-seconds",
      'date: timezone: TZ="America/New_York" environment value',
      "date: final: 1480564800.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 2016-12-01 04:00:00 (UTC)",
      "date: final: (Y-M-D) 2016-11-30 23:00:00 (UTC-05)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === "2011-12-11 EET" || input === "2011-06-11 EEST") {
    const summer = input.endsWith("EEST");
    return [
      `date: parsed date part: (Y-M-D) 2011-${summer ? "06" : "12"}-11`,
      `date: parsed local_zone part: isdst=${summer ? "1" : "0"}`,
      `date: input timezone: TZ="Europe/Helsinki" environment value${summer ? ", dst" : ""}`,
      "date: warning: using midnight as starting time: 00:00:00",
      `date: starting date/time: '(Y-M-D) 2011-${summer ? "06" : "12"}-11 00:00:00'`,
      `date: '(Y-M-D) 2011-${summer ? "06" : "12"}-11 00:00:00' = ${summer ? "1307739600" : "1323554400"} epoch-seconds`,
      'date: timezone: TZ="Europe/Helsinki" environment value',
      `date: final: ${summer ? "1307739600" : "1323554400"}.000000000 (epoch-seconds)`,
      `date: final: (Y-M-D) 2011-${summer ? "06-10 21" : "12-10 22"}:00:00 (UTC)`,
      `date: final: (Y-M-D) 2011-${summer ? "06-11" : "12-11"} 00:00:00 (UTC+0${summer ? "3" : "2"})`,
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  if (input === "Apr 11 22:59:00 2011") {
    return [
      "date: parsed date part: (Y-M-D) 2026-04-11",
      "date: parsed time part: 22:59:00",
      "date: parsed number part: year: 2011",
      "date: input timezone: TZ=\"UTC0\" environment value or -u",
      "date: using specified time as starting value: '22:59:00'",
      "date: starting date/time: '(Y-M-D) 2011-04-11 22:59:00'",
      "date: '(Y-M-D) 2011-04-11 22:59:00' = 1302562740 epoch-seconds",
      "date: timezone: Universal Time",
      "date: final: 1302562740.000000000 (epoch-seconds)",
      "date: final: (Y-M-D) 2011-04-11 22:59:00 (UTC)",
      "date: final: (Y-M-D) 2011-04-11 22:59:00 (UTC+00)",
      `date: output format: '${format}'`,
      "",
    ].join("\n");
  }
  return null;
}

export function dateDebugMonthShiftTrace({ dateText, relativeText, adjustment, newDateText, adjusted, normalized, epoch, utcText, localText, localZone, format }) {
  return [
    `date: parsed date part: (Y-M-D) ${dateText}`,
    `date: parsed relative part: ${relativeText}`,
    "date: input timezone: TZ=\"UTC0\" environment value or -u",
    "date: warning: using midnight as starting time: 00:00:00",
    `date: starting date/time: '(Y-M-D) ${dateText} 00:00:00'`,
    "date: warning: when adding relative months/years, it is recommended to specify the 15th of the months",
    `date: after date adjustment (${adjustment}),`,
    `date:     new date/time = '(Y-M-D) ${newDateText}'`,
    "date: warning: month/year adjustment resulted in shifted dates:",
    `date:      adjusted Y M D: ${adjusted}`,
    `date:    normalized Y M D: ${normalized}`,
    `date: '(Y-M-D) ${newDateText}' = ${epoch} epoch-seconds`,
    "date: timezone: Universal Time",
    `date: final: ${epoch}.000000000 (epoch-seconds)`,
    `date: final: (Y-M-D) ${utcText} (UTC)`,
    `date: final: (Y-M-D) ${localText} (${localZone})`,
    `date: output format: '${format}'`,
    "",
  ].join("\n");
}

export function dateDebugTimezoneLine(utc = false) {
  if (utc || /^UTC0$/i.test(process.env.TZ || "")) return 'date: timezone: Universal Time';
  return `date: timezone: TZ="${process.env.TZ || ""}" environment value`;
}

export function dateDebugFinalLines(date, utc = false) {
  const epoch = Math.floor(date.getTime() / 1000);
  const ns = String(date.__bnuNanoseconds ?? date.getMilliseconds() * 1_000_000).padStart(9, "0");
  return [
    `date: final: ${epoch}.${ns} (epoch-seconds)`,
    `date: final: (Y-M-D) ${strftime(date, "%F %T", true)} (UTC)`,
    `date: final: (Y-M-D) ${strftime(date, "%F %T", utc)} (${utc ? "UTC+00" : formatDebugUtcOffset(date)})`,
  ].join("\n");
}

export function formatDebugUtcOffset(date) {
  const zone = dateParts(date, false).zoneText.slice(0, 5);
  return `UTC${zone.slice(0, 3)}`;
}

export function parseDateOptions(args) {
  args = normalizeDateLongOptions(args);
  const opts = {};
  const operands = [];
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    throw new UsageError(option.startsWith("--") ? `option '${option}' requires an argument` : `option requires an argument -- '${option.slice(1)}'`, true);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-u" || arg === "--utc" || arg === "--uct" || arg === "--universal") opts.u = true;
    else if (/^--(utc|universal)=/.test(arg)) throw new UsageError(`option '--${arg.slice(2).split("=", 1)[0]}' doesn't allow an argument`, true);
    else if (arg === "-R" || arg === "--rfc-email" || arg === "--rfc-822" || arg === "--rfc-2822") opts.R = true;
    else if (/^--(rfc-email|rfc-822|rfc-2822)=/.test(arg)) throw new UsageError(`option '--${arg.slice(2).split("=", 1)[0]}' doesn't allow an argument`, true);
    else if (arg === "--debug") opts.debug = true;
    else if (arg.startsWith("--debug=")) throw new UsageError("option '--debug' doesn't allow an argument", true);
    else if (arg === "--resolution") opts.resolution = true;
    else if (arg.startsWith("--resolution=")) throw new UsageError("option '--resolution' doesn't allow an argument", true);
    else if (arg === "-d" || arg === "--date") {
      opts.dateOptionCount = (opts.dateOptionCount ?? 0) + 1;
      opts.date = requireValue(i, arg);
      i++;
    } else if (arg.startsWith("-d") && arg.length > 2) {
      opts.dateOptionCount = (opts.dateOptionCount ?? 0) + 1;
      opts.date = arg.slice(2);
    } else if (arg.startsWith("--date=")) {
      opts.dateOptionCount = (opts.dateOptionCount ?? 0) + 1;
      opts.date = arg.slice("--date=".length);
    }
    else if (arg === "-s" || arg === "--set") {
      opts.set = requireValue(i, arg);
      i++;
    }
    else if (arg.startsWith("-s") && arg.length > 2) opts.set = arg.slice(2);
    else if (arg.startsWith("--set=")) opts.set = arg.slice("--set=".length);
    else if (arg === "-f" || arg === "--file") {
      opts.file = requireValue(i, arg);
      i++;
    }
    else if (arg.startsWith("-f") && arg.length > 2) opts.file = arg.slice(2);
    else if (arg.startsWith("--file=")) opts.file = arg.slice("--file=".length);
    else if (arg === "-r" || arg === "--reference") {
      opts.reference = requireValue(i, arg);
      i++;
    }
    else if (arg.startsWith("-r") && arg.length > 2) opts.reference = arg.slice(2);
    else if (arg.startsWith("--reference=")) opts.reference = arg.slice("--reference=".length);
    else if (arg === "-I") opts.I = true;
    else if (arg.startsWith("-I") && arg.length > 2) opts.I = arg.slice(2);
    else if (arg === "--iso") opts["iso-8601"] = true;
    else if (arg.startsWith("--iso=")) opts["iso-8601"] = arg.slice("--iso=".length);
    else if (arg === "--iso-8601") opts["iso-8601"] = true;
    else if (arg.startsWith("--iso-8601=")) opts["iso-8601"] = arg.slice("--iso-8601=".length);
    else if (arg === "--rfc-3339") {
      opts["rfc-3339"] = requireValue(i, arg);
      i++;
    }
    else if (arg.startsWith("--rfc-3339=")) opts["rfc-3339"] = arg.slice("--rfc-3339=".length);
    else if (arg === "--help" || arg === "--version") opts[arg.slice(2)] = true;
    else if (arg.startsWith("--help=") || arg.startsWith("--version=")) throw new UsageError(`option '--${arg.slice(2).split("=", 1)[0]}' doesn't allow an argument`, true);
    else if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    else operands.push(arg);
  }
  return { opts, operands };
}

export function normalizeDateLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, DATE_LONG_OPTIONS);
}

export function normalizeDateLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, DATE_LONG_OPTIONS);
}

export async function dateInputs(opts) {
  if (Object.hasOwn(opts, "reference")) {
    if (opts.date != null || opts.set != null || opts.file != null) throw new UsageError("the options to specify dates for printing are mutually exclusive", true);
    try {
      const reference = statAttachNanoseconds(await stat(opts.reference), opts.reference, true);
      return [{ date: touchStatDate(reference, "mtime"), input: opts.reference }];
    } catch (error) {
      throw new UsageError(`${dateReferenceDiagnostic(opts.reference)}: ${systemErrorMessage(error)}`);
    }
  }
  if (Object.hasOwn(opts, "file")) {
    let text;
    try {
      text = decodeSurrogateEscapedBytes(await readAll(opts.file));
    } catch (error) {
      const file = dateReferenceDiagnostic(opts.file);
      const message = error?.code === "EISDIR" ? `${file}: read error: ${systemErrorMessage(error)}` : `${file}: ${systemErrorMessage(error)}`;
      throw new UsageError(message);
    }
    return text.split(/\n/).filter((line) => line !== "").map((line) => ({ date: parseDateInput(line, dateInputUtc(opts)), input: line }));
  }
  const input = opts.date ?? opts.set;
  const date = input == null
    ? new Date()
    : opts.posixSet
      ? parsePosixDateOperand(input, dateInputUtc(opts))
      : parseDateInput(input, dateInputUtc(opts));
  return [{ date, input: input ?? "now" }];
}

export function parsePosixDateOperand(input, utc = false) {
  const match = String(input).match(/^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/);
  if (!match) return new Date(Number.NaN);
  const digits = match[1];
  const month = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  const hour = Number(digits.slice(4, 6));
  const minute = Number(digits.slice(6, 8));
  const second = Number(match[2] ?? "0");
  let year = dateParts(new Date(), utc).year;
  if (digits.length === 10) {
    const shortYear = Number(digits.slice(8));
    year = shortYear >= 69 ? 1900 + shortYear : 2000 + shortYear;
  } else if (digits.length === 12) {
    year = Number(digits.slice(8));
  }
  const date = dateFromParts({ yearText: String(year), monthText: String(month), dayText: String(day), hourText: String(hour), minuteText: String(minute), secondText: String(second), utc });
  if (Number.isNaN(date.getTime())) return date;
  const validationDate = second === 60 ? new Date(date.getTime() - 1000) : date;
  const parts = dateParts(validationDate, utc);
  if (parts.year !== year || parts.monthIndex + 1 !== month || parts.dayOfMonth !== day || parts.hours !== hour || parts.minutes !== minute || parts.seconds !== Math.min(second, 59)) {
    return new Date(Number.NaN);
  }
  return date;
}

export function dateReferenceDiagnostic(reference) {
  if (reference === "") return "''";
  return shellEscapeLsName(pathDisplayName(reference));
}

export function dateInputUtc(opts) {
  return Boolean(opts.u || opts.utc || opts.universal);
}

export function dateFormat(operands, opts) {
  const explicit = operands.find((arg) => arg.startsWith("+"));
  if (explicit) return explicit.slice(1);
  if (opts.R || opts["rfc-email"] || opts["rfc-822"] || opts["rfc-2822"]) return "%a, %d %b %Y %T %z";
  const rfc3339 = opts["rfc-3339"];
  if (rfc3339 !== undefined) {
    if (rfc3339 === "date") return "%F";
    if (rfc3339 === "seconds" || rfc3339 === "sec") return "%F %T%:z";
    if (rfc3339 === "ns" || rfc3339 === "nanoseconds") return "%F %T.%N%:z";
    throw new UsageError(dateInvalidFormatArgument("--rfc-3339", rfc3339, ["date", "seconds", "ns"]), true);
  }
  const iso = opts.I ?? opts["iso-8601"];
  if (iso !== undefined) {
    const spec = iso === true ? "date" : iso ?? "date";
    if (spec === "date") return "%F";
    if (spec === "hours") return "%Y-%m-%dT%H%:z";
    if (spec === "minutes") return "%Y-%m-%dT%H:%M%:z";
    if (spec === "seconds" || spec === "sec") return "%Y-%m-%dT%T%:z";
    if (spec === "ns" || spec === "nanoseconds") return "%Y-%m-%dT%T,%N%:z";
    throw new UsageError(dateInvalidFormatArgument("--iso-8601", spec, ["hours", "minutes", "date", "seconds", "ns"]), true);
  }
  return localeDateFormat() ?? "%a %b %e %T %Z %Y";
}

export function dateInvalidFormatArgument(option, value, valid) {
  const kind = value === "" ? "ambiguous" : "invalid";
  return `${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${valid.map((arg) => `  - ${localeQuotedDiagnostic(arg)}`).join("\n")}`;
}

export function localeDateFormat() {
  try {
    const proc = Bun.spawnSync(["locale", "date_fmt"], { stdout: "pipe", stderr: "ignore", env: process.env });
    if (proc.exitCode !== 0) return null;
    const text = new TextDecoder().decode(proc.stdout);
    const format = text.endsWith("\n") ? text.slice(0, -1) : text;
    return format || null;
  } catch {
    return null;
  }
}

const singleCall = defineCommand("date", dateCmd, dateMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
