import { attachDateNanoseconds, floorDivBigInt } from "./common.js";
import { parseGNUBlockSizeEnvInfo } from "./filesystem.js";

export function dateParts(date, utc = false) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const tz = utc ? { offsetSeconds: 0, name: "UTC" } : parsePosixTZ(date);
  if (tz) {
    const shifted = new Date(date.getTime() + tz.offsetSeconds * 1000);
    const year = shifted.getUTCFullYear();
    const monthIndex = shifted.getUTCMonth();
    const dayOfMonth = shifted.getUTCDate();
    const weekDay = shifted.getUTCDay();
    const hours = shifted.getUTCHours();
    const minutes = shifted.getUTCMinutes();
    const seconds = shifted.getUTCSeconds();
    const milliseconds = shifted.getUTCMilliseconds();
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekDay];
    const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][monthIndex];
    const zoneText = formatZoneOffset(tz.offsetSeconds);
    const ydayStart = Date.UTC(year, 0, 1);
    const ydayNow = Date.UTC(year, monthIndex, dayOfMonth);
    return { date, utc, pad2, year, monthIndex, dayOfMonth, weekDay, hours, minutes, seconds, milliseconds, nanoseconds: date.__bnuNanoseconds, day, shortDay: day.slice(0, 3), month, shortMonth: month.slice(0, 3), zoneText, zoneName: tz.name, yday: Math.floor((ydayNow - ydayStart) / 86400000) + 1 };
  }
  const get = (local, universal) => utc ? date[universal]() : date[local]();
  const year = get("getFullYear", "getUTCFullYear");
  const monthIndex = get("getMonth", "getUTCMonth");
  const dayOfMonth = get("getDate", "getUTCDate");
  const weekDay = get("getDay", "getUTCDay");
  const hours = get("getHours", "getUTCHours");
  const minutes = get("getMinutes", "getUTCMinutes");
  const seconds = get("getSeconds", "getUTCSeconds");
  const milliseconds = get("getMilliseconds", "getUTCMilliseconds");
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekDay];
  const shortDay = day.slice(0, 3);
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][monthIndex];
  const shortMonth = month.slice(0, 3);
  const zone = (utc ? 0 : -date.getTimezoneOffset()) * 60;
  const zoneText = formatZoneOffset(zone);
  const ydayStart = utc ? Date.UTC(year, 0, 1) : new Date(year, 0, 1).getTime();
  const ydayNow = utc ? Date.UTC(year, monthIndex, dayOfMonth) : new Date(year, monthIndex, dayOfMonth).getTime();
  return { date, utc, pad2, year, monthIndex, dayOfMonth, weekDay, hours, minutes, seconds, milliseconds, nanoseconds: date.__bnuNanoseconds, day, shortDay, month, shortMonth, zoneText, zoneName: utc ? "UTC" : localZoneName(date), yday: Math.floor((ydayNow - ydayStart) / 86400000) + 1 };
}

export function dateLocaleCalendar(parts) {
  const locale = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || "";
  if (/^am_ET(?:[.@_]|$)/i.test(locale)) {
    const afterNewYear = parts.monthIndex > 8 || (parts.monthIndex === 8 && parts.dayOfMonth >= 11);
    const year = parts.year - (afterNewYear ? 7 : 8);
    return { year };
  }
  if (/^fa_IR(?:[.@_]|$)/i.test(locale)) {
    const afterNewYear = parts.monthIndex > 2 || (parts.monthIndex === 2 && parts.dayOfMonth >= 21);
    const year = parts.year - (afterNewYear ? 621 : 622);
    return { year };
  }
  if (/^th_TH(?:[.@_]|$)/i.test(locale)) {
    const months = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
    const month = months[parts.monthIndex];
    return { year: parts.year + 543, month, shortMonth: month };
  }
  return null;
}

export function localZoneName(date) {
  const tz = process.env.TZ || "";
  if (/^UTC/i.test(tz)) return "UTC";
  if (/^PST8PDT/.test(tz)) return date.getMonth() >= 2 && date.getMonth() <= 10 ? "PDT" : "PST";
  if (/^PST8/.test(tz)) return "PST";
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  if (tz.includes("/") || resolved.includes("/")) {
    const abbreviation = localRuntimeZoneAbbreviation(date);
    if (abbreviation) return abbreviation;
  }
  const match = tz.match(/^([A-Za-z]{3,})/);
  return match?.[1] || resolved || "";
}

