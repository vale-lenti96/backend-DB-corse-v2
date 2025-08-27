// server.js — API Runshift (Express + Postgres)
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// CORS PRIMA di definire le rotte, ma DOPO la creazione di app
app.use(cors({
  origin: true,                        // o metti l'URL del tuo frontend per restringere
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false
}));
app.options('*', cors());

app.use(express.json());

// ====== DB ======
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://db_gare_corsa_user:5jvC8S3ryZloq884tVtK36m0N6TK0ZHd@dpg-d2iueebuibrs73aa9qh0-a.frankfurt-postgres.render.com/db_gare_corsa?sslmode=require";
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabella: per default public.races_full; puoi override con env RACES_TABLE
const TABLE = process.env.RACES_TABLE || "public.races_full";

// ====== Health/Ready ======
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ====== Helpers ======
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// ====== /api/races ======
/**
 * Query params supportati:
 *  - page, limit
 *  - country, city, q (ricerca testo su nome/luogo), distance, type (client-side se non presente nel DB)
 *  - fromDate, toDate (YYYY-MM-DD) confrontati su date_ts (TIMESTAMP)
 *  - includePast=true/false (default true: non filtra il passato)
 */
app.get('/api/races', async (req, res) => {
  try {
    const {
      page = '1',
      limit = '24',
      country,
      city,
      q,
      distance,
      type,           // il backend non filtra su type: lo fa il frontend
      fromDate,
      toDate,
      includePast = 'true'
    } = req.query;

    const p = [];
    const where = [];

    // Filtri facoltativi
    if (country) {
      p.push(country);
      where.push(`LOWER(location_country) = LOWER($${p.length})`);
    }
    if (city) {
      p.push(`%${city}%`);
      where.push(`LOWER(location_city) LIKE LOWER($${p.length})`);
    }
    if (q) {
      p.push(`%${q}%`);
      where.push(`(LOWER(race_name) LIKE LOWER($${p.length}) OR LOWER(location_city) LIKE LOWER($${p.length}) OR LOWER(location_country) LIKE LOWER($${p.length}))`);
    }
    if (distance) {
      // match numerico nella stringa distance_km (es. "42", "21.1")
      p.push(`%${distance}%`);
      where.push(`distance_km ILIKE $${p.length}`);
    }
    // Date range su date_ts (TIMESTAMP)
    if (fromDate) {
      p.push(fromDate);
      where.push(`date_ts >= $${p.length}::date`);
    } else if (includePast !== 'true') {
      // Se vuoi escludere passato quando includePast=false
      p.push(new Date().toISOString().slice(0,10));
      where.push(`date_ts >= $${p.length}::date`);
    }
    if (toDate) {
      p.push(toDate);
      where.push(`date_ts <= $${p.length}::date`);
    }
    
    // ====== /api/countries (distinct paesi da oggi in poi) ======
app.get('/api/countries', async (_req, res) => {
  try {
    const sql = `
      SELECT DISTINCT location_country AS country
      FROM ${TABLE}
      WHERE location_country IS NOT NULL
        AND location_country <> ''
        AND date_ts >= CURRENT_DATE
      ORDER BY 1
    `;
    const { rows } = await pool.query(sql);
    res.json(rows.map(r => r.country));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', detail: e.message });
  }
});


    const pageNum = toInt(page, 1);
    const limitNum = Math.min(toInt(limit, 24), 100);
    const offset = (pageNum - 1) * limitNum;

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Conteggio totale (per paginazione)
    const countSQL = `SELECT COUNT(*)::int AS n FROM ${TABLE} ${whereSQL}`;
    const { rows: countRows } = await pool.query(countSQL, p);
    const total = countRows[0]?.n || 0;

    // Lista
    const selectSQL = `
      SELECT
        race_name, race_url,
        date, date_ts,
        location_city, location_country, region,
        distance_km, race_type, surface, elevation_gain_m,
        certified, typical_weather, nearest_airport,
        registration_status, registration_open_date, registration_close_date, registration_process,
        fee_range_eur, geo_lat, geo_lon,
        image_url, image_thumb_url,
        sources_json, tags_json
      FROM ${TABLE}
      ${whereSQL}
      ORDER BY date_ts NULLS LAST, race_name ASC
      LIMIT $${p.length + 1} OFFSET $${p.length + 2}
    `;
    const { rows: items } = await pool.query(selectSQL, [...p, limitNum, offset]);

    res.json({ items, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', detail: e.message });
  }
});

// ====== /api/race?url=... (dettaglio) ======
app.get('/api/race', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const sql = `
      SELECT
        race_name, race_url,
        date, date_ts,
        location_city, location_country, region,
        distance_km, race_type, surface, elevation_gain_m,
        certified, typical_weather, nearest_airport,
        registration_status, registration_open_date, registration_close_date, registration_process,
        fee_range_eur, geo_lat, geo_lon,
        image_url, image_thumb_url,
        sources_json, tags_json
      FROM ${TABLE}
      WHERE race_url = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [url]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', detail: e.message });
  }
});

// ====== Avvio ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});


