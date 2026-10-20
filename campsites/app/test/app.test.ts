import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  BookingConflictError, CampsiteNotFoundError, RepositoryUnavailableError,
  bookingSchema, isCalendarDate, searchSchema,
  type BookingInput, type BookingReceipt, type Campsite, type SearchInput,
} from "../src/domain.js";
import { type CampsiteRepository, UnconfiguredRepository } from "../src/repository.js";
import { bookingQuery, nameQuery, searchQuery } from "../src/queries.js";

const origin = "http://localhost:3000";
const site: Campsite = {
  campsite_id: 1, name: "Lake Sammamish Heron", description: "Fictional lakeside campsite.",
  nightly_price: 60, capacity: 4, km_from_seattle: 22,
  longitude: -122.1, latitude: 47.62,
  amenities: { pet_friendly: true, kayak_rental: true, electric_hookup: false, fire_pit: true, setting: "lakeside" },
  available: true,
};
const booking: BookingInput = {
  campsite_id: 1, guest_alias: "Cedar Explorer", check_in: "2030-07-11", check_out: "2030-07-13",
};
function fixture(overrides: Partial<CampsiteRepository> = {}): CampsiteRepository {
  return {
    ready: async () => true,
    search: async () => [site],
    searchNames: async () => [{ campsite_id: 1, name: site.name, similarity: 0.8 }],
    book: async (input) => ({ reservation_id: "123", campsite_id: input.campsite_id,
      check_in: input.check_in, check_out: input.check_out }),
    ...overrides,
  };
}
function app(repository = fixture()) {
  return createApp({ repository, publicOrigin: origin, log: () => {} });
}

test("calendar and stay validation reject impossible dates, empty and oversized stays", () => {
  for (const date of ["2030-02-29", "2030-04-31", "2030-13-01", "0000-01-01", "2030-1-01", "invalid"]) {
    assert.equal(isCalendarDate(date), false, date);
    assert.equal(bookingSchema.safeParse({ ...booking, check_in: date }).success, false);
  }
  assert.equal(isCalendarDate("2032-02-29"), true);
  for (const check_out of ["2030-07-11", "2030-07-10", "2030-08-11"]) {
    assert.equal(bookingSchema.safeParse({ ...booking, check_out }).success, false);
  }
  assert.equal(bookingSchema.safeParse({ ...booking, check_out: "2030-08-10" }).success, true);
});

test("filter bounds, scalar syntax, booleans, unknown keys and aliases are validated", () => {
  assert.equal(searchSchema.parse({}).radius_km, 45);
  for (const input of [
    { radius_km: "0" }, { radius_km: "201" }, { capacity: "0" }, { capacity: "21" },
    { capacity: "4.5" }, { radius_km: "" }, { radius_km: "Infinity" }, { capacity: ["4", "5"] },
    { latitude: "91" }, { longitude: "-181" }, { pet_friendly: "yes" }, { unexpected: "x" },
    { check_in: "2030-02-30" }, { check_out: "2030-07-10" },
  ]) assert.equal(searchSchema.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(searchSchema.safeParse({ radius_km: "200", capacity: "20", pet_friendly: "false" }).success, true);
  for (const guest_alias of [" ", "<script>", "x".repeat(61)]) {
    assert.equal(bookingSchema.safeParse({ ...booking, guest_alias }).success, false);
  }
  assert.equal(bookingSchema.safeParse({ ...booking, campsite_id: "1" }).success, false);
  assert.equal(bookingSchema.safeParse({ ...booking, guest_name: "Private name" }).success, false);
});

test("liveness is anonymous and direct; unconfigured readiness and data are 503", async () => {
  const client = request(app(new UnconfiguredRepository()));
  assert.deepEqual((await client.get("/healthz").expect(200)).body, { status: "ok" });
  assert.deepEqual((await client.get("/readyz").expect(503)).body, { status: "not_ready" });
  await client.get("/api/campsites").expect(503);
  await client.get("/api/name-search").expect(503);
  await client.post("/api/bookings").set("Origin", origin).send(booking).expect(503);
  await request(app()).get("/readyz").expect(200);
});

test("search forwards filters, including availability dates, without exposing guest data", async () => {
  let observed: SearchInput | undefined;
  const privateSite = { ...site, guest_name: "PRIVATE_GUEST", reservations: [{ guest_name: "PRIVATE_GUEST" }],
    amenities: { ...site.amenities, guest_name: "PRIVATE_GUEST" } };
  const client = request(app(fixture({ search: async (input) => { observed = input; return [privateSite]; } })));
  const response = await client.get("/api/campsites?available_only=false&capacity=6&radius_km=60").expect(200);
  assert.equal(observed?.capacity, 6);
  assert.equal(observed?.available_only, false);
  assert.equal(observed?.check_in, "2030-07-11");
  assert.equal(response.text.includes("PRIVATE_GUEST"), false);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.campsites[0].longitude, site.longitude);
  assert.equal(response.body.campsites[0].latitude, site.latitude);
  assert.ok(observed);
  const query = searchQuery(observed);
  assert.equal(response.body.execution.sql, query.text);
  assert.deepEqual(response.body.execution.parameters.map((parameter: { value: unknown }) => parameter.value), query.values);
  assert.equal(response.body.execution.rows, 1);
  assert.ok(response.body.execution.elapsed_ms >= 0);
  await client.get("/api/campsites?check_in=2030-02-30").expect(400);
  await client.get("/api/campsites?capacity=4&capacity=6").expect(400);
});