export function localRuntimeZoneAbbreviation(date) {
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const locales = [];
  if (/^Australia\//.test(tz)) locales.push("en-AU", "en-CA");
  if (/^Europe\//.test(tz)) locales.push("en-GB");
  if (/^Pacific\//.test(tz)) locales.push("en-NZ", "en-AU");
  if (/^America\//.test(tz)) locales.push("en-US", "en-CA");
  locales.push("en-US", "en-GB", "en-AU", "en-NZ", "en-CA");
  for (const locale of [...new Set(locales)]) {
    const value = new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    if (value && !/^(?:GMT|UTC)[+-]\d/.test(value)) return value;
  }
  const match = String(date).match(/\(([^)]+)\)$/);
  if (!match) return null;
  const words = match[1].split(/\s+/).filter(Boolean);
  if (/European Standard Time$/i.test(match[1])) {
    return words.filter((word) => !/^Standard$/i.test(word)).map((word) => word[0]).join("").toUpperCase() || null;
  }
  return words.map((word) => word[0]).join("").toUpperCase() || null;
}

export function parsePosixTZ(date) {
  return parsePosixTZText(process.env.TZ || "", date);
}

export function parsePosixTZText(tz, date = new Date()) {
  const bareZones = {
    UTC: { offsetSeconds: 0, name: "UTC" },
    GMT: { offsetSeconds: 0, name: "GMT" },
    Zulu: { offsetSeconds: 0, name: "Zulu" },
    CET: { offsetSeconds: 3600, name: "CET" },
    EST: { offsetSeconds: -5 * 3600, name: "EST" },
  };
  if (bareZones[tz]) return bareZones[tz];
  if (/^UTC0$/i.test(tz)) return { offsetSeconds: 0, name: "UTC" };
  if (/^PST8$/.test(tz)) return { offsetSeconds: -8 * 3600, name: "PST" };
  if (/^PST8PDT/.test(tz)) return { offsetSeconds: -7 * 3600, name: "PDT" };
  const match = tz.match(/^([A-Za-z]{3,})([+-])?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) return null;
  const [, name, sign = "+", hours, minutes = "0", seconds = "0"] = match;
  const raw = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return { offsetSeconds: sign === "-" ? raw : -raw, name };
}

export function formatZoneOffset(offsetSeconds) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const sign = offsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSeconds);
  const hh = Math.trunc(abs / 3600);
  const mm = Math.trunc(abs / 60) % 60;
  const ss = abs % 60;
  return `${sign}${pad2(hh)}${pad2(mm)}${pad2(ss)}`;
}

export function isoWeek(date, utc = false) {
  const d = new Date(date.getTime());
  const getDay = utc ? "getUTCDay" : "getDay";
  const getFullYear = utc ? "getUTCFullYear" : "getFullYear";
  const getMonth = utc ? "getUTCMonth" : "getMonth";
  const getDate = utc ? "getUTCDate" : "getDate";
  const setDate = utc ? "setUTCDate" : "setDate";
  const weekDay = d[getDay]() || 7;
  d[setDate](d[getDate]() + 4 - weekDay);
  const weekYear = d[getFullYear]();
  const yearStart = utc ? new Date(Date.UTC(weekYear, 0, 1)) : new Date(weekYear, 0, 1);
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { week, year: weekYear };
}

export function formatZoneColon(zoneText, precision) {
  const sign = zoneText[0];
  const hh = zoneText.slice(1, 3);
  const mm = zoneText.slice(3, 5);
  const ss = zoneText.slice(5, 7) || "00";
  if (precision === 1) return `${sign}${hh}:${mm}`;
  if (precision === 2) return `${sign}${hh}:${mm}:${ss}`;
  if (ss !== "00") return `${sign}${hh}:${mm}:${ss}`;
  return mm === "00" ? `${sign}${hh}` : `${sign}${hh}:${mm}`;
}

export function strftime(date, format, utc = false, options = {}) {
  const p = dateParts(date, utc);
  const calendar = options.gregorian ? null : dateLocaleCalendar(p);
  const displayYear = calendar?.year ?? p.year;
  const displayMonth = calendar?.month ?? p.month;
  const displayShortMonth = calendar?.shortMonth ?? p.shortMonth;
  const iso = isoWeek(date, utc);
  const expand = (spec) => ({
    "%": "%",
    ":z": formatZoneColon(p.zoneText, 1),
    "::z": formatZoneColon(p.zoneText, 2),
    ":::z": formatZoneColon(p.zoneText, 3),
    a: p.shortDay,
    A: p.day,
    b: displayShortMonth,
    B: displayMonth,
    C: String(Math.trunc(displayYear / 100)).padStart(2, "0"),
    c: `${p.shortDay} ${displayShortMonth} ${String(p.dayOfMonth).padStart(2, " ")} ${p.pad2(p.hours)}:${p.pad2(p.minutes)}:${p.pad2(p.seconds)} ${displayYear}`,
    d: p.pad2(p.dayOfMonth),
    D: `${p.pad2(p.monthIndex + 1)}/${p.pad2(p.dayOfMonth)}/${p.pad2(displayYear % 100)}`,
    e: String(p.dayOfMonth).padStart(2, " "),
    F: `${displayYear}-${p.pad2(p.monthIndex + 1)}-${p.pad2(p.dayOfMonth)}`,
    g: p.pad2(iso.year % 100),
    G: String(iso.year),
    h: displayShortMonth,
    H: p.pad2(p.hours),
    I: p.pad2((p.hours % 12) || 12),
    j: String(p.yday).padStart(3, "0"),
    k: String(p.hours).padStart(2, " "),
    l: String((p.hours % 12) || 12).padStart(2, " "),
    m: p.pad2(p.monthIndex + 1),
    M: p.pad2(p.minutes),
    n: "\n",
    N: String(p.nanoseconds ?? p.milliseconds * 1_000_000).padStart(9, "0"),
    p: p.hours < 12 ? "AM" : "PM",
    P: p.hours < 12 ? "am" : "pm",
    q: String(Math.floor(p.monthIndex / 3) + 1),
    r: `${p.pad2((p.hours % 12) || 12)}:${p.pad2(p.minutes)}:${p.pad2(p.seconds)} ${p.hours < 12 ? "AM" : "PM"}`,
    R: `${p.pad2(p.hours)}:${p.pad2(p.minutes)}`,
    s: String(Math.floor(date.getTime() / 1000)),
    S: p.pad2(p.seconds),
    t: "\t",
    T: `${p.pad2(p.hours)}:${p.pad2(p.minutes)}:${p.pad2(p.seconds)}`,
    u: String(p.weekDay || 7),
    U: weekNumber(date, utc, 0),
    V: p.pad2(iso.week),
    w: String(p.weekDay),
    W: weekNumber(date, utc, 1),
    x: `${p.pad2(p.monthIndex + 1)}/${p.pad2(p.dayOfMonth)}/${p.pad2(p.year % 100)}`,
    X: `${p.pad2(p.hours)}:${p.pad2(p.minutes)}:${p.pad2(p.seconds)}`,
    y: p.pad2(displayYear % 100),
    Y: String(displayYear),
    z: p.zoneText.slice(0, 5),
    Z: p.zoneName,
  })[spec];
  return format.replace(/%([-_0^#+]*)(\d+)?([EO](?::){1,3}z|[EO].|(?::){1,3}z|.)/gs, (match, flags, widthText, rawSpec) => {
    const spec = /^[EO]./s.test(rawSpec) ? rawSpec.slice(1) : rawSpec;
    if (rawSpec === "%" && (flags || widthText != null)) return formatDateUnknownDirective(match, flags, widthText == null ? null : Number(widthText));
    if (spec === "N") return formatDateNanoseconds(p, flags, widthText == null ? null : Number(widthText));
    const value = expand(spec);
    if (value == null) return formatDateUnknownDirective(match, flags, widthText == null ? null : Number(widthText));
    return applyDateFormatFlags(value, flags, widthText == null ? null : Number(widthText), spec);
  });
}

export function formatDateUnknownDirective(token, flags = "", width = null) {
  if (flags.includes("-")) return token;
  const targetWidth = token.endsWith("%") ? width + 1 : width;
  if (width == null || !Number.isFinite(width) || token.length >= targetWidth) return token;
  const pad = flags.includes("0") && !flags.includes("-") ? "0" : " ";
  return token.padStart(targetWidth, pad);
}

export function formatDateNanoseconds(parts, flags = "", width = null) {
  const value = String(parts.nanoseconds ?? parts.milliseconds * 1_000_000).padStart(9, "0");
  if (width == null || !Number.isFinite(width)) return value;
  if (width <= value.length) return value.slice(0, Math.max(0, width));
  if (flags.includes("-")) return value;
  const pad = flags.includes("_") && !flags.includes("0") ? " " : "0";
  return value.padEnd(width, pad);
}

export function weekNumber(date, utc, firstDay) {
  const p = dateParts(date, utc);
  const yearStart = utc ? new Date(Date.UTC(p.year, 0, 1)) : new Date(p.year, 0, 1);
  const startWeekday = utc ? yearStart.getUTCDay() : yearStart.getDay();
  const firstWeekStart = (7 + firstDay - startWeekday) % 7;
  const yday = p.yday - 1;
  const week = yday < firstWeekStart ? 0 : Math.floor((yday - firstWeekStart) / 7) + 1;
  return String(week).padStart(2, "0");
}

export function applyDateFormatFlags(value, flags = "", width = null, spec = "") {
  let out = String(value);
  const defaultWidth = out.length;
  if (flags.includes("^") && spec !== "P") out = out.toUpperCase();
  if (flags.includes("#")) {
    if ("aAbBh".includes(spec)) out = out.toUpperCase();
    else if (spec === "p" || spec === "P") out = out.toLowerCase();
  }
  if (flags.includes("-") && !flags.includes("_") && !flags.includes("0")) return stripDateNumericPadding(out);
  if (flags.includes("+") && "yCY".includes(spec) && width != null && width > defaultWidth && /^[+-]?\d+$/.test(out) && !out.startsWith("-") && !out.startsWith("+")) out = `+${out}`;
  if (flags.includes("_") && !flags.includes("0")) out = stripDateNumericPadding(out);
  if (flags.includes("0")) out = out.replace(/^ +(?=\d)/, (spaces) => "0".repeat(spaces.length));
  const targetWidth = width ?? defaultWidth;
  if (!Number.isFinite(targetWidth) || targetWidth <= out.length) return out;
  const pad = flags.includes("_") && !flags.includes("0") || !dateFieldDefaultsToZeroPadding(spec, out) ? " " : "0";
  return padDateField(out, targetWidth, pad, pad === "0" && datePadAfterSign(spec, out));
}

export function dateFieldDefaultsToZeroPadding(spec, value) {
  return /^[+-]?\d+$/.test(value) || spec.endsWith("z");
}

export function stripDateNumericPadding(value) {
  if (/^-?0+\d+$/.test(value)) return value.replace(/^(-?)0+(\d.*)$/, "$1$2");
  if (/^ +\d+$/.test(value)) return value.trimStart();
  return value;
}

export function datePadAfterSign(spec, value) {
  return /^[+-]/.test(value) && (spec === "s" || spec === "y" || spec === "Y" || spec === "C" || spec.endsWith("z"));
}

export function padDateField(value, width, pad, afterSign = false) {
  if (!afterSign || value.length >= width || !/^[+-]/.test(value)) return value.padStart(width, pad);
  return `${value[0]}${value.slice(1).padStart(width - 1, pad)}`;
}

export function parseDateInput(input, utc = false, allowRelative = true) {
  input = normalizeDateInput(stripDateComments(String(input))).trim();
  input = input.replace(/\s+UTC$/i, "Z");
  if (/^TZ=(?!")\S+(?:\s|$)/.test(input)) return new Date(Number.NaN);
  if (input === "") return todayAt(0, 0, 0, 0, utc);
  const european = parseEuropeanDateInput(input, utc);
  if (european) return european;
  const monthName = parseMonthNameDateInput(input, utc);
  if (monthName) return monthName;
  const compact = parseCompactDateInput(input, utc);
  if (compact) return compact;
  const hourOnly = parseHourOnlyDateInput(input, utc);
  if (hourOnly) return hourOnly;
  const explicitTimezone = parseExplicitTimezoneDateInput(input);
  if (explicitTimezone) return explicitTimezone;
  const namedZoneTime = parseNamedZoneTimeInput(input);
  if (namedZoneTime) return namedZoneTime;
  const militaryTime = parseMilitaryTimeZoneInput(input);
  if (militaryTime) return militaryTime;
  const militaryZoneDate = parseMilitaryZoneDateInput(input);
  if (militaryZoneDate) return militaryZoneDate;
  const slashMilitaryZoneDate = parseSlashMilitaryZoneDateInput(input);
  if (slashMilitaryZoneDate) return slashMilitaryZoneDate;
  const localZoneAbbrev = parseLocalZoneAbbreviationDateInput(input, utc);
  if (localZoneAbbrev) return localZoneAbbrev;
  const absolute = parseAbsoluteDateInput(input, utc);
  if (absolute) return absolute;
  const epoch = input.match(/^@(-?\d+)(?:\.(\d+))?$/);
  if (epoch) {
    const [, secondsText, fractionText = ""] = epoch;
    const nanoseconds = dateFractionNanoseconds(fractionText);
    return attachDateNanoseconds(new Date(Number(`${secondsText}.${fractionText || "0"}`) * 1000), nanoseconds);
  }
  if (String(input).trim().toLowerCase() === "now") return new Date();
  if (String(input).trim().toLowerCase() === "yesterday") return new Date(Date.now() - 86400 * 1000);
  if (String(input).trim().toLowerCase() === "tomorrow") return new Date(Date.now() + 86400 * 1000);
  const weekday = allowRelative ? parseWeekdayDateSpec(input, utc) : null;
  if (weekday) return weekday;
  const timeTodayRelative = allowRelative ? parseTimeTodayRelativeDateSpec(input) : null;
  if (timeTodayRelative) return timeTodayRelative;
  const absoluteRelative = allowRelative ? parseAbsoluteRelativeDateSpec(input, utc) : null;
  if (absoluteRelative) return absoluteRelative;
  const relative = allowRelative ? parseRelativeDateSpec(input, new Date(), utc) : null;
  if (relative) return relative;
  const timeZoneOnly = String(input).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([+-])(\d{2})(\d{2})$/);
  if (timeZoneOnly) {
    const [, hhText, mmText, ssText, sign, zoneHoursText, zoneMinutesText] = timeZoneOnly;
    const now = new Date();
    const hours = Number(hhText);
    const minutes = Number(mmText);
    const seconds = Number(ssText ?? "0");
    const offsetMinutes = (Number(zoneHoursText) * 60 + Number(zoneMinutesText)) * (sign === "+" ? 1 : -1);
    if (hours > 23 || minutes > 59 || seconds > 60) return new Date(Number.NaN);
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, Math.min(seconds, 59)) - offsetMinutes * 60000 + (seconds === 60 ? 1000 : 0));
  }
  return parseFractionalDateInput(input);
}

export function parseWeekdayDateSpec(spec, utc = false) {
  const match = String(spec).trim().match(/^(?:(this|next|last)\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/i);
  if (!match) return null;
  const [, direction = "", dayText] = match;
  const target = weekdayIndex(dayText);
  const nowParts = dateParts(new Date(), utc);
  const base = zonedDate(nowParts.year, nowParts.monthIndex + 1, nowParts.dayOfMonth, 0, 0, 0, 0, utc);
  const forward = (target - nowParts.weekDay + 7) % 7;
  if (direction.toLowerCase() === "next") return applyDateRelative(base, forward || 7, "day", String(forward || 7), 1, utc);
  if (direction.toLowerCase() === "last") {
    const backward = (nowParts.weekDay - target + 7) % 7 || 7;
    return applyDateRelative(base, -backward, "day", String(backward), -1, utc);
  }
  return applyDateRelative(base, forward, "day", String(forward), 1, utc);
}

export function weekdayIndex(dayText) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(String(dayText).slice(0, 3).toLowerCase());
}

export function parseAbsoluteDateInput(input, utc = false, timezone = null) {
  const match = String(input).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?((?:Z|[+-]\d{2}(?::?\d{2})?)?)$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0", , fractionText = "", zone = ""] = match;
  if (zone) return parseFractionalDateInput(input);
  const tz = timezone ?? (utc ? { offsetSeconds: 0 } : parsePosixTZ(new Date()));
  if (!tz) return dateFromParts({ yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, utc: false });
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60) return new Date(Number.NaN);
  const milliseconds = Number(fractionText.padEnd(3, "0").slice(0, 3) || "0");
  const time = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59), milliseconds) - tz.offsetSeconds * 1000 + (second === 60 ? 1000 : 0);
  const date = new Date(time);
  const nanoseconds = fractionText ? dateFractionNanoseconds(fractionText) : milliseconds * 1_000_000;
  return attachDateNanoseconds(date, nanoseconds);
}

