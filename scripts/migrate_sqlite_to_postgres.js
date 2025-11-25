require('dotenv').config()
const path = require('path')
const Database = require('better-sqlite3')
const { Pool } = require('pg')
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd())
const sqlite = new Database(path.join(DATA_DIR, 'data.db'))
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

;(async function(){
  await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, unit_id INTEGER)')
  await pool.query('CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY, area_id INTEGER, name TEXT)')
  await pool.query('CREATE TABLE IF NOT EXISTS counts (id SERIAL PRIMARY KEY, unit_id INTEGER, date TEXT, manual INTEGER, electronic INTEGER, UNIQUE(unit_id, date))')
  await pool.query('CREATE TABLE IF NOT EXISTS locks (date TEXT PRIMARY KEY)')

  const units = sqlite.prepare('SELECT id, area_id, name FROM units').all()
  for (const u of units) {
    await pool.query('INSERT INTO units (id, area_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [u.id, u.area_id, u.name])
  }

  const users = sqlite.prepare('SELECT id, username, password_hash, role, unit_id FROM users').all()
  for (const us of users) {
    await pool.query('INSERT INTO users (id, username, password_hash, role, unit_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING', [us.id, us.username, us.password_hash, us.role, us.unit_id])
  }

  const counts = sqlite.prepare('SELECT unit_id, date, manual, electronic FROM counts').all()
  for (const c of counts) {
    const m = typeof c.manual === 'number' ? c.manual : 0
    const e = typeof c.electronic === 'number' ? c.electronic : 0
    await pool.query('INSERT INTO counts (unit_id, date, manual, electronic) VALUES ($1, $2, $3, $4) ON CONFLICT (unit_id, date) DO UPDATE SET manual = EXCLUDED.manual, electronic = EXCLUDED.electronic', [c.unit_id, c.date, m, e])
  }

  const locks = sqlite.prepare('SELECT date FROM locks').all()
  for (const l of locks) {
    await pool.query('INSERT INTO locks (date) VALUES ($1) ON CONFLICT (date) DO NOTHING', [l.date])
  }

  await pool.end()
  console.log('Migración completada')
})()