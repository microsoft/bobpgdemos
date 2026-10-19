import type { BookingInput, SearchInput } from "./domain.js";

export interface DatabaseQuery {
  operation: "search" | "name" | "booking";
  text: string;
  values: (string | number | boolean)[];
}

export function searchQuery(input: SearchInput): DatabaseQuery {
  return {
    operation: "search",
    text: `WITH filtered AS (
  SELECT c.campsite_id, c.name, c.description,
    c.nightly_price::float8 AS nightly_price, c.capacity, c.amenities,
    ST_X(c.location::geometry) AS longitude,
    ST_Y(c.location::geometry) AS latitude,
    ST_Distance(c.location, ST_SetSRID(ST_MakePoint($1, $2),4326)::geography) AS meters,
    NOT EXISTS (
      SELECT 1 FROM escape.reservation r
      WHERE r.campsite_id=c.campsite_id
        AND r.stay && daterange($8::date,$9::date,'[)')
    ) AS available
  FROM escape.campsite c
  WHERE ($3::text='' OR c.search_document @@ websearch_to_tsquery('english',$3))
    AND c.amenities @> $4::jsonb
    AND c.capacity >= $5
    AND ST_DWithin(c.location,
      ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$6::float8 * 1000)
)
SELECT campsite_id,name,description,nightly_price,capacity,amenities,available,
  longitude,latitude,round((meters/1000)::numeric,1)::float8 AS km_from_seattle
FROM filtered WHERE NOT $7::boolean OR available
ORDER BY km_from_seattle,name LIMIT 100`,
    values: [input.longitude, input.latitude, input.text,
      JSON.stringify({
        ...(input.pet_friendly ? { pet_friendly: true } : {}),
        ...(input.kayak_rental ? { kayak_rental: true } : {}),
      }), input.capacity, input.radius_km, input.available_only, input.check_in, input.check_out],
  };
}

export function nameQuery(name: string): DatabaseQuery {
  return {
    operation: "name",
    text: `SELECT campsite_id,name,round(similarity(name,$1)::numeric,2)::float8 AS similarity
FROM escape.campsite WHERE name % $1
ORDER BY similarity DESC,name LIMIT 3`,
    values: [name],
  };
}

export function bookingQuery(input: BookingInput): DatabaseQuery {
  return {
    operation: "booking",
    text: `INSERT INTO escape.reservation(campsite_id,guest_name,stay)
SELECT campsite_id,$2,daterange($3::date,$4::date,'[)')
FROM escape.campsite WHERE campsite_id=$1
RETURNING reservation_id::text,campsite_id,
  lower(stay)::text AS check_in,upper(stay)::text AS check_out`,
    values: [input.campsite_id, input.guest_alias, input.check_in, input.check_out],
  };
}

export function executionDetails(query: DatabaseQuery, started: number, rows: number, outcome = "succeeded") {
  return {
    operation: query.operation,
    sql: query.text,
    parameters: query.values.map((value, index) => ({
      parameter: `$${index + 1}`,
      value: query.operation === "booking" && index === 1 ? "[demo alias redacted]" : value,
    })),
    elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
    rows,
    outcome,
  };
}
