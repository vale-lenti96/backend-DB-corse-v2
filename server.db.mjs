import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

app.listen(PORT, () => {
  console.log(`Backend DB (Postgres) su :${PORT}`);
});