export function parseEuropeanDateInput(input, utc = false) {
  const datePattern = "(\\d{1,2})\\.(\\d{1,2})\\.(?:(\\d{4}))?";
  const timePattern = "(\\d{1,2})(?::(\\d{1,2})(?::(\\d{1,2})([.,](\\d+))?)?)?";
  const dateFirst = String(input).match(new RegExp(`^${datePattern}(?:\\s+${timePattern})?$`));
  const timeFirst = String(input).match(new RegExp(`^${timePattern}\\s+${datePattern}$`));
  if (dateFirst) {
    const [, dayText, monthText, yearText, hourText = "0", minuteText = "0", secondText = "0", , fractionText = ""] = dateFirst;
    return dateFromParts({ yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, utc });
  }
  if (timeFirst) {
    const [, hourText = "0", minuteText = "0", secondText = "0", , fractionText = "", dayText, monthText, yearText] = timeFirst;
    return dateFromParts({ yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, utc });
  }
  return null;
}

export function parseMonthNameDateInput(input, utc = false) {
  const match = String(input).match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?\s+(\d{4})(?:\s*([A-IK-Z]))?$/i);
  if (!match) return null;
  const [, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0", , fractionText = "", yearText, zoneText] = match;
  const month = monthNumber(monthText);
  if (month == null) return null;
  if (zoneText) {
    const offsetHours = militaryZoneOffsetHours(zoneText);
    if (offsetHours == null) return null;
    return parseAbsoluteDateInput(`${yearText}-${month}-${dayText} ${hourText}:${minuteText.padStart(2, "0")}:${secondText.padStart(2, "0")}${fractionText ? `.${fractionText}` : ""}`, false, { offsetSeconds: offsetHours * 3600 });
  }
  return dateFromParts({ yearText, monthText: String(month), dayText, hourText, minuteText, secondText, fractionText, utc });
}

