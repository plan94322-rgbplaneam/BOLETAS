const path = require('path')
const bcrypt = require('bcrypt')
const Database = require('better-sqlite3')

const db = new Database(path.join(__dirname, '..', 'data.db'))

function init() {
  db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, role TEXT, unit_id INTEGER)').run()
  db.prepare('CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY, area_id INTEGER, name TEXT)').run()
  db.prepare('CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id INTEGER, date TEXT, manual INTEGER, electronic INTEGER)').run()
  db.prepare('CREATE TABLE IF NOT EXISTS locks (date TEXT PRIMARY KEY)').run()
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin')
  if (!exists) {
    const hash = bcrypt.hashSync('admin', 10)
    db.prepare('INSERT INTO users (username, password_hash, role, unit_id) VALUES (?, ?, ?, ?)').run('admin', hash, 'admin', null)
  }
}

function seedAreasUnits(areas, unitsByArea) {
  const insert = db.prepare('INSERT OR IGNORE INTO units (id, area_id, name) VALUES (?, ?, ?)')
  areas.forEach((a) => {
    ;(unitsByArea[a.id] || []).forEach((u) => {
      insert.run(u.id, a.id, u.name)
    })
  })
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username)
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

function getAllUsers() {
  return db.prepare('SELECT u.id, u.username, u.role, u.unit_id, units.name AS unit_name FROM users u LEFT JOIN units ON units.id = u.unit_id ORDER BY u.id').all()
}

function createEditor(username, password_hash, unit_id) {
  db.prepare('INSERT INTO users (username, password_hash, role, unit_id) VALUES (?, ?, ?, ?)').run(username, password_hash, 'editor', unit_id)
}

function updateUserPassword(id, password_hash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id)
}

function deleteUserById(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

function countUsersByUnit(unitId) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users WHERE unit_id = ?').get(unitId)
  return row ? row.c : 0
}

function getUnitById(id) {
  return db.prepare('SELECT * FROM units WHERE id = ?').get(id)
}

function getCountsForMonth(ym) {
  const rows = db.prepare('SELECT unit_id, date, IFNULL(manual,0) AS manual, IFNULL(electronic,0) AS electronic FROM counts WHERE date LIKE ?').all(`${ym}-%`)
  const out = {}
  rows.forEach((r) => {
    out[`${r.unit_id}|${r.date}`] = { manual: r.manual, electronic: r.electronic }
  })
  return out
}

function getCountsForUnitMonth(unitId, ym) {
  const rows = db.prepare('SELECT date, IFNULL(manual,0) AS manual, IFNULL(electronic,0) AS electronic FROM counts WHERE unit_id = ? AND date LIKE ?').all(unitId, `${ym}-%`)
  const out = {}
  rows.forEach((r) => {
    out[r.date] = { manual: r.manual, electronic: r.electronic }
  })
  return out
}

function upsertCount(unitId, date, manual, electronic) {
  const existing = db.prepare('SELECT id FROM counts WHERE unit_id = ? AND date = ?').get(unitId, date)
  if (existing) {
    db.prepare('UPDATE counts SET manual = ?, electronic = ? WHERE id = ?').run(manual, electronic, existing.id)
  } else {
    db.prepare('INSERT INTO counts (unit_id, date, manual, electronic) VALUES (?, ?, ?, ?)').run(unitId, date, manual, electronic)
  }
}

function lockDate(date) {
  db.prepare('INSERT OR IGNORE INTO locks (date) VALUES (?)').run(date)
}

function unlockDate(date) {
  db.prepare('DELETE FROM locks WHERE date = ?').run(date)
}

function isDateLocked(date) {
  const row = db.prepare('SELECT date FROM locks WHERE date = ?').get(date)
  return !!row
}

function getLockedDatesForMonth(ym) {
  const rows = db.prepare('SELECT date FROM locks WHERE date LIKE ?').all(`${ym}-%`)
  return rows.map((r) => r.date)
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
}