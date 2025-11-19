const express = require('express')
const path = require('path')
const session = require('express-session')
const bcrypt = require('bcrypt')
const xlsx = require('xlsx')
const db = require('./src/db')
const { areas, unitsByArea } = require('./src/units')

const app = express()
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'src', 'views'))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))
const SESSION_SECRET = process.env.SESSION_SECRET || 'boletas-secret'
app.set('trust proxy', 1)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      sameSite: 'lax',
    },
  })
)

function ymFromQuery(q) {
  const now = new Date()
  const ym = q || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return ym
}

function daysOfMonth(ym) {
  const [y, m] = ym.split('-').map((v) => parseInt(v, 10))
  const last = new Date(y, m, 0).getDate()
  const arr = []
  for (let d = 1; d <= last; d++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    arr.push({ d, label: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, iso: dateStr })
  }
  return arr
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login')
  next()
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login')
  next()
}

function requireEditor(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'editor') return res.redirect('/login')
  next()
}

app.get('/login', (req, res) => {
  res.render('login', { error: null })
})

app.post('/login', (req, res) => {
  const { username, password } = req.body
  const user = db.getUserByUsername(username)
  if (!user) return res.render('login', { error: 'Usuario o contraseña inválidos' })
  const ok = bcrypt.compareSync(password, user.password_hash)
  if (!ok) return res.render('login', { error: 'Usuario o contraseña inválidos' })
  req.session.user = { id: user.id, role: user.role, unit_id: user.unit_id }
  if (user.role === 'admin') return res.redirect('/admin')
  return res.redirect('/editor')
})

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login')
  })
})

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login')
  if (req.session.user.role === 'admin') return res.redirect('/admin')
  return res.redirect('/editor')
})

app.get('/admin', requireAdmin, (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const units = unitsByArea
  const counts = db.getCountsForMonth(ym)
  const lockedArr = db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin', { areas, units, days, counts, ym, lockedDates })
})

app.get('/admin/locks', requireAdmin, (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const lockedArr = db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin_locks', { days, ym, lockedDates })
})

app.get('/admin/locks/', requireAdmin, (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const lockedArr = db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin_locks', { days, ym, lockedDates })
})

app.post('/admin/users', requireAdmin, (req, res) => {
  const { username, password, unit_id } = req.body
  if (!username || !password || !unit_id) return res.redirect('/admin/users?error=Datos incompletos')
  const exists = db.getUserByUsername(username)
  if (exists) return res.redirect('/admin/users?error=El usuario ya existe')
  const hash = bcrypt.hashSync(password, 10)
  const unitIdNum = parseInt(unit_id, 10)
  const ruralUnitId = 4000
  if (unitIdNum === ruralUnitId) {
    const has = db.countUsersByUnit(unitIdNum)
    if (has > 0) return res.redirect('/admin/users?error=Ya existe un editor para Policía Rural')
  }
  db.createEditor(username, hash, unitIdNum)
  res.redirect('/admin/users')
})

app.get('/admin/users', requireAdmin, (req, res) => {
  const units = unitsByArea
  const users = db.getAllUsers()
  res.render('admin_users', { areas, units, users, error: req.query.error || null })
})

app.post('/admin/users/update', requireAdmin, (req, res) => {
  const { id, password } = req.body
  if (!id || !password) return res.redirect('/admin/users')
  const hash = bcrypt.hashSync(password, 10)
  db.updateUserPassword(parseInt(id, 10), hash)
  res.redirect('/admin/users')
})

app.post('/admin/users/delete/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10)
  const user = db.getUserById(id)
  if (!user) return res.redirect('/admin/users')
  if (user.role === 'admin') return res.redirect('/admin/users')
  db.deleteUserById(id)
  res.redirect('/admin/users')
})


app.get('/admin/export', requireAdmin, (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const counts = db.getCountsForMonth(ym)
  const wb = xlsx.utils.book_new()
  areas.forEach((area) => {
    const sheetRows = []
    const header = ['UNIDAD']
    days.forEach((d) => {
      header.push(`${d.label} MANUALES`)
      header.push(`${d.label} ELECTRÓNICAS`)
    })
    sheetRows.push(header)
    unitsByArea[area.id].forEach((u) => {
      const row = [u.name]
      days.forEach((d) => {
        const key = `${u.id}|${d.iso}`
        const c = counts[key] || { manual: 0, electronic: 0 }
        row.push(c.manual || 0)
        row.push(c.electronic || 0)
      })
      sheetRows.push(row)
    })
    const ws = xlsx.utils.aoa_to_sheet(sheetRows)
    xlsx.utils.book_append_sheet(wb, ws, area.name.substring(0, 31))
  })
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Disposition', `attachment; filename=boletas-${ym}.xlsx`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.send(buf)
})

