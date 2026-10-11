// Next earnings report, from public/earnings.json (ci/scrape-earnings.mjs): { T: [date, hour] } with
// date "YYYY-MM-DD" and hour "bmo" | "amc" | "". Dates are calendar days, so they are compared as
// plain dates, never through a timezone.

export interface Earnings {
  date: string; // YYYY-MM-DD
  hour: string; // "bmo" before open, "amc" after close, "" unknown
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayYmd = (): string => ymd(new Date());

/** A file entry as the next report, or null when missing or already past (the file can be a day old). */
export function fromEntry(entry: unknown, today: string): Earnings | null {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry[0])) return null;
  if (entry[0] < today) return null;
  return { date: entry[0], hour: typeof entry[1] === "string" ? entry[1] : "" };
}

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const utc = (s: string): number => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

/** Pieces for the tile and the line: { mon: "NOV", day: "5", text: "Thu · after close · in 25 days" }. */
export function earningsParts(e: Earnings, today: string): { mon: string; day: string; text: string } {
  const t = utc(e.date);
  const d = new Date(t);
  const n = Math.round((t - utc(today)) / 864e5);
  const when = n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
  const hour = e.hour === "bmo" ? "before open" : e.hour === "amc" ? "after close" : "";
  return {
    mon: MON[d.getUTCMonth()],
    day: String(d.getUTCDate()),
    text: [DOW[d.getUTCDay()], hour, when].filter(Boolean).join(" · "),
  };
}
