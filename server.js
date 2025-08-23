// server.js
// Backend API per Runshift - PostgreSQL (Render) + Express

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3001;

// Usa DATABASE_URL da Render; come fallback usa la connessione che mi hai dato
const DEFAULT_DB =
  "postgresql://db_gare_corsa_user:5jvC8S3ryZloq884tVtK36m0N6TK0ZHd@dpg-d2iueebuibrs73aa9qh0-a.frankfurt-postgres.render.com/db_gare_corsa?sslmode=require";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || DEFAULT_DB,
  ssl: { rejectUnauthorized: false },
});

// ---------- Middleware ----------
app.use(cors()); // Se vuoi restringere: cors({ origin: ["https://TUO-FRONTEND"] })
app.use(express.json());

// Prova a servire la SPA se esiste una build in ./dist (non obbligatoria)
const distPath = path.join(__dirname, "dist");
app.use((req, res, next) => {
  // Solo se esiste la cartella dist
  if (req.method === "GET") {
    // evitiamo errori se la dir non esiste su Render
    try {
      require("fs").accessSync(distPath);
      app.use(express.static(distPath));
    } catch (_) { /* no dist folder; ignore */ }
  }
  next();
});

// ---------- Utils ----------
function toInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function likeParam(s) {
  if (!s || typeof s !== "string") return null;
  return `%${s.trim()}%`;
}

function normalizeDate(s) {
  // accetta ISO o YYYY-MM-DD; lascia null se vuoto
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t;
}

// ---------- Health ----------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ---------- GET /api/races (lista con filtri + pagination) ----------
/**
 * Query params supportati:
 * - country: string (ILIKE)
 * - city: string (ILIKE)
 * - distance: string (match di testo su distance_km, es. "42" o "21.1")
 * - q: string (cerca su race_name e location)
 * - fromDate, toDate: string (ISO o YYYY-MM-DD)
 * - page: 1-based (default 1)
 * - limit: default 24
 */
app.get("/api/races", async (req, res) => {
  const {
    country,
    city,
    distance,
    q,
    fromDate,
    toDate,
    page = "1",
    limit = "24",
  } = req.query;

  const p = [];
  const where = [];

  // Filtri testuali
  if (country) {
    p.push(likeParam(country));
    where.push(`location_country ILIKE $${p.length}`);
  }
  if (city) {
    p.push(likeParam(city));
    where.push(`location_city ILIKE $${p.length}`);
  }
  if (distance) {
    // distance_km è stringa tipo "42 / 21.1 / 10" → contains
    p.push(likeParam(distance));
    where.push(`distance_km ILIKE $${p.length}`);
  }
  if (q) {
    const like = likeParam(q);
    p.push(like, like, like);
    where.push(
      `(race_name ILIKE $${p.length - 2} OR location_city ILIKE $${p.length - 1} OR location_country ILIKE $${p.length})`
    );
  }

  // Filtri data: la colonna "date" è TEXT; interpretiamo in SQL dove possibile
  const from = normalizeDate(fromDate);
  const to = normalizeDate(toDate);
  if (from) {
    p.push(from);
    where.push(`NULLIF(date,'')::timestamp >= $${p.length}`);
  }
  if (to) {
    p.push(to);
    where.push(`NULLIF(date,'')::timestamp <= $${p.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Paginazione
  const lim = Math.min(Math.max(toInt(limit, 24), 1), 100);
  const pgNum = Math.max(toInt(page, 1), 1);
  const offset = (pgNum - 1) * lim;

  p.push(lim);
  const limitIdx = p.length;
  p.push(offset);
  const offsetIdx = p.length;

  const baseSelect = `
    SELECT
      race_name, race_url, date, location_city, location_country, region,
      distance_km, race_type, surface, elevation_gain_m, certified,
      typical_weather, nearest_airport, registration_status,
      registration_open_date, registration_close_date, registration_process,
      fee_range_eur, geo_lat, geo_lon, image_url, image_thumb_url,
      sources_json, tags_json
    FROM public.races_full
    ${whereSql}
    ORDER BY
      NULLIF(date,'')::timestamp NULLS LAST,
      race_name ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM public.races_full
    ${whereSql}
  `;

  try {
    const [rowsQ, countQ] = await Promise.all([
      pool.query(baseSelect, p),
      pool.query(countSql, p.slice(0, p.length - 2)), // count non usa limit/offset
    ]);

    res.json({
      page: pgNum,
      limit: lim,
      total: countQ.rows?.[0]?.total ?? 0,
      items: rowsQ.rows,
    });
  } catch (e) {
    console.error("GET /api/races error:", e);
    res.status(500).json({ error: "DB error", detail: e.message });
  }
});

// ---------- GET /api/race (singola gara per URL) ----------
/**
 * Recupera una gara tramite il suo race_url passato come query param:
 *   /api/race?url=https://worldsmarathons.com/it/marathon/ultraswim-333-greece
 *
 * (evita problemi di slash nei path dinamici)
 */
app.get("/api/race", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        race_name, race_url, date, location_city, location_country, region,
        distance_km, race_type, surface, elevation_gain_m, certified,
        typical_weather, nearest_airport, registration_status,
        registration_open_date, registration_close_date, registration_process,
        fee_range_eur, geo_lat, geo_lon, image_url, image_thumb_url,
        sources_json, tags_json
      FROM public.races_full
      WHERE race_url = $1
      LIMIT 1
      `,
      [url]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/race error:", e);
    res.status(500).json({ error: "DB error", detail: e.message });
  }
});

// ---------- (Opzionale) Stats di base ----------
app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE NULLIF(date,'') IS NOT NULL)::int AS with_date,
        COUNT(*) FILTER (WHERE COALESCE(image_thumb_url, image_url) IS NOT NULL)::int AS with_image
      FROM public.races_full
    `);
    res.json(rows[0] || { total: 0, with_date: 0, with_image: 0 });
  } catch (e) {
    res.status(500).json({ error: "DB error", detail: e.message });
  }
});

// ---------- SPA fallback (se esiste dist) ----------
app.get("*", (req, res, next) => {
  try {
    const indexPath = path.join(distPath, "index.html");
    require("fs").accessSync(indexPath);
    return res.sendFile(indexPath);
  } catch (_) {
    return next(); // nessuna SPA build; ignora
  }
});

// ---------- Avvio ----------
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
