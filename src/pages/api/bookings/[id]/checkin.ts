import type { APIRoute } from "astro";
import { checkInBooking } from "../../../../lib/db";
import { bus } from "../../../../lib/events";

// Riff: the other half of "happening now" — a person on-site confirms it,
// rather than the board only ever inferring it from the clock. Same shape
// as cancel.ts: broadcast the booking's own stored date, not whatever the
// client's hidden form field claims.
export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = Number(params.id);
  const form = await request.formData();
  const date = String(form.get("date") ?? "");
  if (Number.isInteger(id)) {
    const affectedDate = checkInBooking(id);
    if (affectedDate) bus.emit("booking", { date: affectedDate });
  }
  return redirect(`/?${new URLSearchParams({ date })}`, 303);
};
