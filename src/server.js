const express = require('express')

const {
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment
} = require('./db')

const app = express()

app.use(express.json())

// ===================== CORS =====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ===================== LOG =====================
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  next()
})

// ===================== HEALTH CHECK (IMPORTANTE EN RENDER) =====================
app.get('/', (_, res) => {
  res.send('OK')
})

// ===================== APPOINTMENTS =====================

// GET ALL
app.get('/api/appointments', async (_, res) => {
  try {
    const data = await getAllAppointments()
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'DB error' })
  }
})

// GET ONE
app.get('/api/appointments/:id', async (req, res) => {
  const data = await getAppointmentById(req.params.id)
  if (!data) return res.sendStatus(404)
  res.json(data)
})

// CREATE
app.post('/api/appointments', async (req, res) => {
  const { phone, datetime, service } = req.body
  const result = await bookAppointment(phone, datetime, service)
  res.json(result)
})

// UPDATE
app.put('/api/appointments/:id', async (req, res) => {
  const result = await updateAppointment(req.params.id, req.body)
  if (!result) return res.sendStatus(404)
  res.json(result)
})

// DELETE
app.delete('/api/appointments/:id', async (req, res) => {
  const result = await deleteAppointment(req.params.id)
  if (!result) return res.sendStatus(404)
  res.json(result)
})

// ===================== SLOTS =====================
app.get('/api/slots/:date', async (req, res) => {
  try {
    const slots = await getAvailableSlots(req.params.date)
    res.json({ slots })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'slots error' })
  }
})

// ===================== START =====================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 ${PORT}`))

module.exports = app