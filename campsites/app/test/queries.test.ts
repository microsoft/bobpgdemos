import assert from "node:assert/strict";
import test from "node:test";
import { bookingQuery, executionDetails, nameQuery, searchQuery } from "../src/queries.js";
import { searchSchema } from "../src/domain.js";

test("shared SQL definitions bind normalized filters without interpolating input", () => {
  const input = searchSchema.parse({
    text: "' OR true --", radius_km: "60", pet_friendly: "false", available_only: "false",
  });
  const query = searchQuery(input);
  assert.ok(query.text.includes("ST_X(c.location::geometry)"));
  assert.ok(query.text.includes("ST_Y(c.location::geometry)"));
  assert.ok(query.text.includes("ST_DWithin"));
  assert.equal(query.text.includes(input.text), false);
  assert.deepEqual(query.values, [
    -122.335, 47.608, "' OR true --", '{"kayak_rental":true}', 4, 60, false, "2030-07-11", "2030-07-13",
  ]);
  assert.deepEqual(nameQuery("' OR true --").values, ["' OR true --"]);
});

test("execution details redact booking aliases without changing actual query parameters", () => {
  const query = bookingQuery({
    campsite_id: 1, guest_alias: "Private Demo Alias", check_in: "2030-07-11", check_out: "2030-07-13",
  });
  const execution = executionDetails(query, performance.now(), 1);
  assert.equal(query.values[1], "Private Demo Alias");
  assert.equal(execution.parameters[1]?.value, "[demo alias redacted]");
  assert.equal(JSON.stringify(execution).includes("Private Demo Alias"), false);
  assert.ok(execution.sql.includes("daterange($3::date,$4::date,'[)')"));
});
