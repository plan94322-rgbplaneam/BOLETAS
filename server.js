require('dotenv').config()
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
app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 100000 }))
app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))
const SESSION_SECRET = process.env.SESSION_SECRET || 'boletas-secret'
app.set('trust proxy', 1)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    name: 'sid',
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
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
  if (!req.session.user) {
    if (req.is('application/json')) return res.status(401).json({ ok: false, error: 'not_authenticated' })
    return res.redirect('/login')
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.is('application/json')) return res.status(403).json({ ok: false, error: 'forbidden' })
    return res.redirect('/login')
  }
  next()
}

function requireEditor(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'editor') {
    if (req.is('application/json')) return res.status(403).json({ ok: false, error: 'forbidden' })
    return res.redirect('/login')
  }
  next()
}

app.get('/login', (req, res) => {
  res.render('login', { error: null })
})

app.post('/login', async (req, res) => {
  const { username, password } = req.body
  const user = await db.getUserByUsername(username)
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

app.get('/admin', requireAdmin, async (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const units = unitsByArea
  const counts = await db.getCountsForMonth(ym)
  const lockedArr = await db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin', { areas, units, days, counts, ym, lockedDates })
})

app.get('/admin/locks', requireAdmin, async (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const lockedArr = await db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin_locks', { days, ym, lockedDates })
})

app.get('/admin/locks/', requireAdmin, async (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const lockedArr = await db.getLockedDatesForMonth(ym)
  const lockedDates = {}
  lockedArr.forEach((d) => (lockedDates[d] = true))
  res.render('admin_locks', { days, ym, lockedDates })
})

app.post('/admin/users', requireAdmin, async (req, res) => {
  const { username, password, unit_id } = req.body
  if (!username || !password || !unit_id) return res.redirect('/admin/users?error=Datos incompletos')
  const exists = await db.getUserByUsername(username)
  if (exists) return res.redirect('/admin/users?error=El usuario ya existe')
  const hash = bcrypt.hashSync(password, 10)
  const unitIdNum = parseInt(unit_id, 10)
  const ruralUnitId = 4000
  if (unitIdNum === ruralUnitId) {
    const has = await db.countUsersByUnit(unitIdNum)
    if (has > 0) return res.redirect('/admin/users?error=Ya existe un editor para Policía Rural')
  }
  await db.createEditor(username, hash, unitIdNum)
  res.redirect('/admin/users')
})

app.get('/admin/users', requireAdmin, async (req, res) => {
  const units = unitsByArea
  const users = await db.getAllUsers()
  res.render('admin_users', { areas, units, users, error: req.query.error || null })
})

app.post('/admin/users/update', requireAdmin, async (req, res) => {
  const { id, password } = req.body
  if (!id || !password) return res.redirect('/admin/users')
  const hash = bcrypt.hashSync(password, 10)
  await db.updateUserPassword(parseInt(id, 10), hash)
  res.redirect('/admin/users')
})

app.post('/admin/users/delete/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const user = await db.getUserById(id)
  if (!user) return res.redirect('/admin/users')
  if (user.role === 'admin') return res.redirect('/admin/users')
  await db.deleteUserById(id)
  res.redirect('/admin/users')
})


app.get('/admin/export', requireAdmin, async (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const counts = await db.getCountsForMonth(ym)
  const wb = xlsx.utils.book_new()
  areas.forEach((area) => {
    const sheetRows = []
    const header = ['UNIDAD', 'TIPO']
    days.forEach((d) => header.push(d.label))
    header.push('TOTAL')
    sheetRows.push(header)
    const units = (unitsByArea[area.id] || []).filter((u) => u.id !== 4000)
    units.forEach((u) => {
      const manualRow = [u.name, 'BOLETAS MANUALES']
      let manualTotal = 0
      days.forEach((d) => {
        const key = `${u.id}|${d.iso}`
        const c = counts[key] || { manual: 0, electronic: 0 }
        const v = c.manual || 0
        manualRow.push(v)
        manualTotal += v
      })
      manualRow.push(manualTotal)
      sheetRows.push(manualRow)

      const electronicRow = [u.name, 'BOLETAS ELECTRÓNICAS']
      let electronicTotal = 0
      days.forEach((d) => {
        const key = `${u.id}|${d.iso}`
        const c = counts[key] || { manual: 0, electronic: 0 }
        const v = c.electronic || 0
        electronicRow.push(v)
        electronicTotal += v
      })
      electronicRow.push(electronicTotal)
      sheetRows.push(electronicRow)
    })

    const totalsRow = ['TOTAL', '']
    let grandTotal = 0
    days.forEach((d) => {
      let sum = 0
      units.forEach((u) => {
        const key = `${u.id}|${d.iso}`
        const c = counts[key] || { manual: 0, electronic: 0 }
        sum += (c.manual || 0) + (c.electronic || 0)
      })
      totalsRow.push(sum)
      grandTotal += sum
    })
    totalsRow.push(grandTotal)
    sheetRows.push(totalsRow)

    const ws = xlsx.utils.aoa_to_sheet(sheetRows)
    xlsx.utils.book_append_sheet(wb, ws, area.name.substring(0, 31))
  })
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Disposition', `attachment; filename=boletas-${ym}.xlsx`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.send(buf)
})

app.get('/editor', requireEditor, async (req, res) => {
  const ym = ymFromQuery(req.query.month)
  const days = daysOfMonth(ym)
  const unitId = req.session.user.unit_id
  const lockedArr = await db.getLockedDatesForMonth(ym)
  const locks = {}
  lockedArr.forEach((d) => (locks[d] = true))
  if (unitId === 4000) {
    const unit = { id: 4000, name: 'POLICIA RURAL' }
    const counts = await db.getCountsForMonth(ym)
    res.render('editor', { unit, days, counts, ym, locks, areaId: 4, units: unitsByArea })
  } else {
    const unit = await db.getUnitById(unitId)
    const counts = await db.getCountsForUnitMonth(unit.id, ym)
    res.render('editor', { unit, days, counts, ym, locks })
  }
})

app.post('/editor/save', requireEditor, async (req, res) => {
  const unitId = req.session.user.unit_id
  const ym = ymFromQuery(req.body.month)
  const lockedArr = await db.getLockedDatesForMonth(ym)
  const lockSet = {}
  lockedArr.forEach((d) => (lockSet[d] = true))

  if (unitId === 4000) {
    const countsMap = await db.getCountsForMonth(ym)
    const manualObj = req.body.manual || {}
    const electronicObj = req.body.electronic || {}
    const areaUnits = unitsByArea[4] || []
    const days = daysOfMonth(ym)
    for (const u of areaUnits) {
      if (u.id === 4000) continue
      for (const d of days) {
        if (lockSet[d.iso]) continue
        const key = `${u.id}|${d.iso}`
        const prev = countsMap[key] || { manual: 0, electronic: 0 }
        const mValRaw = manualObj[u.id] && manualObj[u.id][d.iso]
        const eValRaw = electronicObj[u.id] && electronicObj[u.id][d.iso]
        const mVal = (mValRaw !== undefined && mValRaw !== '') ? parseInt(mValRaw, 10) || 0 : prev.manual
        const eVal = (eValRaw !== undefined && eValRaw !== '') ? parseInt(eValRaw, 10) || 0 : prev.electronic
        await db.upsertCount(u.id, d.iso, mVal, eVal)
      }
    }
  } else {
    const countsMap = await db.getCountsForUnitMonth(unitId, ym)
    const manualObj = req.body.manual || {}
    const electronicObj = req.body.electronic || {}
    const days = daysOfMonth(ym)
    for (const d of days) {
      if (lockSet[d.iso]) continue
      const prev = countsMap[d.iso] || { manual: 0, electronic: 0 }
      const mValRaw = manualObj[d.iso]
      const eValRaw = electronicObj[d.iso]
      const mVal = (mValRaw !== undefined && mValRaw !== '') ? parseInt(mValRaw, 10) || 0 : prev.manual
      const eVal = (eValRaw !== undefined && eValRaw !== '') ? parseInt(eValRaw, 10) || 0 : prev.electronic
      await db.upsertCount(unitId, d.iso, mVal, eVal)
    }
  }
  if (req.is('application/json')) { return res.json({ ok: true }) }
  res.redirect(`/editor?month=${ym}`)
})

app.post('/admin/lock/:date', requireAdmin, async (req, res) => {
  const date = req.params.date
  await db.lockDate(date)
  const ym = date.substring(0, 7)
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/unlock/:date', requireAdmin, async (req, res) => {
  const date = req.params.date
  await db.unlockDate(date)
  const ym = date.substring(0, 7)
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/lock-month/:ym', requireAdmin, async (req, res) => {
  const ym = req.params.ym
  const days = daysOfMonth(ym)
  for (const d of days) { await db.lockDate(d.iso) }
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/unlock-month/:ym', requireAdmin, async (req, res) => {
  const ym = req.params.ym
  const days = daysOfMonth(ym)
  for (const d of days) { await db.unlockDate(d.iso) }
  res.redirect(`/admin/locks?month=${ym}`)
})

app.post('/admin/reset', requireAdmin, async (req, res) => {
  await db.resetApp()
  req.session.destroy(() => {
    res.redirect('/login')
  })
})

app.post('/admin/reset/', requireAdmin, async (req, res) => {
  await db.resetApp()
  req.session.destroy(() => {
    res.redirect('/login')
  })
})

const PORT = process.env.PORT || 3000
;(async function(){
  await db.init()
  await db.seedAreasUnits(areas, unitsByArea)
  app.listen(PORT, () => {
    console.log(`Servidor en http://localhost:${PORT}/login`)
  })
})()