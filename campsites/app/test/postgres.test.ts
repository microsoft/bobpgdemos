import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createPool, PostgresRepository } from "../src/postgres.js";
import { createApp } from "../src/app.js";
import { searchSchema } from "../src/domain.js";
import { searchQuery } from "../src/queries.js";

test("database configuration fails explicitly and never disables remote TLS", async () => {
  assert.throws(() => createPool({}), /PGHOST/);
  assert.throws(() => createPool({
    PGHOST: "example.com", PGUSER: "user", PGDATABASE: "db", DB_AUTH: "password", PGPASSWORD: "test",
  }), /loopback/);
  assert.throws(() => createPool({
    PGHOST: "example.com", PGUSER: "user", PGDATABASE: "db", PGPORT: "invalid",
  }), /PGPORT/);
  const pool = createPool({
    PGHOST: "example.com", PGUSER: "user", PGDATABASE: "db", DB_AUTH: "entra", AZURE_AUTH_MODE: "cli",
  });
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
  assert.equal(typeof pool.options.password, "function");
  await pool.end();
});

test("real PostgreSQL search, typo match, availability, bookings, and rollback", {
  skip: process.env.INTEGRATION_POSTGRES !== "1",
}, async () => {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = new PostgresRepository(client);
    const app = request(createApp({ repository, publicOrigin: "https://campsites.test" }));
    assert.equal(await repository.ready(), true);
    const core = await repository.search(searchSchema.parse({ available_only: "false" }));
    assert.equal(core.length, 6);
    assert.deepEqual(core.map((site) => site.name), [
      "Lake Washington Heron", "Lake Washington Pine", "Lake Sammamish Heron",
      "Lake Sammamish Pine", "Lake Tapps Heron", "Lake Tapps Pine",
    ]);
    for (const site of core) {
      assert.ok(Number.isFinite(site.longitude) && site.longitude >= -180 && site.longitude <= 180);
      assert.ok(Number.isFinite(site.latitude) && site.latitude >= -90 && site.latitude <= 90);
      assert.ok(site.km_from_seattle <= 45);
    }
    const first = core[0];
    assert.ok(first);
    assert.equal(first.name, "Lake Washington Heron");
    assert.equal(first.nightly_price, 57);
    const matches = await repository.searchNames("Lake Samamish Heron");
    assert.equal(matches[0]?.name, "Lake Sammamish Heron");
    assert.equal(matches[0]?.similarity, 0.86);
    const injection = await repository.searchNames("' OR true --");
    assert.ok(injection.length <= 3);
    const available = await repository.search(searchSchema.parse({ available_only: "true" }));
    assert.ok(available.every((site) => site.available));
    const body = { campsite_id: first.campsite_id, guest_alias: "Integration Demo",
      check_in: "2035-09-11", check_out: "2035-09-13" };
    const created = await app.post("/api/bookings").set("Origin", "https://campsites.test").send(body).expect(201);
    assert.equal(typeof created.body.booking.reservation_id, "string");
    assert.equal(created.body.booking.guest_alias, undefined);
    await client.query("SAVEPOINT conflict");
    await app.post("/api/bookings").set("Origin", "https://campsites.test")
      .send({ ...body, check_in: "2035-09-12" }).expect(409);
    await client.query("ROLLBACK TO SAVEPOINT conflict");
    await app.post("/api/bookings").set("Origin", "https://campsites.test")
      .send({ ...body, check_in: "2035-09-13", check_out: "2035-09-14" }).expect(201);
    await app.post("/api/bookings").set("Origin", "https://campsites.test")
      .send({ ...body, campsite_id: 2147483647 }).expect(404);
    const during = await repository.search(searchSchema.parse({
      available_only: "false", check_in: body.check_in, check_out: body.check_out,
    }));
    assert.equal(during.find((site) => site.campsite_id === first.campsite_id)?.available, false);
    const response = await app.get("/api/campsites?available_only=false").expect(200);
    assert.equal(response.body.execution.sql, searchQuery(searchSchema.parse({ available_only: "false" })).text);
    assert.equal(response.body.campsites[0].longitude, first.longitude);
    const stored = await client.query<{ longitude: number; latitude: number }>(
      "SELECT ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude FROM escape.campsite WHERE campsite_id=$1",
      [first.campsite_id]);
    assert.equal(first.longitude, stored.rows[0]?.longitude);
    assert.equal(first.latitude, stored.rows[0]?.latitude);
    assert.equal(JSON.stringify(response.body).includes("Integration Demo"), false);
    await client.query("ROLLBACK");
    const residue = await client.query<{ count: string }>(
      "SELECT count(*) FROM escape.reservation WHERE guest_name=$1 AND stay && daterange($2::date,$3::date,'[)')",
      [body.guest_alias, body.check_in, "2035-09-14"]);
    assert.equal(residue.rows[0]?.count, "0");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