export function monthNumber(monthText) {
  const index = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(monthText).slice(0, 3).toLowerCase());
  return index < 0 ? null : index + 1;
}

export function parseCompactDateInput(input, utc = false) {
  const match = String(input).match(/^(?:(\d{4})|(\d{2}))(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, fullYearText, shortYearText, monthText, dayText] = match;
  const year = fullYearText == null ? Number(shortYearText) + (Number(shortYearText) >= 69 ? 1900 : 2000) : Number(fullYearText);
  return dateFromParts({ yearText: String(year), monthText, dayText, utc });
}

export function parseHourOnlyDateInput(input, utc = false) {
  const match = String(input).match(/^(\d{1,2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return todayAt(hour, 0, 0, 0, utc);
}

export function parseExplicitTimezoneDateInput(input) {
  const match = String(input).match(/^TZ="([^"]*)"\s+(.+)$/);
  if (!match) return null;
  const timezoneText = match[1];
  const timezone = parsePosixTZText(timezoneText);
  if (!timezone && timezoneText.includes("/")) {
    const absolute = parseIanaTimezoneDateInput(match[2], timezoneText);
    if (absolute) return absolute;
    return parseExplicitTimezoneRelativeDateInput(match[2], timezoneText, null);
  }
  if (!timezone) return null;
  const absolute = parseAbsoluteDateInput(match[2], false, timezone);
  if (absolute) return absolute;
  const relative = parseExplicitTimezoneRelativeDateInput(match[2], null, timezone);
  if (relative) return relative;
  return null;
}

export function parseExplicitTimezoneRelativeDateInput(input, timeZone, timezone) {
  const match = String(input).match(/^(?:[A-Za-z]+,\s*)?(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?\s+(.+)$/);
  if (!match) return null;
  const [, rawYearText, monthText, dayText, hourText = "0", minuteText = "00", secondText = "00", , fractionText = "", relativeText] = match;
  const yearText = rawYearText.length === 2 ? String(Number(rawYearText) + (Number(rawYearText) >= 69 ? 1900 : 2000)) : rawYearText;
  const baseText = `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondText}${fractionText ? `.${fractionText}` : ""}`;
  let date = timeZone ? parseIanaTimezoneDateInput(baseText, timeZone) : parseAbsoluteDateInput(baseText, false, timezone);
  if (!date || Number.isNaN(date.getTime())) return date;
  const parts = parseDateRelativeTerms(relativeText);
  if (!parts) return null;
  for (const part of parts) date = applyDateRelative(date, part.amount, part.unit, part.amountText, 1, true);
  return date;
}

export function parseDateRelativeTerms(text) {
  const parts = [];
  let offset = 0;
  const pattern = /\s*([+-]?\s*\d+(?:\.\d+)?)\s+(secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|months?|years?)\b/ig;
  let match;
  while ((match = pattern.exec(String(text))) !== null) {
    if (String(text).slice(offset, match.index).trim() !== "") return null;
    const amountText = match[1].replace(/\s+/g, "");
    parts.push({ amount: Number(amountText), amountText, unit: normalizeDateRelativeUnit(match[2]) });
    offset = pattern.lastIndex;
  }
  if (!parts.length || String(text).slice(offset).trim() !== "") return null;
  return parts;
}

export function parseIanaTimezoneDateInput(input, timeZone) {
  const match = String(input).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0", , fractionText = ""] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60) return new Date(Number.NaN);
  const milliseconds = Number(fractionText.padEnd(3, "0").slice(0, 3) || "0");
  const target = { year, month, day, hour, minute, second: Math.min(second, 59) };
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59), milliseconds);
  let candidate = baseUtc;
  let formatter;
  try {
    formatter = ianaDateFormatter(timeZone);
  } catch {
    return null;
  }
  for (let i = 0; i < 4; i++) {
    const seen = ianaDateParts(formatter, new Date(candidate));
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, milliseconds) - candidate;
    const next = baseUtc - offset;
    if (next === candidate) break;
    candidate = next;
  }
  const seen = ianaDateParts(formatter, new Date(candidate));
  if (!sameIanaWallTime(seen, target)) return new Date(Number.NaN);
  const date = new Date(candidate + (second === 60 ? 1000 : 0));
  return attachDateNanoseconds(date, fractionText ? dateFractionNanoseconds(fractionText) : milliseconds * 1_000_000);
}

export function ianaDateFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ianaDateParts(formatter, date) {
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

export function sameIanaWallTime(actual, expected) {
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day && actual.hour === expected.hour && actual.minute === expected.minute && actual.second === expected.second;
}

export function parseNamedZoneTimeInput(input) {
  const match = String(input).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;
  const [, hourText, minuteText, secondText = "0", sign, zoneHourText, zoneMinuteText = "0"] = match;
  const hours = Number(hourText);
  const minutes = Number(minuteText);
  const seconds = Number(secondText);
  if (hours > 23 || minutes > 59 || seconds > 60) return new Date(Number.NaN);
  const offsetSeconds = (Number(zoneHourText) * 3600 + Number(zoneMinuteText) * 60) * (sign === "+" ? 1 : -1);
  const now = new Date();
  const time = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, Math.min(seconds, 59)) - offsetSeconds * 1000 + (seconds === 60 ? 1000 : 0);
  return new Date(time);
}

export function parseMilitaryTimeZoneInput(input) {
  const match = String(input).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?([A-IK-Z])$/i);
  if (!match) return null;
  const [, hourText, minuteText, secondText = "0", zoneText] = match;
  const hours = Number(hourText);
  const minutes = Number(minuteText);
  const seconds = Number(secondText);
  if (hours > 23 || minutes > 59 || seconds > 60) return new Date(Number.NaN);
  const offsetHours = militaryZoneOffsetHours(zoneText);
  if (offsetHours == null) return null;
  const now = new Date();
  const time = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, Math.min(seconds, 59)) - offsetHours * 3600 * 1000 + (seconds === 60 ? 1000 : 0);
  return new Date(time);
}

