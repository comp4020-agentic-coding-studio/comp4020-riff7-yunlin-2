import type { APIRoute } from "astro";
import { ConflictError, ValidationError, addBooking, listRooms } from "../../lib/db";
import { bus } from "../../lib/events";

// The board's own display and overlap logic both string-compare date/time
// values assuming YYYY-MM-DD / HH:MM shape (see src/lib/schema.ts and
// src/pages/index.astro's isNowWithin) — the HTML form's date/time inputs
// only ever send that shape, but the API boundary itself has to enforce it
// too, since anything can POST here directly (this repo's own
// spec/booking.test.ts does, over plain fetch). Without this, a crafted
// request can write a row the rest of the app can't render or reason about.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// The write half of the board: a plain HTML form POSTs here. On success the
// new booking goes into SQLite and is broadcast to every open SSE
// connection; on a conflict or a bad time range nothing is written and the
// redirect carries an error code back to the form. The 303 redirect makes
// the whole flow work with no client-side JavaScript — the submitting tab
// re-renders from the database; only the cross-tab live refresh needs a
// script.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const date = String(form.get("date") ?? "");
  const startTime = String(form.get("startTime") ?? "");
  const endTime = String(form.get("endTime") ?? "");
  const bookedBy = String(form.get("bookedBy") ?? "").trim().slice(0, 80);
  const roomId = Number(form.get("roomId"));

  const back = (error?: string) =>
    redirect(`/?${new URLSearchParams({ date, ...(error ? { error } : {}) })}`, 303);

  if (!Number.isInteger(roomId) || !listRooms().some((room) => room.id === roomId)) return back("room");
  if (!bookedBy) return back("name");
  if (!DATE_RE.test(date)) return back("date");
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return back("invalid");

  try {
    const booking = addBooking({ roomId, date, startTime, endTime, bookedBy });
    bus.emit("booking", { date: booking.date });
  } catch (err) {
    if (err instanceof ValidationError) return back(err.code);
    if (err instanceof ConflictError) return back("conflict");
    throw err;
  }
  return back();
};
