// server.js
// Minimal API per collegare il frontend al DB Postgres su Render
// Dipendenze: express, pg, cors
// Avvio: node server.js (in prod), nodemon server.js (in dev)

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL non impostata. Imposta una variabile d’ambiente DATABASE_URL con la tua connection string.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres richiede SSL
});

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Modello dati atteso dal frontend (tipi suggeriti in DB):
 *  id (text/uuid), name (text), city (text), country (text),
 *  date_start (date), date_end (date|null),
 *  distances (text[])  -- es: {'5K','10K','21K','42K'}
 *  surface (text)      -- 'road'|'trail'|'mixed'
 *  elevation_profile (text) -- 'flat'|'rolling'|'hilly'
 *  pb_friendly (boolean), price_from (numeric|null),
 *  website (text|null), lat (numeric|null), lon (numeric|null)
 *
 * Indici consigliati:
 *  - index on date_start
 *  - gin index on distances
 *  - btree on country, city, surface, elevation_profile
 */

// GET /api/races — ricerca con filtri + paginazione
app.get('/api/races', async (req, res) => {
  // Filtri dal querystring
  const {
    q,
    distance,            // "5K" | "10K" | "21K" | "42K" (o lista "10K,21K")
    country,             // "Italy" (substring case-insensitive)
    surface,             // "road" | "trail" | "mixed" (o lista)
    elevation,           // "flat" | "rolling" | "hilly" (o lista)
    dateFrom,            // "YYYY-MM-DD"
    dateTo,              // "YYYY-MM-DD"
    page = '1',
    limit = '60',
    orderBy = 'date_start',   // opzionale, default: date_start
    orderDir = 'asc',         // 'asc' | 'desc'
  } = req.query;

  const clauses = [];
  const values = [];
  let vi = 1;

  // Ricerca full-text semplice su name, city, country
  if (q) {
    clauses.push(`(lower(name) like $${vi} or lower(city) like $${vi} or lower(country) like $${vi})`);
    values.push(`%${String(q).toLowerCase()}%`);
    vi++;
  }

  // Distanze: almeno una delle richieste deve comparire nell'array distances
  if (distance) {
    const list = String(distance).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) {
      clauses.push(`$${vi} = ANY(distances)`);
      values.push(list[0]);
      vi++;
    } else if (list.length > 1) {
      // ANY su OR multipli
      const ors = list.map((_d, i) => `$${vi + i} = ANY(distances)`).join(' OR ');
      clauses.push(`(${ors})`);
      list.forEach(d => values.push(d));
      vi += list.length;
    }
  }

  if (country) {
    clauses.push(`lower(country) like $${vi}`);
    values.push(`%${String(country).toLowerCase()}%`);
    vi++;
  }

  if (surface) {
    const list = String(surface).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) {
      clauses.push(`surface = $${vi}`);
      values.push(list[0]);
      vi++;
    } else if (list.length > 1) {
      clauses.push(`surface = ANY($${vi})`);
      values.push(list);
      vi++;
    }
  }

  if (elevation) {
    const list = String(elevation).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) {
      clauses.push(`elevation_profile = $${vi}`);
      values.push(list[0]);
      vi++;
    } else if (list.length > 1) {
      clauses.push(`elevation_profile = ANY($${vi})`);
      values.push(list);
      vi++;
    }
  }

  if (dateFrom) {
    clauses.push(`date_start >= $${vi}`);
    values.push(dateFrom);
    vi++;
  }
  if (dateTo) {
    clauses.push(`date_start <= $${vi}`);
    values.push(dateTo);
    vi++;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Sanitizza order
  const safeOrderCols = new Set(['date_start', 'country', 'city', 'name', 'price_from']);
  const col = safeOrderCols.has(String(orderBy)) ? String(orderBy) : 'date_start';
  const dir = String(orderDir).toLowerCase() === 'desc' ? 'desc' : 'asc';

  // Paginazione
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 60));
  const offset = (p - 1) * l;

  // Query count totale
  const countSql = `SELECT COUNT(*)::int AS total FROM races ${where};`;

  // Query page
  const pageSql = `
    SELECT
      id, name, city, country,
      to_char(date_start,'YYYY-MM-DD') AS date_start,
      to_char(date_end,'YYYY-MM-DD')   AS date_end,
      distances, surface, elevation_profile,
      pb_friendly, price_from, website, lat, lon
    FROM races
    ${where}
    ORDER BY ${col} ${dir} NULLS LAST
    LIMIT ${l} OFFSET ${offset};
  `;

  try {
    const client = await pool.connect();
    try {
      const [countRes, dataRes] = await Promise.all([
        client.query(countSql, values),
        client.query(pageSql, values),
      ]);

      const total = countRes.rows?.[0]?.total || 0;

      const races = dataRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        city: r.city,
        country: r.country,
        dateStart: r.date_start,
        dateEnd: r.date_end || undefined,
        distances: r.distances || [],
        surface: r.surface,
        elevationProfile: r.elevation_profile || undefined,
        pbFriendly: r.pb_friendly === true,
        priceFrom: r.price_from !== null ? Number(r.price_from) : undefined,
        website: r.website || undefined,
        lat: r.lat !== null ? Number(r.lat) : undefined,
        lon: r.lon !== null ? Number(r.lon) : undefined,
      }));

      res.json({ races, total });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/races/:id — dettaglio singola gara
app.get('/api/races/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, name, city, country,
        to_char(date_start,'YYYY-MM-DD') AS date_start,
        to_char(date_end,'YYYY-MM-DD')   AS date_end,
        distances, surface, elevation_profile,
        pb_friendly, price_from, website, lat, lon
      FROM races
      WHERE id = $1
      `,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const r = rows[0];
    const race = {
      id: r.id,
      name: r.name,
      city: r.city,
      country: r.country,
      dateStart: r.date_start,
      dateEnd: r.date_end || undefined,
      distances: r.distances || [],
      surface: r.surface,
      elevationProfile: r.elevation_profile || undefined,
      pbFriendly: r.pb_friendly === true,
      priceFrom: r.price_from !== null ? Number(r.price_from) : undefined,
      website: r.website || undefined,
      lat: r.lat !== null ? Number(r.lat) : undefined,
      lon: r.lon !== null ? Number(r.lon) : undefined,
    };
    res.json(race);
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Static hosting (opzionale): se stai buildando il frontend (Vite) nella cartella dist
// decommenta queste righe per servire i file statici dallo stesso server:
//
const path = require('path');
//app.use(express.static(path.join(__dirname, 'dist')));
//app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
// Serve i file statici del frontend buildato
//app.use(express.static(path.join(__dirname, 'dist')));
//app.get('*', (_req, res) => {
//  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


app.listen(PORT, () => {
  console.log(`✅ API server in ascolto su http://localhost:${PORT}`);
});

