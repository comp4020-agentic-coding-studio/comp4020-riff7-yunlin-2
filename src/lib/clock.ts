export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// How many minutes of a booking have elapsed, for the check-in grace period
// (src/pages/index.astro) — only meaningful while the booking is today's and
// currently active; callers guard that themselves.
export function minutesSince(nowTime: string, pastTime: string): number {
  return toMinutes(nowTime) - toMinutes(pastTime);
}

// "Find me a room now": the end of a window starting now, or null if that
// window would run past midnight — a window crossing into tomorrow is out
// of scope for this riff, same call the rest of the board makes about not
// reasoning across a day boundary in wall-clock arithmetic.
export function addMinutesToTime(hhmm: string, minutes: number): string | null {
  const total = toMinutes(hhmm) + minutes;
  if (total > 24 * 60) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function canberraParts(d: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Canberra",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function shiftDate(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The "happening now" highlight (src/pages/index.astro's isNowWithin) is
// computed once, at render time, against `nowTime`. Nothing else on the page
// re-checks the wall clock, so a tab left open across a booking's start or
// end minute would keep showing that render's answer forever unless some
// other tab's booking happens to trigger the SSE reload first. This computes
// how long, in minutes, until the next such boundary today — the moment the
// page's own answer would go stale — so the client can schedule exactly one
// reload for then, rather than polling on an interval.
export function nextBoundaryDelayMinutes(nowTime: string, boundaries: string[]): number | null {
  const now = toMinutes(nowTime);
  const future = boundaries.map(toMinutes).filter((m) => m > now);
  return future.length > 0 ? Math.min(...future) - now : null;
}

// Shared with index.astro directly for a tab parked on *tomorrow*'s date
// view — the one boundary such a tab needs is the moment that date stops
// being tomorrow and becomes today.
export function minutesUntilMidnight(nowTime: string): number {
  return 24 * 60 - toMinutes(nowTime);
}

// A tab can be left open on a day with no booking boundaries left to wait
// for (the last one already passed, or there were never any today) — in
// which case nextBoundaryDelayMinutes alone schedules nothing, and the
// board's date-nav "(today)" label and its whole rendered date would stay
// stuck on the render's day forever once real midnight passes. This always
// finds a reload time within the next 24h by treating midnight itself as a
// boundary, so the day rolls over on its own even with nothing booked.
export function nextReloadDelayMinutes(nowTime: string, boundaries: string[]): number {
  const bookingDelay = nextBoundaryDelayMinutes(nowTime, boundaries);
  const untilMidnight = minutesUntilMidnight(nowTime);
  return bookingDelay === null ? untilMidnight : Math.min(bookingDelay, untilMidnight);
}

// The functions above compute a boundary as *minutes from now*, which
// quietly assumes a wall-clock minute is always a real minute — false on
// the two nights a year Canberra's clocks shift for daylight saving.
// Scheduling that many minutes with `setTimeout` fires up to an hour late
// (skipping the spring 2am→3am gap) or early (repeating the autumn 3am→2am
// hour) relative to the actual local instant it was meant to name — caught
// by computing the real epoch for a tab left open at 01:00 on 2026-10-04
// (this year's spring-forward date) and finding the naive midnight-delay
// landed an hour after real Canberra midnight had already passed.
//
// This instead resolves a Canberra wall-clock date+time to the real UTC
// instant it names, immune to that drift: Canberra only ever uses two
// offsets (AEST +10, AEDT +11), so try both candidate instants and keep
// whichever one's own Canberra rendering reads back as the requested
// date+time. Returns null only for a wall-clock time inside the hour the
// spring-forward transition skips (02:00–02:59 on that one date), which
// never occurs in real time at all.
export function canberraWallTimeToEpochMs(dateStr: string, hhmm: string): number | null {
  for (const offsetHours of [10, 11]) {
    const candidate = new Date(`${dateStr}T${hhmm}:00+${String(offsetHours).padStart(2, "0")}:00`).getTime();
    const rendered = canberraParts(new Date(candidate));
    if (rendered.date === dateStr && rendered.time === hhmm) return candidate;
  }
  return null;
}

// The absolute-epoch counterpart to nextReloadDelayMinutes, for a client to
// schedule against with `target - Date.now()` rather than a bare minute
// count — see src/pages/index.astro's nextBoundaryTarget.
export function nextReloadTargetEpochMs(date: string, nowTime: string, boundaries: string[]): number {
  const future = boundaries.filter((b) => b > nowTime).sort();
  for (const hhmm of future) {
    const target = canberraWallTimeToEpochMs(date, hhmm);
    if (target !== null) return target;
  }
  // Midnight always exists — Canberra's DST transitions happen at 2–3am,
  // never at 00:00 — so this never falls through to null.
  return canberraWallTimeToEpochMs(shiftDate(date, 1), "00:00")!;
}