test("typo search forwards the SQL demo spelling and whitelists output", async () => {
  let observed = "";
  const client = request(app(fixture({
    searchNames: async (name) => {
      observed = name;
      return [{ campsite_id: 1, name: site.name, similarity: 0.8, guest_name: "PRIVATE_GUEST" }];
    },
  })));
  const response = await client.get("/api/name-search").expect(200);
  assert.equal(observed, "Lake Samamish Heron");
  assert.equal(response.text.includes("PRIVATE_GUEST"), false);
  assert.equal(response.body.execution.sql, nameQuery(observed).text);
  assert.deepEqual(response.body.execution.parameters, [{ parameter: "$1", value: observed }]);
  await client.get("/api/name-search?name=").expect(400);
});

test("valid booking preserves exclusive dates and returns a privacy-safe receipt", async () => {
  let observed: BookingInput | undefined;
  const receipt = { reservation_id: "123", campsite_id: 1, check_in: booking.check_in,
    check_out: booking.check_out, guest_name: "PRIVATE_GUEST" };
  const client = request(app(fixture({ book: async (input): Promise<BookingReceipt> => {
    observed = input;
    return receipt;
  } })));
  const response = await client.post("/api/bookings").set("Origin", origin).send(booking).expect(201);
  assert.deepEqual(observed, booking);
  assert.deepEqual(response.body.booking, { reservation_id: "123", campsite_id: 1,
    check_in: "2030-07-11", check_out: "2030-07-13" });
  assert.equal(response.text.includes(booking.guest_alias), false);
  assert.equal(response.body.execution.sql, bookingQuery(booking).text);
  assert.deepEqual(response.body.execution.parameters[1], { parameter: "$2", value: "[demo alias redacted]" });
  assert.equal(response.body.execution.rows, 1);
  await client.get("/api/bookings").expect(404);
  await client.post("/api/bookings").set("Origin", origin).send({ ...booking, campsite_id: -1 }).expect(400);
});

test("conflict, not-found, unavailable and unexpected failures have safe status codes", async () => {
  for (const [error, code] of [
    [new BookingConflictError("PRIVATE_GUEST"), 409],
    [new CampsiteNotFoundError("PRIVATE_GUEST"), 404],
    [new RepositoryUnavailableError("password=SECRET"), 503],
    [new Error("password=SECRET"), 500],
  ] as const) {
    const events: string[] = [];
    const server = createApp({ repository: fixture({ book: async () => { throw error; } }),
      publicOrigin: origin, log: (event) => events.push(event) });
    const response = await request(server).post("/api/bookings").set("Origin", origin).send(booking).expect(code);
    assert.equal(/SECRET|PRIVATE_GUEST/.test(response.text + events.join()), false);
    if (code === 409) {
      assert.equal(response.body.execution.outcome, "overlap rejected (SQLSTATE 23P01)");
      assert.equal(response.body.execution.rows, 0);
      assert.equal(response.text.includes(booking.guest_alias), false);
    } else {
      assert.equal(response.body.execution, undefined);
    }
  }
  const events: string[] = [];
  const failing = createApp({ repository: fixture({
    ready: async () => { throw new Error("SECRET"); },
    search: async () => { throw new Error("SECRET"); },
    searchNames: async () => { throw new RepositoryUnavailableError("SECRET"); },
  }), log: (event) => events.push(event) });
  await request(failing).get("/readyz").expect(503);
  await request(failing).get("/api/campsites").expect(500);
  await request(failing).get("/api/name-search").expect(503);
  assert.equal(events.join().includes("SECRET"), false);
});

