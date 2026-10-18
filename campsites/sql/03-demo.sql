\set ON_ERROR_STOP on
\pset pager off
\echo 'Find a pet-friendly lakeside campsite for four, with kayaking, within 45 km of Seattle.'
SELECT name, nightly_price, capacity,
       round((ST_Distance(location, ST_SetSRID(ST_MakePoint(-122.335, 47.608), 4326)::geography) / 1000)::numeric, 1) AS km_from_seattle,
       amenities
FROM escape.campsite
WHERE search_document @@ websearch_to_tsquery('english', 'lake kayaking')
  AND amenities @> '{"pet_friendly":true,"kayak_rental":true}'::jsonb
  AND capacity >= 4
  AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(-122.335, 47.608), 4326)::geography, 45000)
ORDER BY km_from_seattle, name;

\echo 'A misspelled name still finds Lake Sammamish.'
SELECT name, round(similarity(name, 'Lake Samamish Heron')::numeric, 2) AS similarity
FROM escape.campsite
WHERE name % 'Lake Samamish Heron'
ORDER BY similarity DESC, name
LIMIT 3;

\echo 'Availability excludes overlapping reservations, but permits checkout-day arrivals.'
SELECT c.name
FROM escape.campsite c
WHERE NOT EXISTS (
    SELECT 1 FROM escape.reservation r
    WHERE r.campsite_id = c.campsite_id
      AND r.stay && daterange(DATE '2030-07-11', DATE '2030-07-13', '[)')
)
ORDER BY c.name
LIMIT 5;
