import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../dist/postgres.js";
import { bookingQuery } from "../dist/queries.js";

const origin = process.argv[2];
if (!origin || !/^https:\/\/[a-z0-9-]+\.azurewebsites\.net$/.test(origin)) {
  throw new Error("Pass the deployed HTTPS app origin.");
}
const pool = createPool();
const alias = `DeployProbe-${randomUUID()}`;
const stay = { check_in: "2038-09-11", check_out: "2038-09-13" };
const found = await fetch(`${origin}/api/campsites?available_only=false`).then((r) => r.json());
const site = found.campsites[0];
if (!site) throw new Error("No campsite found for smoke test.");
const data = { ...stay, campsite_id: site.campsite_id, guest_alias: alias };
const submit = (body) => fetch(`${origin}/api/bookings`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify(body),
});
try {
  const responses = await Promise.all([submit(data), submit(data)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  for (const response of responses) {
    const body = await response.json();
    assert.equal(body.execution.sql, bookingQuery(data).text);
    assert.equal(body.execution.parameters[1].value, "[demo alias redacted]");
    assert.equal(JSON.stringify(body).includes(alias), false);
    assert.equal(body.execution.rows, response.status === 201 ? 1 : 0);
  }
  const adjacent = await submit({ ...data, check_in: "2038-09-13", check_out: "2038-09-14" });
  assert.equal(adjacent.status, 201);
  const search = await fetch(`${origin}/api/campsites?available_only=false&check_in=${stay.check_in}&check_out=${stay.check_out}`).then((r) => r.json());
  assert.equal(search.campsites.find((c) => c.campsite_id === site.campsite_id)?.available, false);
  console.info("PASS: deployed API simultaneous bookings produced 201/409; SQL traces matched with aliases redacted; checkout-day arrival accepted; availability updated.");
} finally {
  try {
    const cleaned = await pool.query(
      "DELETE FROM escape.reservation WHERE guest_name=$1 AND campsite_id=$2 AND stay <@ daterange('2038-09-11','2038-09-14','[)') RETURNING reservation_id",
      [alias, site.campsite_id],
    );
    console.info(`Cleaned up ${cleaned.rowCount} uniquely identified deployment-test bookings only.`);
  } finally { await pool.end(); }
}