export function parseMilitaryZoneDateInput(input) {
  const match = String(input).match(/^(\d{4}-\d{1,2}-\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?\s*([A-IK-Z])$/i);
  if (!match) return null;
  const [, dateText, hourText = "0", minuteText = "00", secondText = "00", , fractionText = "", zoneText] = match;
  const offsetHours = militaryZoneOffsetHours(zoneText);
  if (offsetHours == null) return null;
  return parseAbsoluteDateInput(`${dateText} ${hourText}:${minuteText}:${secondText}${fractionText ? `.${fractionText}` : ""}`, false, { offsetSeconds: offsetHours * 3600 });
}

export function parseSlashMilitaryZoneDateInput(input) {
  const match = String(input).match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})([.,](\d+))?)?)?\s*([A-IK-Z])$/i);
  if (!match) return null;
  const [, firstText, secondText, thirdText, hourText = "0", minuteText = "00", secondTimeText = "00", , fractionText = "", zoneText] = match;
  const yearText = firstText.length === 4 ? firstText : thirdText;
  const monthText = firstText.length === 4 ? secondText : firstText;
  const dayText = firstText.length === 4 ? thirdText : secondText;
  if (yearText.length !== 4) return null;
  const offsetHours = militaryZoneOffsetHours(zoneText);
  if (offsetHours == null) return null;
  return parseAbsoluteDateInput(`${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondTimeText}${fractionText ? `.${fractionText}` : ""}`, false, { offsetSeconds: offsetHours * 3600 });
}