app.get('/editor', requireEditor, (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const unitId = req.session.user.unit_id
  const lockedArr = db.getLockedDatesForMonth(ym)
  const locks = {}
  lockedArr.forEach((d) => (locks[d] = true))
  if (unitId === 4000) {
    const unit = { id: 4000, name: 'POLICIA RURAL' }
    const counts = db.getCountsForMonth(ym)
    res.render('editor', { unit, days, counts, ym, locks, areaId: 4, units: unitsByArea })
  } else {
    const unit = db.getUnitById(unitId)
    const counts = db.getCountsForUnitMonth(unit.id, ym)
    res.render('editor', { unit, days, counts, ym, locks })
  }
})

app.post('/editor/save', requireEditor, (req, res) => {
  const unitId = req.session.user.unit_id
  const ym = ymFromQuery(req.body.month)
  const lockedArr = db.getLockedDatesForMonth(ym)
  const lockSet = {}
  lockedArr.forEach((d) => (lockSet[d] = true))

  if (unitId === 4000) {
    const countsMap = db.getCountsForMonth(ym)
    const manualObj = req.body.manual || {}
    const electronicObj = req.body.electronic || {}
    const areaUnits = unitsByArea[4] || []
    const days = daysOfMonth(ym)
    areaUnits.forEach((u) => {
      if (u.id === 4000) return
      days.forEach((d) => {
        if (lockSet[d.iso]) return
        const key = `${u.id}|${d.iso}`
        const prev = countsMap[key] || { manual: 0, electronic: 0 }
        const mValRaw = manualObj[u.id] && manualObj[u.id][d.iso]
        const eValRaw = electronicObj[u.id] && electronicObj[u.id][d.iso]
        const mVal = (mValRaw !== undefined && mValRaw !== '') ? parseInt(mValRaw, 10) || 0 : prev.manual
        const eVal = (eValRaw !== undefined && eValRaw !== '') ? parseInt(eValRaw, 10) || 0 : prev.electronic
        db.upsertCount(u.id, d.iso, mVal, eVal)
      })
    })
  } else {
    const countsMap = db.getCountsForUnitMonth(unitId, ym)
    const manualObj = req.body.manual || {}
    const electronicObj = req.body.electronic || {}
    const days = daysOfMonth(ym)
    days.forEach((d) => {
      if (lockSet[d.iso]) return
      const prev = countsMap[d.iso] || { manual: 0, electronic: 0 }
      const mValRaw = manualObj[d.iso]
      const eValRaw = electronicObj[d.iso]
      const mVal = (mValRaw !== undefined && mValRaw !== '') ? parseInt(mValRaw, 10) || 0 : prev.manual
      const eVal = (eValRaw !== undefined && eValRaw !== '') ? parseInt(eValRaw, 10) || 0 : prev.electronic
      db.upsertCount(unitId, d.iso, mVal, eVal)
    })
  }
  res.redirect(`/editor?month=${ym}`)
})

app.post('/admin/lock/:date', requireAdmin, (req, res) => {
  const date = req.params.date
  db.lockDate(date)
  const ym = date.substring(0, 7)
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/unlock/:date', requireAdmin, (req, res) => {
  const date = req.params.date
  db.unlockDate(date)
  const ym = date.substring(0, 7)
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/lock-month/:ym', requireAdmin, (req, res) => {
  const ym = req.params.ym
  const days = daysOfMonth(ym)
  days.forEach((d) => db.lockDate(d.iso))
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/unlock-month/:ym', requireAdmin, (req, res) => {
  const ym = req.params.ym
  const days = daysOfMonth(ym)
  days.forEach((d) => db.unlockDate(d.iso))
  res.redirect(`/admin/locks?month=${ym}`)
})

const PORT = process.env.PORT || 3000
db.init()
db.seedAreasUnits(areas, unitsByArea)
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}/login`)
})