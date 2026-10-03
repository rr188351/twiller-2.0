/**
 * IST (Asia/Kolkata) time helpers for Twiller 2.0.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The internship assignment has several time-window rules that must always be
 * evaluated in Indian Standard Time, regardless of where the server runs:
 *   - Feature 1: payment allowed only 10:00-11:00 IST
 *   - Feature 2: mobile access allowed only 10:00-13:00 IST
 *   - Feature 5: audio upload allowed only 14:00-19:00 IST
 *
 * A common beginner bug is to use `new Date().getHours()`, which returns the
 * SERVER's timezone. If the server runs in UTC, every window is wrong.
 * `Intl.DateTimeFormat` with an explicit `timeZone` gives the correct answer
 * with ZERO extra dependencies.
 *
 * NOTE: IST has no daylight saving, so a fixed +05:30 offset would also work,
 * but Intl is used here so the code stays correct and readable.
 */

const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330; // +05:30

/**
 * Returns the wall-clock parts of a date in IST.
 * @param {Date} [date] defaults to now
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
export function getIstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can return "24" for midnight in some engines; normalise it to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Current hour in IST (0-23).
 */
export function getIstHour(date = new Date()) {
  return getIstParts(date).hour;
}

/**
 * Current minute in IST (0-59).
 */
export function getIstMinute(date = new Date()) {
  return getIstParts(date).minute;
}

/**
 * Human readable IST clock, e.g. "10:07 IST".
 */
export function getIstTimeString(date = new Date()) {
  const { hour, minute } = getIstParts(date);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm} IST`;
}

/**
 * Builds a real UTC Date for a given IST wall-clock time. Useful for
 * calculating "expires at" moments so they are stored as real Dates in MongoDB.
 *
 * @param {number} istHour   hour in IST (0-23)
 * @param {number} istMinute minute in IST (0-59)
 * @param {number} [daysAhead=0] how many IST days to add
 * @param {number} [addMinutes=0] extra minutes to add
 */
export function istDateFromTime(istHour, istMinute, daysAhead = 0, addMinutes = 0) {
  const { year, month, day } = getIstParts();
  // Treat the IST wall clock as if it were UTC, then subtract the offset.
  const asUtc = Date.UTC(year, month - 1, day, istHour, istMinute, 0, 0);
  const target = new Date(asUtc - IST_OFFSET_MINUTES * 60 * 1000);
  target.setUTCDate(target.getUTCDate() + daysAhead);
  target.setUTCMinutes(target.getUTCMinutes() + addMinutes);
  return target;
}

/**
 * Checks whether a given moment falls inside an IST time window.
 * Windows that cross midnight (e.g. 22:00-06:00) are supported.
 *
 * @param {number} startHour  inclusive start hour in IST (0-23)
 * @param {number} endHour    exclusive end hour in IST (0-24)
 * @param {Date}   [date]
 * @returns {boolean}
 */
export function isWithinIstWindow(startHour, endHour, date = new Date()) {
  const hour = getIstHour(date);
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  // Window crosses midnight.
  return hour >= startHour || hour < endHour;
}

/**
 * Milliseconds until the next time the window opens.
 * Returns 0 when we are already inside the window.
 */
export function millisUntilNextIstWindow(startHour, endHour, date = new Date()) {
  if (isWithinIstWindow(startHour, endHour, date)) return 0;

  const { hour, minute } = getIstParts(date);
  const minutesNow = hour * 60 + minute;

  // Minutes until today's startHour. If that moment already passed, the next
  // opening is tomorrow's - so add one IST day.
  let diffMinutes = startHour * 60 - minutesNow;
  if (diffMinutes <= 0) diffMinutes += 24 * 60;

  return diffMinutes * 60 * 1000;
}

export default {
  IST_TIME_ZONE,
  IST_OFFSET_MINUTES,
  getIstParts,
  getIstHour,
  getIstMinute,
  getIstTimeString,
  istDateFromTime,
  isWithinIstWindow,
  millisUntilNextIstWindow,
};