export function militaryZoneOffsetHours(zoneText) {
  const zone = String(zoneText).toUpperCase();
  const positive = "ABCDEFGHIKLM".indexOf(zone);
  const negative = "NOPQRSTUVWXY".indexOf(zone);
  return zone === "Z" ? 0 : positive >= 0 ? positive + 1 : negative >= 0 ? -(negative + 1) : null;
}

export function parseLocalZoneAbbreviationDateInput(input, utc = false) {
  if (utc) return null;
  const match = String(input).match(/^(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?)\s+([A-Za-z]{2,6})$/);
  if (!match) return null;
  const date = parseAbsoluteDateInput(match[1], false);
  if (!date || Number.isNaN(date.getTime())) return date;
  if (localZoneName(date).toLowerCase() !== match[2].toLowerCase()) return null;
  date.__bnuLocalZoneAbbrev = match[2];
  date.__bnuLocalOffsetSeconds = localOffsetSeconds(date);
  return date;
}

export function localOffsetSeconds(date) {
  return -date.getTimezoneOffset() * 60;
}

export function dateFromParts({ yearText, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0", fractionText = "", utc = false }) {
  const now = new Date();
  const year = yearText == null || yearText === "" ? (utc ? now.getUTCFullYear() : now.getFullYear()) : Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60) return new Date(Number.NaN);
  const milliseconds = Number(String(fractionText).replace(/^[.,]/, "").padEnd(3, "0").slice(0, 3) || "0");
  const date = zonedDate(year, month, day, hour, minute, Math.min(second, 59), milliseconds, utc);
  if (second === 60) date.setTime(date.getTime() + 1000);
  const fraction = String(fractionText).replace(/^[.,]/, "");
  return attachDateNanoseconds(date, fraction ? dateFractionNanoseconds(fraction) : milliseconds * 1_000_000);
}

