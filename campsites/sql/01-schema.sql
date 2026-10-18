\set ON_ERROR_STOP on
BEGIN;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA escape;

CREATE TABLE escape.campsite (
    campsite_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    description text NOT NULL,
    location geography(Point, 4326) NOT NULL,
    nightly_price numeric(8,2) NOT NULL CHECK (nightly_price > 0),
    capacity integer NOT NULL CHECK (capacity > 0),
    amenities jsonb NOT NULL CHECK (jsonb_typeof(amenities) = 'object'),
    search_document tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', name), 'A') ||
        setweight(to_tsvector('english', description), 'B')
    ) STORED
);

CREATE INDEX campsite_location_idx ON escape.campsite USING gist (location);
CREATE INDEX campsite_search_idx ON escape.campsite USING gin (search_document);
CREATE INDEX campsite_amenities_idx ON escape.campsite USING gin (amenities);
CREATE INDEX campsite_name_idx ON escape.campsite USING gin (name gin_trgm_ops);

CREATE TABLE escape.reservation (
    reservation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campsite_id integer NOT NULL REFERENCES escape.campsite,
    guest_name text NOT NULL CHECK (length(btrim(guest_name)) > 0),
    stay daterange NOT NULL CHECK (
        NOT isempty(stay) AND
        NOT lower_inf(stay) AND
        NOT upper_inf(stay)
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT no_double_booking EXCLUDE USING gist (
        campsite_id WITH =,
        stay WITH &&
    )
);
COMMIT;
