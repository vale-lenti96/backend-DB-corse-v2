// server.js
npm install dotenv
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

// Usa DATABASE_URL da Render se presente, altrimenti fallback al tuo URL
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://db_gare_corsa_user:5jvC8S3ryZloq884tVtK36m0N6TK0ZHd@dpg-d2iueebuibrs73aa9qh0-a.frankfurt-postgres.render.com/db_gare_corsa";

// Pool PG con SSL per Render
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Utils distanza (stesse categorie del frontend) ----------
const DISTANCE_CATEGORIES = [
  { key: "",        min: null,   max: null },
  { key: "5k",      min: 4.0,    max: 6.0 },
  { key: "10k",     min: 8.0,    max: 12.0 },
  { key: "15k",     min: 13.0,   max: 17.0 },
  { key: "half",    min: 20.0,   max: 22.8 },
  { key: "25k",     min: 23.0,   max: 27.0 },
  { key: "30k",     min: 28.0,   max: 32.0 },
  { key: "marathon",min: 41.0,   max: 43.5 },
  { key: "ultra",   min: 43.5,   max: 10000.0 },
];

function getRangeForCategory(catKey) {
  const found = DISTANCE_CATEGORIES.find((c) => c.key === catKey);
  if (!found || found.min == null) return null;
  return { min: found.min, max: found.max };
}

function parseKmList(distanceText) {
  if (!distanceText) return [];
  const txt = Array.isArray(distanceText) ? distanceText.join(", ") : String(distanceText);
  const norm = txt
    .replace(/(\d)\s*[kK]\b/g, "$1 km") // 10k -> 10 km
    .replace(/,/g, ".")
    .replace(/\s+/g, " ");
  const nums = norm.match(/(\d+(?:\.\d+)?)(?=\s*km|\b)/gi) || [];
  const km = nums
    .map((s) => parseFloat(s))
    .filter((v) => isFinite(v) && v > 0 && v < 10000);
  return Array.from(new Set(km));
}

function matchDistanceCategory(row, catKey) {
  if (!catKey) return true;
  const range = getRangeForCategory(catKey);
  if (!range) return true;
  const kms = parseKmList(row.distance_km || row.distance || "");
  if (kms.length === 0) return false;
  return kms.some((v) => v >= range.min && v <= range.max);
}

// ---------- Rotte di cortesia ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Runshift API",
    endpoints: ["/health", "/races"],
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ---------- /races con filtri ----------
app.get("/races", async (req, res) => {
  const {
    q = "",
    country = "",
    date_from = "", // YYYY-MM-DD
    date_to = "",   // YYYY-MM-DD
    distanceCat = "",
    limit = "5000",
  } = req.query;

  // Costruiamo una WHERE SQL solo per filtri "sicuri" lato DB (testo/paese/date).
  // Il filtro distanza lo applichiamo in Node (la distanza è campo testuale).
  const where = [];
  const params = [];
  let idx = 1;

  // Solo future di default se non arriva date_from
  if (date_from) {
    where.push(`date_ts >= $${idx++}`);
    params.push(new Date(date_from));
  } else {
    where.push(`date_ts >= CURRENT_DATE`);
  }

  if (date_to) {
    where.push(`date_ts <= $${idx++}`);
    params.push(new Date(date_to));
  }

  if (country) {
    where.push(`location_country = $${idx++}`);
    params.push(country);
  }

  if (q) {
    where.push(`(LOWER(race_name) LIKE $${idx} OR LOWER(location_city) LIKE $${idx})`);
    params.push(`%${String(q).toLowerCase()}%`);
    idx++;
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Seleziona le colonne utili per il frontend
  const sql = `
    SELECT
      race_name, race_url, date_ts, location_city, location_country,
      region, distance_km, race_type, surface, elevation_gain_m,
      image_url, image_thumb_url
    FROM public.races_full
    ${whereSQL}
    ORDER BY date_ts ASC
    LIMIT ${Number(limit) || 5000}
  `;

  try {
    const { rows } = await pool.query(sql, params);

    // filtro distanza in Node (perché distance_km è testuale con combinazioni varie)
    const filtered = distanceCat ? rows.filter(r => matchDistanceCategory(r, distanceCat)) : rows;

    res.json(filtered);
  } catch (e) {
    console.error("[/races] DB error:", e);
    res.status(500).json({ error: "Database error", detail: e.message });
  }
});

// ---------- Avvio ----------
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