export function todayAt(hour, minute, second, millisecond, utc = false) {
  const now = new Date();
  return zonedDate(utc ? now.getUTCFullYear() : now.getFullYear(), (utc ? now.getUTCMonth() : now.getMonth()) + 1, utc ? now.getUTCDate() : now.getDate(), hour, minute, second, millisecond, utc);
}

export function zonedDate(year, month, day, hour, minute, second, millisecond, utc = false) {
  if (utc) return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const tz = parsePosixTZ(new Date());
  if (tz) return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - tz.offsetSeconds * 1000);
  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

export function parseFractionalDateInput(input) {
  const match = String(input).match(/^(.+\d{1,2}:\d{2}:\d{2})([.,](\d+))((?:Z|[+-]\d{2}(?::?\d{2})?)?)$/);
  if (isYearFirstMonthNameDateInput(input)) return new Date(Number.NaN);
  if (!match) return new Date(input);
  const [, prefix, separator, fraction, zone] = match;
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const date = new Date(`${prefix}${separator}${milliseconds}${zone}`);
  return attachDateNanoseconds(date, dateFractionNanoseconds(fraction));
}

export function isYearFirstMonthNameDateInput(input) {
  const match = String(input).match(/^(\d{4})\s+([A-Za-z]+)\s+\d{1,2}\b/);
  return Boolean(match && monthNumber(match[2]) != null);
}

export function dateFractionNanoseconds(fraction) {
  return Number(String(fraction || "").padEnd(9, "0").slice(0, 9));
}

export function normalizeDateInput(input) {
  return input.replace(/(T\d{1,2}:\d{2}:\d{2})([+-])(\d{1,2})$/, (_, time, sign, hour) => `${time}${sign}${String(hour).padStart(2, "0")}:00`);
}

export function stripDateComments(input) {
  let depth = 0;
  let output = "";
  for (const ch of String(input)) {
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) output += ch;
  }
  return output;
}

