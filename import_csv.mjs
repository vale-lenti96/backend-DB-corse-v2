import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import csv from "csv-parse/sync";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL mancante (usa l'URL Postgres di Render).");
  process.exit(1);
}

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");

function toRow(obj) {
  return {
    race_name: obj.race_name,
    race_url: obj.race_url || null,
    date: obj.date,
    location_city: obj.location_city || null,
    location_country: obj.location_country || null,
    region: obj.region || null,
    distance_km: obj.distance_km ? parseFloat(obj.distance_km) : null,
    race_type: obj.race_type || "road",
    surface: obj.surface || "road",
    elevation_gain_m: obj.elevation_gain_m ? parseInt(obj.elevation_gain_m) : null,
    certified: String(obj.certified).toLowerCase() === "true",
    typical_weather: obj.typical_weather || null,
    nearest_airport: obj.nearest_airport || null,
    registration_status: obj.registration_status || null,
    registration_open_date: obj.registration_open_date || null,
    registration_close_date: obj.registration_close_date || null,
    registration_process: obj.registration_process || null,
    fee_range_eur: obj.fee_range_eur || null,
    geo_lat: obj.geo_lat ? parseFloat(obj.geo_lat) : null,
    geo_lon: obj.geo_lon ? parseFloat(obj.geo_lon) : null,
    sources: obj.sources_json || "[]",
    tags: obj.tags_json || "[]"
  };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // crea schema
  await client.query(schema);

  // prepara dati
  const csvFile = process.argv[2] || "races_template.csv";
  const content = fs.readFileSync(path.join(__dirname, csvFile), "utf-8");
  const records = csv.parse(content, { columns: true, skip_empty_lines: true });
  const rows = records.map(toRow);

  const insert = `INSERT INTO races
    (race_name, race_url, date, location_city, location_country, region, distance_km, race_type, surface,
     elevation_gain_m, certified, typical_weather, nearest_airport, registration_status,
     registration_open_date, registration_close_date, registration_process, fee_range_eur,
     geo_lat, geo_lon, sources, tags)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`;

  for (const r of rows) {
    await client.query(insert, [
      r.race_name, r.race_url, r.date, r.location_city, r.location_country, r.region,
      r.distance_km, r.race_type, r.surface, r.elevation_gain_m, r.certified, r.typical_weather,
      r.nearest_airport, r.registration_status, r.registration_open_date, r.registration_close_date,
      r.registration_process, r.fee_range_eur, r.geo_lat, r.geo_lon, r.sources, r.tags
    ]);
  }

  await client.end();
  console.log(`Importate ${rows.length} gare in 'races'.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