test("mutations require exact same origin, JSON, and bounded valid bodies", async () => {
  const client = request(app());
  for (const value of ["https://evil.example", "null", "http://localhost:3000.evil.example"]) {
    await client.post("/api/bookings").set("Origin", value).send(booking).expect(403);
  }
  await client.post("/api/bookings").send(booking).expect(403);
  await client.post("/api/bookings").set("Origin", origin).set("Sec-Fetch-Site", "cross-site").send(booking).expect(403);
  await client.post("/api/bookings").set("Origin", origin).type("text").send("hello").expect(415);
  await client.post("/api/bookings").set("Origin", origin).type("json").send("{bad").expect(400);
  await client.post("/api/bookings").set("Origin", origin).send({ ...booking, guest_alias: "x".repeat(9000) }).expect(413);
});

test("read/write limits are separate, expire, and never rate-limit health endpoints", async () => {
  let now = 0;
  const server = createApp({ repository: fixture(), publicOrigin: origin, now: () => now,
    readRate: { max: 1, windowMs: 1000 }, writeRate: { max: 1, windowMs: 1000 } });
  const client = request(server);
  await client.get("/api/campsites").expect(200);
  const limited = await client.get("/api/name-search").expect(429);
  assert.equal(limited.headers["retry-after"], "1");
  await client.post("/api/bookings").set("Origin", origin).send(booking).expect(201);
  await client.post("/api/bookings").set("Origin", origin).send(booking).expect(429);
  await client.get("/healthz").expect(200);
  await client.get("/readyz").expect(200);
  now = 1001;
  await client.get("/api/campsites").expect(200);
  await client.post("/api/bookings").set("Origin", origin).send(booking).expect(201);
});

test("static page has CSP, local assets, and no permissive CORS", async () => {
  const client = request(app());
  const response = await client.get("/").set("Origin", "https://evil.example").expect(200);
  assert.ok(response.headers["content-security-policy"]?.includes("script-src 'self'"));
  assert.ok(response.headers["content-security-policy"]?.includes("img-src 'self' https://tile.openstreetmap.org data:"));
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.ok(response.text.includes("Fictional"));
  assert.ok(response.text.includes('id="debug-panel" class="debug-panel" aria-labelledby="debug-title" hidden'));
  assert.ok(response.text.includes('id="debug-toggle"'));
  assert.ok(response.text.includes('id="campsite-map"'));
  assert.ok(response.text.includes('id="app-content"'));
  assert.ok(response.text.includes('id="demo-guide" class="demo-guide" aria-labelledby="guide-title" hidden'));
  for (const id of ["guide-start", "guide-back", "guide-next", "guide-exit", "guide-instruction", "search-submit",
    "activity-title", "activity-instruction", "activity-result", "booking-receipts", "saved-bookings"]) {
    assert.ok(response.text.includes(`id="${id}"`), id);
  }
  assert.match(response.text, /id="booking-confirm" type="checkbox" required/);
  assert.ok(response.text.includes("It will persist and affect availability."));
  await client.get("/app.js").expect(200);
  await client.get("/styles.css").expect(200);
  await client.get("/vendor/leaflet.js").expect(200).expect("Content-Type", /javascript/);
  await client.get("/vendor/leaflet.css").expect(200).expect("Content-Type", /css/);
  await client.get("/vendor/package.json").expect(404);
});
