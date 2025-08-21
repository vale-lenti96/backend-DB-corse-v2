// server.js — backend-only per Render

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Log di sicurezza (maschera la password)
function maskDbUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return '***'; }
}

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

console.log('🔧 Node version:', process.version);
console.log('🔌 PORT:', PORT);
console.log('🗄️  DATABASE_URL set:', !!DATABASE_URL, DATABASE_URL ? '(' + maskDbUrl(DATABASE_URL) + ')' : '');

let pool = null;
if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL non impostata: le API proveranno a funzionare ma le query falliranno.');
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // richiesto su Render Postgres
  });
}

// Healthcheck leggero (non crasha mai)
app.get('/api/health', async (_req, res) => {
  if (!pool) return res.json({ ok: false, db: false, error: 'DATABASE_URL missing' });
  try {
    await pool.query('select 1');
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(503).json({ ok: false, db: false, error: err.message });
  }
});

/**
 * GET /api/races — filtri e paginazione
 * Query: q, distance, country, surface, elevation, dateFrom, dateTo, page, limit, orderBy, orderDir
 */
app.get('/api/races', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured (DATABASE_URL missing)' });

  const {
    q, distance, country, surface, elevation, dateFrom, dateTo,
    page = '1', limit = '60', orderBy = 'date_start', orderDir = 'asc',
  } = req.query;

  const clauses = [];
  const values = [];
  let vi = 1;

  if (q) {
    clauses.push(`(lower(name) like $${vi} or lower(city) like $${vi} or lower(country) like $${vi})`);
    values.push(`%${String(q).toLowerCase()}%`); vi++;
  }
  if (distance) {
    const list = String(distance).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) { clauses.push(`$${vi} = ANY(distances)`); values.push(list[0]); vi++; }
    else if (list.length > 1) {
      const ors = list.map((_d, i) => `$${vi + i} = ANY(distances)`).join(' OR ');
      clauses.push(`(${ors})`); list.forEach(d => values.push(d)); vi += list.length;
    }
  }
  if (country) { clauses.push(`lower(country) like $${vi}`); values.push(`%${String(country).toLowerCase()}%`); vi++; }
  if (surface) {
    const list = String(surface).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) { clauses.push(`surface = $${vi}`); values.push(list[0]); vi++; }
    else if (list.length > 1) { clauses.push(`surface = ANY($${vi})`); values.push(list); vi++; }
  }
  if (elevation) {
    const list = String(elevation).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) { clauses.push(`elevation_profile = $${vi}`); values.push(list[0]); vi++; }
    else if (list.length > 1) { clauses.push(`elevation_profile = ANY($${vi})`); values.push(list); vi++; }
  }
  if (dateFrom) { clauses.push(`date_start >= $${vi}`); values.push(dateFrom); vi++; }
  if (dateTo)   { clauses.push(`date_start <= $${vi}`); values.push(dateTo); vi++; }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const safeOrderCols = new Set(['date_start','country','city','name','price_from']);
  const col = safeOrderCols.has(String(orderBy)) ? String(orderBy) : 'date_start';
  const dir = String(orderDir).toLowerCase() === 'desc' ? 'desc' : 'asc';

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 60));
  const offset = (p - 1) * l;

  const countSql = `SELECT COUNT(*)::int AS total FROM races ${where};`;
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
    console.error('DB error on /api/races:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Dettaglio
app.get('/api/races/:id', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured (DATABASE_URL missing)' });
  try {
    const { rows } = await pool.query(`
      SELECT
        id, name, city, country,
        to_char(date_start,'YYYY-MM-DD') AS date_start,
        to_char(date_end,'YYYY-MM-DD')   AS date_end,
        distances, surface, elevation_profile,
        pb_friendly, price_from, website, lat, lon
      FROM races WHERE id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    res.json({
      id: r.id, name: r.name, city: r.city, country: r.country,
      dateStart: r.date_start, dateEnd: r.date_end || undefined,
      distances: r.distances || [], surface: r.surface,
      elevationProfile: r.elevation_profile || undefined,
      pbFriendly: r.pb_friendly === true,
      priceFrom: r.price_from !== null ? Number(r.price_from) : undefined,
      website: r.website || undefined,
      lat: r.lat !== null ? Number(r.lat) : undefined,
      lon: r.lon !== null ? Number(r.lon) : undefined,
    });
  } catch (err) {
    console.error('DB error on /api/races/:id:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Handler errori non catturati (evita crash “status 1”)
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Avvio server SEMPRE (anche se il DB non risponde al primo colpo)
app.listen(PORT, () => {
  console.log(`✅ API server in ascolto su http://localhost:${PORT}`);
});

