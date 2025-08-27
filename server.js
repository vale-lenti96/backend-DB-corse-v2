// server.js – Runshift API (Render)

// deps
const cors = require('cors');
app.use(cors({
  origin: true, // oppure "https://TUO-DOMINIO-RENDER-FRONTEND"
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false
}));
app.options('*', cors());

const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

// app
const app = express();
const PORT = process.env.PORT || 3001;

// DB
const DEFAULT_DB =
  "postgresql://db_gare_corsa_user:5jvC8S3ryZloq884tVtK36m0N6TK0ZHd@dpg-d2iueebuibrs73aa9qh0-a.frankfurt-postgres.render.com/db_gare_corsa?sslmode=require";

// --- Pool PG con timeouts “sani”
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || DEFAULT_DB,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX || "8", 10),
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT || "30000", 10),
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT || "5000", 10),
});

// middleware
app.use(cors());
app.use(express.json());

// ---- static SPA (se esiste ./dist) ----
const distPath = path.join(__dirname, "dist");
const hasDist = fs.existsSync(distPath);
if (hasDist) {
  app.use(express.static(distPath));
}

// ---- health & root ----
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// Risponde 200 anche se non hai la build del frontend
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("Runshift API is up. Health at /health, races at /api/races");
});
// /health: velocissimo, non tocca il DB (usalo su Render)
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// /ready: verifica DB (usalo tu per check manuale)
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(503).json({ ok: false, db: false, error: e.message });
  }
});


// ---- utils ----
function toInt(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function like(s) {
  if (!s || typeof s !== "string") return null;
  return `%${s.trim()}%`;
}
function normDate(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  return t || null;
}

// ---- API: list ----
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

  if (country) {
    p.push(like(country));
    where.push(`location_country ILIKE $${p.length}`);
  }
  if (city) {
    p.push(like(city));
    where.push(`location_city ILIKE $${p.length}`);
  }
  if (distance) {
    p.push(like(distance));
    where.push(`distance_km ILIKE $${p.length}`);
  }
  if (q) {
    const l = like(q);
    p.push(l, l, l);
    where.push(
      `(race_name ILIKE $${p.length - 2} OR location_city ILIKE $${p.length - 1} OR location_country ILIKE $${p.length})`
    );
  }

  const from = normDate(fromDate);
  const to = normDate(toDate);
  if (from) {
    p.push(from);
    where.push(date_ts >= $N);
  }
  if (to) {
    p.push(to);
    where.push(date_ts <= $N);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const lim = Math.min(Math.max(toInt(limit, 24), 1), 100);
  const pgNum = Math.max(toInt(page, 1), 1);
  const offset = (pgNum - 1) * lim;

  p.push(lim);
  const limitIdx = p.length;
  p.push(offset);
  const offsetIdx = p.length;

  const selectSql = `
    SELECT
      race_name, race_url, date, location_city, location_country, region,
      distance_km, race_type, surface, elevation_gain_m, certified,
      typical_weather, nearest_airport, registration_status,
      registration_open_date, registration_close_date, registration_process,
      fee_range_eur, geo_lat, geo_lon, image_url, image_thumb_url,
      sources_json, tags_json
    FROM public.races_full
    ${whereSql}
    ORDER BY date_ts NULLS LAST, race_name ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM public.races_full
    ${whereSql}
  `;

  try {
    const [rowsQ, countQ] = await Promise.all([
      pool.query(selectSql, p),
      pool.query(countSql, p.slice(0, p.length - 2)),
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

// ---- API: single by url ----
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

// ---- SPA fallback (serve index.html se c'è) ----
if (hasDist) {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// start
app.listen(PORT, async () => {
  console.log(`API server running on http://localhost:${PORT}`);
  // Warm-up: prova a connetterti al DB una volta all'avvio
  try {
    await pool.query("SELECT 1");
    console.log("DB warm-up: OK");
  } catch (e) {
    console.warn("DB warm-up failed:", e.message);
  }
});

