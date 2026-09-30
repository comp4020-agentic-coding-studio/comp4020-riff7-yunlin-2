import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { canberraParts } from "./clock";
import { type Booking, type Room, bookings, rooms } from "./schema";

// One SQLite file is the app's whole persistent state. In production
// fly.toml points DATABASE_PATH at the machine's volume (/data), which is
// how state survives a reload and a redeploy; locally it defaults to an
// untracked file in .data/.
const path = process.env.DATABASE_PATH ?? "./.data/app.db";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path);
client.pragma("journal_mode = WAL");

export const db = drizzle(client);

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

// The rooms themselves aren't something a booking app's users create — they're
// the fixed slice of the real system this prototype stands in for (a handful
// of ANU Library group study rooms). Seeded once, on whichever machine boots
// first against an empty database; never re-seeded once a room exists, so a
// deploy never resets what's already there.
const SEEDED_ROOMS = ["Hancock — Group Room 1", "Hancock — Group Room 2", "Chifley — Group Room 3"];
if (db.select().from(rooms).limit(1).all().length === 0) {
  for (const name of SEEDED_ROOMS) db.insert(rooms).values({ name }).run();
}

export type { Booking, Room };

export class ConflictError extends Error {}

// `code` lets a caller (src/pages/api/bookings.ts) show the right message
// without parsing `.message` — it defaults to "invalid" so every existing
// throw site that doesn't pass one keeps working unchanged.
export class ValidationError extends Error {
  code: string;
  constructor(message: string, code = "invalid") {
    super(message);
    this.code = code;
  }
}

export function listRooms(): Room[] {
  return db.select().from(rooms).orderBy(rooms.id).all();
}

export function listBookingsForDate(date: string): Booking[] {
  return db.select().from(bookings).where(eq(bookings.date, date)).orderBy(bookings.startTime).all();
}

function overlaps(a: { startTime: string; endTime: string }, b: Booking): boolean {
  return a.startTime < b.endTime && a.endTime > b.startTime;
}

interface NewBooking {
  roomId: number;
  date: string;
  startTime: string;
  endTime: string;
  bookedBy: string;
}

// Runs the whole check-then-insert as one call: better-sqlite3's calls are
// synchronous, so nothing else touches the database between the read and the
// write, which is what makes the overlap check race-free without a separate
// SQL constraint.
export function addBooking(candidate: NewBooking): Booking {
  // A room can't be booked in the past — checked here, not just by hiding the
  // date-nav or graying out a slot, since a crafted POST reaches this
  // function directly regardless of what the board's own date-nav shows.
  if (candidate.date < canberraParts(new Date()).date) {
    throw new ValidationError("cannot book a date that has already passed", "past");
  }
  if (!(candidate.startTime < candidate.endTime)) {
    throw new ValidationError("end time must be after start time");
  }
  const sameRoomAndDay = db
    .select()
    .from(bookings)
    .where(and(eq(bookings.roomId, candidate.roomId), eq(bookings.date, candidate.date)))
    .all();
  if (sameRoomAndDay.some((existing) => overlaps(candidate, existing))) {
    throw new ConflictError("room already booked for part of this time");
  }
  return db.insert(bookings).values(candidate).returning().get();
}

/** Returns the deleted booking's own date, or null if no booking with that id existed. */
export function cancelBooking(id: number): string | null {
  const removed = db.delete(bookings).where(eq(bookings.id, id)).returning().all();
  return removed[0]?.date ?? null;
}

// Riff: check-in. The real annoyance this README names — no way to tell
// from the booking system alone whether anyone's actually turned up — isn't
// closed by the "happening now" highlight alone, since that's true whether
// or not anyone showed. Recording a confirmation is the other half.
// Returns the checked-in booking's own date, or null if no booking with
// that id existed.
export function checkInBooking(id: number): string | null {
  const existing = db.select().from(bookings).where(eq(bookings.id, id)).get();
  if (!existing) return null;
  // The board only renders "I'm here" for a booking that's active right now
  // (src/pages/index.astro), but that's just which button shows — nothing
  // stopped a direct POST from confirming presence at a room hours before
  // anyone could plausibly be in it. Checked here so the claim a checked-in
  // badge makes ("someone is actually here") stays true regardless of how
  // the request arrived.
  const { date: today, time: nowTime } = canberraParts(new Date());
  const isActiveNow = existing.date === today && existing.startTime <= nowTime && nowTime < existing.endTime;
  if (!isActiveNow) {
    throw new ValidationError("can only check in to a booking that is happening right now", "checkin");
  }
  const updated = db
    .update(bookings)
    .set({ checkedInAt: sql`(datetime('now'))` })
    .where(eq(bookings.id, id))
    .returning()
    .all();
  return updated[0]?.date ?? null;
}

/** The first room with no booking overlapping the given window, or null if every room clashes. */
export function findFreeRoom(date: string, startTime: string, endTime: string): Room | null {
  const candidate = { startTime, endTime };
  const bookingsForDate = listBookingsForDate(date);
  return listRooms().find((room) => !bookingsForDate.some((b) => b.roomId === room.id && overlaps(candidate, b))) ?? null;
}
