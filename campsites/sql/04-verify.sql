\set ON_ERROR_STOP on
\pset pager off
BEGIN;
DO $checks$
DECLARE
    site integer;
    matches integer;
BEGIN
    IF (SELECT count(*) FROM escape.campsite) <> 30 THEN
        RAISE EXCEPTION 'Expected exactly 30 campsites';
    END IF;
    IF (SELECT count(*) FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm', 'btree_gist')) <> 3 THEN
        RAISE EXCEPTION 'Required extensions are missing';
    END IF;
    SELECT count(*) INTO matches
    FROM escape.campsite
    WHERE search_document @@ websearch_to_tsquery('english', 'lake kayaking')
      AND amenities @> '{"pet_friendly":true,"kayak_rental":true}'::jsonb
      AND capacity >= 4
      AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(-122.335, 47.608), 4326)::geography, 45000);
    IF matches <> 6 THEN
        RAISE EXCEPTION 'Expected 6 combined search results, got %', matches;
    END IF;
    IF NOT EXISTS (
        SELECT FROM escape.campsite
        WHERE name = 'Lake Sammamish Heron' AND name % 'Lake Samamish Heron'
    ) THEN
        RAISE EXCEPTION 'Typo-tolerant search failed';
    END IF;
    SELECT campsite_id INTO STRICT site FROM escape.campsite WHERE name = 'Lake Sammamish Heron';
    -- Roll back all test bookings, including when a check fails.
    DELETE FROM escape.reservation WHERE campsite_id = site;
    INSERT INTO escape.reservation (campsite_id, guest_name, stay)
    VALUES (site, 'Verification', daterange(DATE '2030-08-01', DATE '2030-08-03', '[)'));
    BEGIN
        INSERT INTO escape.reservation (campsite_id, guest_name, stay)
        VALUES (site, 'Must conflict', daterange(DATE '2030-08-02', DATE '2030-08-04', '[)'));
        RAISE EXCEPTION 'Overlapping booking was incorrectly accepted';
    EXCEPTION WHEN exclusion_violation THEN
        RAISE NOTICE 'Overlapping reservation correctly rejected';
    END;
    INSERT INTO escape.reservation (campsite_id, guest_name, stay)
    VALUES (site, 'Adjacent is valid', daterange(DATE '2030-08-03', DATE '2030-08-05', '[)'));
    BEGIN
        INSERT INTO escape.reservation (campsite_id, guest_name, stay)
        VALUES (site, 'Empty stay', 'empty'::daterange);
        RAISE EXCEPTION 'Empty stay was incorrectly accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Empty stay correctly rejected';
    END;
    RAISE NOTICE 'PASS: 30 campsites, extensions, combined spatial/text/JSONB search, typo search, booking constraints';
END
$checks$;
ROLLBACK;

SELECT extname, extversion FROM pg_extension
WHERE extname IN ('postgis', 'pg_trgm', 'btree_gist') ORDER BY extname;
SELECT 'campsites' AS entity, count(*) FROM escape.campsite
UNION ALL SELECT 'reservations', count(*) FROM escape.reservation;
