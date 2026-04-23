const { Pool } = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'fisiocom',
  password: process.env.DB_PASSWORD || 'password123',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'fisiocom_db',
})

// ===================== INIT =====================
(async () => {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        datetime TIMESTAMP NOT NULL,
        duration INTEGER DEFAULT 60,
        service TEXT DEFAULT 'physio',
        status TEXT DEFAULT 'confirmed',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } finally {
    client.release()
  }
})()

// ===================== SLOTS =====================
const getAvailableSlots = async (date) => {
  const start = `${date}T00:00:00`
  const end = `${date}T23:59:59`

  const slots = []

  const startWork = new Date(`${date}T09:00:00`)
  const endWork = new Date(`${date}T20:00:00`)

  for (let t = new Date(startWork); t < endWork; t.setMinutes(t.getMinutes() + 60)) {
    slots.push(t.toTimeString().slice(0, 5))
  }

  const result = await pool.query(
    `SELECT datetime FROM appointments WHERE datetime >= $1 AND datetime <= $2`,
    [start, end]
  )

  const booked = result.rows.map(r =>
    new Date(r.datetime).toTimeString().slice(0, 5)
  )

  return slots.filter(s => !booked.includes(s))
}

// ===================== CREATE =====================
const bookAppointment = async (phone, datetime, service = 'physio') => {
  const check = await pool.query(
    `SELECT id FROM appointments WHERE datetime = $1`,
    [datetime]
  )

  if (check.rows.length > 0) {
    throw new Error('Slot ocupado')
  }

  const result = await pool.query(
    `INSERT INTO appointments (phone, datetime, service)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [phone, datetime, service]
  )

  return result.rows[0]
}

// ===================== GET ALL (FALTABA EXPORT BIEN) =====================
const getAllAppointments = async () => {
  const result = await pool.query(
    `SELECT * FROM appointments ORDER BY datetime ASC`
  )
  return result.rows
}

const getAppointmentById = async (id) => {
  const result = await pool.query(
    `SELECT * FROM appointments WHERE id = $1`,
    [id]
  )
  return result.rows[0] || null
}

const updateAppointment = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i++}`)
    values.push(v)
  }

  values.push(new Date())
  values.push(id)

  const result = await pool.query(
    `UPDATE appointments SET ${fields.join(', ')}, updated_at = $${i}
     WHERE id = $${i + 1}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deleteAppointment = async (id) => {
  const result = await pool.query(
    `DELETE FROM appointments WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

// ===================== EXPORT (CRÍTICO) =====================
module.exports = {
  pool,
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment
}