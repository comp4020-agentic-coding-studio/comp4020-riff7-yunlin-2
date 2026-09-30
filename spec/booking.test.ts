import { beforeAll, describe, expect, inject, it } from "vitest";

// This week's own spec: the brief's three checkable promises for a full-stack
// prototype — the core flow persists across a reload, a real annoyance the
// real system has (double-booking a room) can't happen here, and cancelling
// actually frees the slot — driven against the running app over HTTP, the
// same way the starter's own (now-removed) guestbook test did.
const baseUrl = inject("baseUrl");

// Astro checks form POSTs carry a same-origin Origin header (CSRF
// protection); browsers send it automatically, a bare fetch doesn't.
const post = (path: string, body: URLSearchParams) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl },
    body,
    redirect: "manual",
  });

const roomsPage = async (date: string) => {
  const res = await fetch(new URL(`/?date=${date}`, baseUrl));
  return res.text();
};

describe("booking a room", () => {
  const date = "2031-03-17";
  const bookedBy = `spec probe ${process.hrtime.bigint()}`;

  it("accepts a booking and redirects back to the board", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "09:00", endTime: "10:00", bookedBy }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "", baseUrl).pathname).toBe("/");
  });

  it("persists the booking: a fresh page load for that date includes it", async () => {
    expect(await roomsPage(date)).toContain(bookedBy);
  });

  it("rejects a second booking that overlaps the first", async () => {
    const clash = `clash ${process.hrtime.bigint()}`;
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "09:30", endTime: "10:30", bookedBy: clash }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=conflict");

    const page = await roomsPage(date);
    expect(page).not.toContain(clash);
    expect(page).toContain(bookedBy);
  });

  it("accepts a non-overlapping booking for the same room and date", async () => {
    const later = `later ${process.hrtime.bigint()}`;
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "10:00", endTime: "11:00", bookedBy: later }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).not.toContain("error");
    expect(await roomsPage(date)).toContain(later);
  });

  it("broadcasts a new booking over the SSE stream", async () => {
    const live = `live probe ${process.hrtime.bigint()}`;

    // subscribe first, then post, then read until the event arrives
    const stream = await fetch(new URL("/api/events", baseUrl));
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("no response body");

    await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "2", startTime: "13:00", endTime: "14:00", bookedBy: live }),
    );

    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes(date)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the event arrived");
      received += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(received).toContain("event: booking");
  }, 10_000);
});

describe("cancelling a booking", () => {
  const date = "2031-04-02";
  let bookingId: number;

  beforeAll(async () => {
    await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "3", startTime: "15:00", endTime: "16:00", bookedBy: "to be cancelled" }),
    );
    const rows = await fetch(new URL(`/?date=${date}`, baseUrl)).then((r) => r.text());
    const match = rows.match(/\/api\/bookings\/(\d+)\/cancel/);
    if (!match) throw new Error("couldn't find the booking's cancel form");
    bookingId = Number(match[1]);
  });

  it("frees the room: a fresh page load no longer shows the booking", async () => {
    const res = await post(`/api/bookings/${bookingId}/cancel`, new URLSearchParams({ date }));
    expect(res.status).toBe(303);

    const page = await roomsPage(date);
    expect(page).not.toContain("to be cancelled");
    expect(page).toContain("Free all day");
  });

  it("lets the freed slot be booked again", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "3", startTime: "15:00", endTime: "16:00", bookedBy: "second booker" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).not.toContain("error");
    expect(await roomsPage(date)).toContain("second booker");
  });
});

// Cancel's own hidden `date` form field only exists to redirect the
// submitting browser back to the view it came from — the HTML form always
// sends it correctly because it's the page's own date, but the API boundary
// has to reach the same result for a crafted request that sends something
// else, the way spec/booking.test.ts already probes bookings.ts directly.
// The stream every other tab actually listens on has to carry the
// cancelled booking's own real date, not whatever a client claims.
describe("cancelling with a crafted, mismatched date field", () => {
  const date = "2031-07-14";
  let bookingId: number;

  beforeAll(async () => {
    await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "09:00", endTime: "10:00", bookedBy: "crafted-cancel probe" }),
    );
    const rows = await roomsPage(date);
    const match = rows.match(/\/api\/bookings\/(\d+)\/cancel/);
    if (!match) throw new Error("couldn't find the booking's cancel form");
    bookingId = Number(match[1]);
  });

  it("still cancels the booking, but broadcasts the booking's own date, not the crafted one", async () => {
    const stream = await fetch(new URL("/api/events", baseUrl));
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("no response body");

    const res = await post(`/api/bookings/${bookingId}/cancel`, new URLSearchParams({ date: "not-a-real-date" }));
    expect(res.status).toBe(303);
    expect(await roomsPage(date)).not.toContain("crafted-cancel probe");

    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: booking")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the event arrived");
      received += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(received).toContain(`data: {"date":"${date}"}`);
    expect(received).not.toContain("not-a-real-date");
  }, 10_000);
});

// addBooking's own comment (src/lib/db.ts) argues no two requests can ever
// interleave between its overlap check and its insert, because better-
// sqlite3's calls are synchronous — but that's a claim about this app's own
// behaviour, and this repo's standing practice is to check such a claim live
// rather than trust the reasoning. Real concurrent HTTP requests (not two
// sequential awaits) are what could actually expose a check-then-insert race
// if the reasoning were wrong.
describe("booking the same slot from multiple requests at once", () => {
  const date = "2031-06-09";

  it("lets exactly one of several concurrent overlapping requests win", async () => {
    const attempts = ["first", "second", "third", "fourth", "fifth"].map((who) =>
      post("/api/bookings", new URLSearchParams({ date, roomId: "1", startTime: "12:00", endTime: "13:00", bookedBy: who })),
    );
    const results = await Promise.all(attempts);
    const outcomes = results.map((res) => res.headers.get("location") ?? "");
    const winners = outcomes.filter((location) => !location.includes("error"));
    const conflicts = outcomes.filter((location) => location.includes("error=conflict"));

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(attempts.length - 1);

    const page = await roomsPage(date);
    expect(page.match(/12:00–13:00/g)).toHaveLength(1);
  });
});