export function lsTimeText(date, opts) {
  const style = opts["time-style"];
  if (typeof style === "string" && style.startsWith("+")) return strftime(date, style.slice(1));
  if (style === "full-iso" || style === "posix-full-iso") return lsFullIsoTime(date);
  if (style === "iso" || style === "posix-iso") return `${strftime(date, "%F")} `;
  if (style === "long-iso" || style === "posix-long-iso") return strftime(date, "%F %R");
  if (style == null || style === "locale" || style === "posix-locale") {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = Date.now();
    const sixMonthsMs = 365.2425 * 24 * 60 * 60 * 1000 / 2;
    const recent = date.getTime() <= now && date.getTime() >= now - sixMonthsMs;
    return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${recent ? strftime(date, "%H:%M") : ` ${date.getFullYear()}`}`;
  }
  return strftime(date, "%F %R");
}

export function lsFullIsoTime(date) {
  return strftime(date, "%F %T.%N %z");
}

export function parseGNUBlockSizeEnv(value, defaultSize) {
  return parseGNUBlockSizeEnvInfo(value, defaultSize).size;
}

export function parseRelativeDateSpec(spec, base, utc = false) {
  const match = String(spec).trim().match(/^([+-]?\s*\d+(?:\.\d+)?)\s+(secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|months?|years?)(?:\s+(ago))?$/i);
  if (!match) return null;
  const amountText = match[1].replace(/\s+/g, "");
  const amount = Number(amountText) * (match[3] ? -1 : 1);
  const unit = normalizeDateRelativeUnit(match[2]);
  return applyDateRelative(base, amount, unit, amountText, match[3] ? -1 : 1, utc);
}

export function normalizeDateRelativeUnit(unitText) {
  const unit = unitText.toLowerCase().replace(/s$/, "");
  if (unit === "sec") return "second";
  if (unit === "min") return "minute";
  return unit;
}

export function applyDateRelative(base, amount, unit, amountText = String(amount), direction = 1, utc = false) {
  if (unit === "month" || unit === "year") {
    const next = new Date(base);
    if (unit === "month") utc ? next.setUTCMonth(next.getUTCMonth() + amount) : next.setMonth(next.getMonth() + amount);
    else utc ? next.setUTCFullYear(next.getUTCFullYear() + amount) : next.setFullYear(next.getFullYear() + amount);
    if (!utc && base.__bnuLocalZoneAbbrev && base.__bnuLocalOffsetSeconds != null) {
      const offsetDelta = localOffsetSeconds(next) - base.__bnuLocalOffsetSeconds;
      if (offsetDelta) next.setTime(next.getTime() + offsetDelta * 1000);
    }
    return next;
  }
  const seconds = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }[unit];
  const deltaNanoseconds = decimalSecondsToNanoseconds(amountText, seconds) * BigInt(direction);
  const baseNanoseconds = BigInt(base.getTime()) * 1_000_000n + BigInt((base.__bnuNanoseconds ?? base.getMilliseconds() * 1_000_000) - base.getMilliseconds() * 1_000_000);
  const totalNanoseconds = baseNanoseconds + deltaNanoseconds;
  const milliseconds = floorDivBigInt(totalNanoseconds, 1_000_000n);
  const nanoseconds = Number(((totalNanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n);
  return attachDateNanoseconds(new Date(Number(milliseconds)), nanoseconds);
}

export function decimalSecondsToNanoseconds(amountText, unitSeconds) {
  const text = String(amountText);
  const sign = text.startsWith("-") ? -1n : 1n;
  const unsigned = text.replace(/^[+-]/, "");
  const [wholeText, fractionText = ""] = unsigned.split(".");
  const whole = BigInt(wholeText || "0") * BigInt(unitSeconds) * 1_000_000_000n;
  const fraction = BigInt(fractionText.padEnd(9, "0").slice(0, 9) || "0") * BigInt(unitSeconds);
  return sign * (whole + fraction);
}

export function parseAbsoluteRelativeDateSpec(spec, utc = false) {
  const text = String(spec).trim();
  const keyword = text.match(/^(.+?)\s+(now|yesterday|tomorrow|this\s+(?:secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|months?|years?)|next\s+(?:secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|months?|years?))$/i);
  if (keyword) {
    const base = parseDateInput(keyword[1], utc, false);
    if (Number.isNaN(base.getTime())) return null;
    const suffix = keyword[2].toLowerCase();
    if (suffix === "now") return base;
    if (suffix === "yesterday") return applyDateRelative(base, -1, "day", "1", -1, utc);
    if (suffix === "tomorrow") return applyDateRelative(base, 1, "day", "1", 1, utc);
    const [, direction, unitText] = suffix.match(/^(this|next)\s+(.+)$/);
    return direction === "this" ? base : applyDateRelative(base, 1, normalizeDateRelativeUnit(unitText), "1", 1, utc);
  }
  const match = text.match(/^(.+?)\s+([+-]?\s*\d+(?:\.\d+)?\s+(?:secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|months?|years?)(?:\s+ago)?)$/i);
  if (!match) return null;
  const base = parseDateInput(match[1], utc, false);
  if (Number.isNaN(base.getTime())) return null;
  return parseRelativeDateSpec(match[2], base, utc);
}

export function parseTimeTodayRelativeDateSpec(spec) {
  const match = String(spec).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+today\s+([+-]\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/i);
  if (!match) return null;
  const [, hoursText, minutesText, secondsText, amountText, unitText] = match;
  const base = new Date();
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 60) return new Date(Number.NaN);
  base.setHours(hours, minutes, Math.min(seconds, 59), 0);
  if (seconds === 60) base.setSeconds(base.getSeconds() + 1);
  return parseRelativeDateSpec(`${amountText} ${unitText}`, base);
}
