\set ON_ERROR_STOP on
BEGIN;
WITH places(name, longitude, latitude, setting) AS (
    VALUES
        ('Lake Sammamish', -122.064, 47.556, 'lakeside'),
        ('Lake Washington', -122.256, 47.660, 'lakeside'),
        ('Lake Tapps', -122.184, 47.240, 'lakeside'),
        ('Rattlesnake Lake', -121.766, 47.433, 'lakeside'),
        ('Lake Easton', -121.184, 47.238, 'lakeside'),
        ('Deception Pass', -122.625, 48.403, 'coastal'),
        ('Camano Island', -122.504, 48.121, 'coastal'),
        ('Mount Rainier', -121.747, 46.755, 'mountain'),
        ('Snoqualmie Forest', -121.604, 47.523, 'forest'),
        ('Olympic Forest', -123.404, 47.832, 'forest')
), numbered AS (
    SELECT *, row_number() OVER (ORDER BY name)::integer AS place_number
    FROM places
)
INSERT INTO escape.campsite (name, description, location, nightly_price, capacity, amenities)
SELECT
    name || ' ' || CASE site WHEN 1 THEN 'Cedar' WHEN 2 THEN 'Heron' ELSE 'Pine' END,
    'Fictional ' || setting || ' campsite near ' || name || '. ' ||
        CASE WHEN setting = 'lakeside'
            THEN 'Lake access for kayaking and swimming. Quiet water and sunset views.'
            ELSE 'Hiking trails, wildlife watching, and quiet evenings under the stars.'
        END,
    ST_SetSRID(ST_MakePoint(longitude + site * 0.002, latitude + site * 0.001), 4326)::geography,
    25 + place_number * 3 + site * 7,
    CASE WHEN site = 1 THEN 2 WHEN site = 2 THEN 4 ELSE 6 END,
    jsonb_build_object(
        'pet_friendly', site <> 1,
        'electric_hookup', site = 3,
        'kayak_rental', setting = 'lakeside',
        'setting', setting,
        'fire_pit', true
    )
FROM numbered
CROSS JOIN generate_series(1, 3) AS site
ORDER BY place_number, site;

INSERT INTO escape.reservation (campsite_id, guest_name, stay)
SELECT campsite_id, 'Seed guest', daterange(DATE '2030-07-10', DATE '2030-07-12', '[)')
FROM escape.campsite
WHERE name IN ('Lake Easton Cedar', 'Olympic Forest Heron', 'Deception Pass Pine');
ANALYZE escape.campsite;
ANALYZE escape.reservation;
COMMIT;