// cancelBooking (src/lib/db.ts) is the same no-await-in-between shape as
// addBooking, so the same live-concurrency discipline applies to it: don't
// trust "it's a single synchronous statement, so it must be race-free" by
// analogy alone, drive it with genuinely concurrent requests instead.
describe("cancelling the same booking from multiple requests at once", () => {
  const date = "2031-07-21";
  let bookingId: number;

  beforeAll(async () => {
    await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "2", startTime: "16:00", endTime: "17:00", bookedBy: "double cancel" }),
    );
    const rows = await roomsPage(date);
    const match = rows.match(/\/api\/bookings\/(\d+)\/cancel/);
    if (!match) throw new Error("couldn't find the booking's cancel form");
    bookingId = Number(match[1]);
  });

  it("leaves the booking cancelled exactly once, with no error from any request", async () => {
    const attempts = [1, 2, 3, 4, 5].map(() => post(`/api/bookings/${bookingId}/cancel`, new URLSearchParams({ date })));
    const results = await Promise.all(attempts);
    for (const res of results) expect(res.status).toBe(303);

    const page = await roomsPage(date);
    expect(page).not.toContain("double cancel");
    expect(page).toContain("Free all day");
  });
});

// A cancel and a new overlapping booking racing each other is the other
// half of the same claim: cancelling always succeeds (given a real id), so
// whichever way the two requests interleave, the freed slot's original
// occupant must be gone, and the new booking must be there exactly when its
// own check lost the race (no error) — never both, and never a silent loss
// where neither ever explains what happened.
describe("cancelling a booking while a new overlapping booking races it", () => {
  it("never leaves the original booking behind, and the new one lands iff it wasn't rejected", async () => {
    for (let i = 0; i < 8; i++) {
      const date = `2031-08-${String(10 + i).padStart(2, "0")}`;
      await post(
        "/api/bookings",
        new URLSearchParams({ date, roomId: "1", startTime: "11:00", endTime: "12:00", bookedBy: "original" }),
      );
      const rows = await roomsPage(date);
      const match = rows.match(/\/api\/bookings\/(\d+)\/cancel/);
      if (!match) throw new Error("couldn't find the booking's cancel form");
      const id = Number(match[1]);

      const [cancelRes, bookRes] = await Promise.all([
        post(`/api/bookings/${id}/cancel`, new URLSearchParams({ date })),
        post(
          "/api/bookings",
          new URLSearchParams({ date, roomId: "1", startTime: "11:30", endTime: "12:30", bookedBy: "racer" }),
        ),
      ]);
      expect(cancelRes.status).toBe(303);
      expect(bookRes.status).toBe(303);

      const page = await roomsPage(date);
      expect(page).not.toContain("original");
      const racerWon = !(bookRes.headers.get("location") ?? "").includes("error");
      expect(page.includes("racer")).toBe(racerWon);
    }
  });
});

// The room dropdown and time inputs only ever send well-formed values, but
// nothing stops a request from skipping the form entirely (this file's own
// `post` helper does) — the write endpoint has to reject what the browser
// would never send, not just what a person might type into a real input.
describe("rejecting requests the form itself would never send", () => {
  const date = "2031-05-14";

  it("rejects a room id that doesn't exist, instead of crashing", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "999", startTime: "09:00", endTime: "10:00", bookedBy: "ghost room" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=room");
    expect(await roomsPage(date)).not.toContain("ghost room");
  });

  it("rejects time strings that aren't HH:MM, even ones that sort correctly", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "0", endTime: "9", bookedBy: "garbage time" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=invalid");
    expect(await roomsPage(date)).not.toContain("garbage time");
  });

  it("rejects a date that isn't YYYY-MM-DD", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({
        date: "not-a-date",
        roomId: "1",
        startTime: "09:00",
        endTime: "10:00",
        bookedBy: "bad date",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=date");
  });

  it("rejects a well-formed date that's already in the past", async () => {
    const res = await post(
      "/api/bookings",
      new URLSearchParams({ date: "2020-01-01", roomId: "1", startTime: "09:00", endTime: "10:00", bookedBy: "time traveller" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=past");
    expect(await roomsPage("2020-01-01")).not.toContain("time traveller");
  });
});

// The board only renders "I'm here" for a booking it already considers
// active, but that's a rendering choice, not a guard — the API a raw POST
// reaches has to refuse the transition itself for any booking that isn't
// genuinely happening right now.
describe("checking in to a booking that isn't happening right now", () => {
  it("rejects check-in for a booking dated far in the future", async () => {
    const date = "2031-09-01";
    await post(
      "/api/bookings",
      new URLSearchParams({ date, roomId: "1", startTime: "09:00", endTime: "10:00", bookedBy: "not yet here" }),
    );
    // The board only renders an "I'm here" form for a booking it already
    // considers active — this one, dated in 2031, never gets one — so the
    // id comes from the cancel form every booking renders regardless.
    const rows = await roomsPage(date);
    const match = rows.match(/\/api\/bookings\/(\d+)\/cancel/);
    if (!match) throw new Error("couldn't find the booking's id");

    const res = await post(`/api/bookings/${match[1]}/checkin`, new URLSearchParams({ date }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=checkin");
    expect(await roomsPage(date)).not.toContain("Confirmed present");
  });
});
