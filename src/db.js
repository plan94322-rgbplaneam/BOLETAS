const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function init() {
  await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, unit_id INTEGER)')
  await pool.query('CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY, area_id INTEGER, name TEXT)')
  await pool.query('CREATE TABLE IF NOT EXISTS counts (id SERIAL PRIMARY KEY, unit_id INTEGER, date TEXT, manual INTEGER, electronic INTEGER, UNIQUE(unit_id, date))')
  await pool.query('CREATE TABLE IF NOT EXISTS locks (date TEXT PRIMARY KEY)')
  const r = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', ['admin'])
  if (r.rows.length === 0) {
    const hash = bcrypt.hashSync('admin', 10)
    await pool.query('INSERT INTO users (username, password_hash, role, unit_id) VALUES ($1, $2, $3, $4)', ['admin', hash, 'admin', null])
  }
}

async function seedAreasUnits(areas, unitsByArea) {
  for (const a of areas) {
    for (const u of (unitsByArea[a.id] || [])) {
      await pool.query('INSERT INTO units (id, area_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [u.id, a.id, u.name])
    }
  }
}

async function getUserByUsername(username) {
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username])
  return r.rows[0] || null
}

async function getUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id])
  return r.rows[0] || null
}

async function getAllUsers() {
  const r = await pool.query('SELECT u.id, u.username, u.role, u.unit_id, units.name AS unit_name FROM users u LEFT JOIN units ON units.id = u.unit_id ORDER BY u.id')
  return r.rows
}

async function createEditor(username, password_hash, unit_id) {
  await pool.query('INSERT INTO users (username, password_hash, role, unit_id) VALUES ($1, $2, $3, $4)', [username, password_hash, 'editor', unit_id])
}

async function updateUserPassword(id, password_hash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, id])
}

async function deleteUserById(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id])
}

async function countUsersByUnit(unitId) {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE unit_id = $1', [unitId])
  return (r.rows[0] && r.rows[0].c) || 0
}

async function getUnitById(id) {
  const r = await pool.query('SELECT * FROM units WHERE id = $1', [id])
  return r.rows[0] || null
}

async function getCountsForMonth(ym) {
  const r = await pool.query('SELECT unit_id, date, COALESCE(manual,0) AS manual, COALESCE(electronic,0) AS electronic FROM counts WHERE date LIKE $1', [`${ym}-%`])
  const out = {}
  for (const row of r.rows) {
    out[`${row.unit_id}|${row.date}`] = { manual: row.manual, electronic: row.electronic }
  }
  return out
}

async function getCountsForUnitMonth(unitId, ym) {
  const r = await pool.query('SELECT date, COALESCE(manual,0) AS manual, COALESCE(electronic,0) AS electronic FROM counts WHERE unit_id = $1 AND date LIKE $2', [unitId, `${ym}-%`])
  const out = {}
  for (const row of r.rows) {
    out[row.date] = { manual: row.manual, electronic: row.electronic }
  }
  return out
}

async function upsertCount(unitId, date, manual, electronic) {
  const r = await pool.query('SELECT COALESCE(manual,0) AS manual, COALESCE(electronic,0) AS electronic FROM counts WHERE unit_id = $1 AND date = $2', [unitId, date])
  const current = r.rows[0] || { manual: 0, electronic: 0 }
  const m = typeof manual === 'number' ? manual : current.manual
  const e = typeof electronic === 'number' ? electronic : current.electronic
  await pool.query('INSERT INTO counts (unit_id, date, manual, electronic) VALUES ($1, $2, $3, $4) ON CONFLICT (unit_id, date) DO UPDATE SET manual = EXCLUDED.manual, electronic = EXCLUDED.electronic', [unitId, date, m, e])
}

async function lockDate(date) {
  await pool.query('INSERT INTO locks (date) VALUES ($1) ON CONFLICT (date) DO NOTHING', [date])
}

async function unlockDate(date) {
  await pool.query('DELETE FROM locks WHERE date = $1', [date])
}

async function isDateLocked(date) {
  const r = await pool.query('SELECT date FROM locks WHERE date = $1', [date])
  return r.rows.length > 0
}

async function getLockedDatesForMonth(ym) {
  const r = await pool.query('SELECT date FROM locks WHERE date LIKE $1', [`${ym}-%`])
  return r.rows.map((x) => x.date)
}

async function resetApp() {
  await pool.query('DELETE FROM counts')
  await pool.query('DELETE FROM locks')
  await pool.query("DELETE FROM users WHERE role != 'admin'")
}

module.exports = {
  init,
  seedAreasUnits,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createEditor,
  updateUserPassword,
  deleteUserById,
  countUsersByUnit,
  getUnitById,
  getCountsForMonth,
  getCountsForUnitMonth,
  upsertCount,
  lockDate,
  unlockDate,
  isDateLocked,
  getLockedDatesForMonth,
  resetApp,
}