import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseCsv } from "csv-parse/sync";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- UTIL ----------

async function ensureSchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schemaSql);
}

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

async function seedFromCsv(csvRelativePath) {
  const csvPath = path.join(__dirname, csvRelativePath);
  if (!fs.existsSync(csvPath)) {
    console.warn(`⚠️  CSV non trovato: ${csvPath} — salto il seed`);
    return;
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const records = parseCsv(content, { columns: true, skip_empty_lines: true });
  const rows = records.map(toRow);

  console.log(`🔁 Svuoto la tabella races…`);
  await pool.query("TRUNCATE TABLE races;");

  console.log(`⬆️ Importo ${rows.length} righe da ${csvRelativePath}…`);
  const insert = `INSERT INTO races
    (race_name, race_url, date, location_city, location_country, region, distance_km, race_type, surface,
     elevation_gain_m, certified, typical_weather, nearest_airport, registration_status,
     registration_open_date, registration_close_date, registration_process, fee_range_eur,
     geo_lat, geo_lon, sources, tags)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`;

  for (const r of rows) {
    await pool.query(insert, [
      r.race_name, r.race_url, r.date, r.location_city, r.location_country, r.region,
      r.distance_km, r.race_type, r.surface, r.elevation_gain_m, r.certified,
      r.typical_weather, r.nearest_airport, r.registration_status,
      r.registration_open_date, r.registration_close_date, r.registration_process,
      r.fee_range_eur, r.geo_lat, r.geo_lon, r.sources, r.tags
    ]);
  }
  console.log(`✅ Seed completato.`);
}

// ---------- API ----------

app.post("/api/search-races", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.time_window?.from || !p.time_window?.to) {
      return res.status(400).json({ error: "time_window.from e time_window.to sono obbligatori (YYYY-MM-DD)" });
    }

    const clauses = ["date >= $1 AND date <= $2"];
    const params = [p.time_window.from, p.time_window.to];
    let i = 3;

    if (p.region)           { clauses.push(`region = $${i++}`);            params.push(p.region); }
    if (p.country)          { clauses.push(`location_country = $${i++}`);  params.push(p.country); }
    if (p.distance_km)      { clauses.push(`distance_km = $${i++}`);       params.push(Number(p.distance_km)); }
    if (p.surface)          { clauses.push(`surface = $${i++}`);           params.push(p.surface); }

    const sql = `
      SELECT race_name, race_url, date, location_city, location_country, region, distance_km, surface,
             elevation_gain_m, certified, typical_weather, nearest_airport, registration_status,
             geo_lat, geo_lon, sources, tags
      FROM races
      WHERE ${clauses.join(" AND ")}
      ORDER BY date ASC
      LIMIT 5000
    `;

    const { rows } = await pool.query(sql, params);

    const out = rows.map(r => ({
      race_name: r.race_name,
      race_url: r.race_url,
      date: r.date,
      location: r.location_city ? `${r.location_city}, ${r.location_country || ""}`.trim() : (r.location_country || ""),
      country: r.location_country,
      distance_km: r.distance_km,
      course: {
        surface: r.surface,
        elevation_gain_m: r.elevation_gain_m,
        certified: r.certified,
        typical_weather: r.typical_weather
      },
      logistics: {
        nearest_airport: r.nearest_airport,
        registration_status: r.registration_status
      },
      sources: (() => { try { return JSON.parse(r.sources || "[]"); } catch { return []; } })(),
      geo: (r.geo_lat && r.geo_lon) ? [Number(r.geo_lat), Number(r.geo_lon)] : null,
      tags: (() => { try { return JSON.parse(r.tags || "[]"); } catch { return []; } })()
    }));

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "search_failed", details: String(e) });
  }
});

// ---------- BOOT ----------

(async () => {
  try {
    await ensureSchema();

    // Di default semina il DB ad ogni avvio. Metti SEED_ON_BOOT=0 per disattivare.
    const shouldSeed = process.env.SEED_ON_BOOT !== "0";
    if (shouldSeed) {
      await seedFromCsv("races_template.csv");
    } else {
      console.log("⏭️  SEED_ON_BOOT=0 — seed disattivato.");
    }

    app.listen(PORT, () => {
      console.log(`✅ Backend DB (Postgres) su :${PORT}`);
    });
  } catch (err) {
    console.error("❌ Errore in boot:", err);
    process.exit(1);
  }
})();
