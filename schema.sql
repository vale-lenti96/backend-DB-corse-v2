CREATE TABLE IF NOT EXISTS races (
  id SERIAL PRIMARY KEY,
  race_name TEXT NOT NULL,
  race_url TEXT,
  date DATE NOT NULL,
  location_city TEXT,
  location_country TEXT,      -- ISO-2 (IT, FR, ...)
  region TEXT,                -- Europe, Americas, ...
  distance_km REAL NOT NULL,
  race_type TEXT,             -- road, trail, track, mixed
  surface TEXT,               -- road, trail, pista, mixed
  elevation_gain_m INTEGER,
  certified BOOLEAN,
  typical_weather TEXT,
  nearest_airport TEXT,
  registration_status TEXT,   -- open, closed, tba, lottery, charity, soldout
  registration_open_date DATE,
  registration_close_date DATE,
  registration_process TEXT,
  fee_range_eur TEXT,         -- es. "80–150"
  geo_lat REAL,
  geo_lon REAL,
  sources TEXT,               -- JSON array string
  tags TEXT,                  -- JSON array string
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_races_date ON races(date);
CREATE INDEX IF NOT EXISTS idx_races_country ON races(location_country);
CREATE INDEX IF NOT EXISTS idx_races_region ON races(region);
CREATE INDEX IF NOT EXISTS idx_races_distance ON races(distance_km);
