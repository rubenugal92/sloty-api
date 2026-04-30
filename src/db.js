const { Pool } = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'fisiocom',
  password: process.env.DB_PASSWORD || 'password123',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'fisiocom_db',
});

// ===================== INIT =====================
(async () => {
  const client = await pool.connect()
  try {
    // Tabla de usuarios para login
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de fisioterapeutas
    await client.query(`
      CREATE TABLE IF NOT EXISTS fisios (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        specialties TEXT,
        license TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de citas (modificada con fisio_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        datetime TIMESTAMP NOT NULL,
        fisio_id INTEGER REFERENCES fisios(id),
        duration INTEGER DEFAULT 60,
        service TEXT DEFAULT 'physio',
        status TEXT DEFAULT 'confirmed',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Agregar columna license si no existe (para bases de datos existentes)
    await client.query(`
      ALTER TABLE fisios 
      ADD COLUMN IF NOT EXISTS license TEXT
    `)

    // Agregar columna fisio_id si no existe (para bases de datos existentes)
    await client.query(`
      ALTER TABLE appointments 
      ADD COLUMN IF NOT EXISTS fisio_id INTEGER REFERENCES fisios(id)
    `)

    // Tabla de plannings de fisios
    await client.query(`
      CREATE TABLE IF NOT EXISTS fisio_planning (
        id SERIAL PRIMARY KEY,
        fisio_id INTEGER NOT NULL REFERENCES fisios(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('work', 'vacation', 'sick')),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(fisio_id, date)
      )
    `)
  } catch (err) {
    console.error('Table creation failed:', err)
  } finally {
    client.release()
  }
})();

// ===================== SLOTS =====================
const getAvailableSlots = async (date, fisioId = null) => {
  const start = `${date}T00:00:00`
  const end = `${date}T23:59:59`

  const slots = []

  // 🔥 FIX: Horarios de trabajo en UTC (09:00-20:00 España = 07:00-18:00 UTC)
  const startWork = new Date(`${date}T07:00:00`)
  const endWork = new Date(`${date}T18:00:00`)

  for (let t = new Date(startWork); t < endWork; t.setMinutes(t.getMinutes() + 60)) {
    // Mostrar en zona horaria local España (UTC+2)
    const localTime = new Date(t.getTime() + 2 * 60 * 60 * 1000)
    slots.push(localTime.toTimeString().slice(0, 5))
  }

  let query = `SELECT datetime FROM appointments WHERE datetime >= $1 AND datetime <= $2 AND status != 'cancelled'`
  let params = [start, end]

  if (fisioId) {
    query += ` AND fisio_id = $3`
    params.push(fisioId)
  }

  const result = await pool.query(query, params)

  const booked = result.rows.map(r => {
    // Convertir UTC a zona horaria local España
    const utcTime = new Date(r.datetime)
    const localTime = new Date(utcTime.getTime() + 2 * 60 * 60 * 1000)
    return localTime.toTimeString().slice(0, 5)
  })

  return slots.filter(s => !booked.includes(s))
}

// ===================== CREATE =====================
const bookAppointment = async (phone, datetime, service = 'physio', fisioId = null) => {
  const check = await pool.query(
    `SELECT id FROM appointments WHERE datetime = $1 AND fisio_id = $2 AND status != 'cancelled'`,
    [datetime, fisioId]
  )

  if (check.rows.length > 0) {
    throw new Error('Slot ocupado')
  }

  const result = await pool.query(
    `INSERT INTO appointments (phone, datetime, service, fisio_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [phone, datetime, service, fisioId]
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
    fields.push(`${k} = $${i}`)
    values.push(v)
    i++
  }

  fields.push(`updated_at = $${i}`)
  values.push(new Date())
  i++

  values.push(id)

  const result = await pool.query(
    `UPDATE appointments SET ${fields.join(', ')}
     WHERE id = $${i}
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

// ===================== FISIOS =====================
const getAllFisios = async () => {
  const result = await pool.query(
    `SELECT * FROM fisios WHERE is_active = true ORDER BY name ASC`
  )
  return result.rows
}

const getFisioById = async (id) => {
  const result = await pool.query(
    `SELECT * FROM fisios WHERE id = $1`,
    [id]
  )
  return result.rows[0] || null
}

const createFisio = async (name, email, phone = null, specialties = null, license = null) => {
  const result = await pool.query(
    `INSERT INTO fisios (name, email, phone, specialties, license)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, email, phone, specialties, license]
  )
  return result.rows[0]
}

const updateFisio = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  for (const [k, v] of Object.entries(updates)) {
    if (['name', 'email', 'phone', 'specialties', 'license', 'is_active'].includes(k)) {
      fields.push(`${k} = $${i}`)
      values.push(v)
      i++
    }
  }

  if (fields.length === 0) return null

  fields.push(`updated_at = $${i}`)
  values.push(new Date())
  i++

  values.push(id)

  const result = await pool.query(
    `UPDATE fisios SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deleteFisio = async (id) => {
  const result = await pool.query(
    `UPDATE fisios SET is_active = false WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

// ===================== USUARIOS =====================
const createUser = async (username, email, password, role = 'admin') => {
  const result = await pool.query(
    `INSERT INTO users (username, email, password, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, role`,
    [username, email, password, role]
  )
  return result.rows[0]
}

const getUserByEmail = async (email) => {
  const result = await pool.query(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  )
  return result.rows[0] || null
}

const getUserByUsername = async (username) => {
  const result = await pool.query(
    `SELECT * FROM users WHERE username = $1`,
    [username]
  )
  return result.rows[0] || null
}

// ===================== PLANNING =====================
const getPlanningByFisioAndDate = async (fisioId, date) => {
  const result = await pool.query(
    `SELECT * FROM fisio_planning WHERE fisio_id = $1 AND date = $2`,
    [fisioId, date]
  )
  return result.rows[0] || null
}

const getPlanningByFisio = async (fisioId, startDate = null, endDate = null) => {
  let query = `SELECT * FROM fisio_planning WHERE fisio_id = $1`
  const params = [fisioId]
  let i = 2

  if (startDate) {
    query += ` AND date >= $${i}`
    params.push(startDate)
    i++
  }
  if (endDate) {
    query += ` AND date <= $${i}`
    params.push(endDate)
    i++
  }

  query += ` ORDER BY date ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const getAllPlanning = async (startDate = null, endDate = null) => {
  let query = `SELECT * FROM fisio_planning WHERE 1=1`
  const params = []
  let i = 1

  if (startDate) {
    query += ` AND date >= $${i}`
    params.push(startDate)
    i++
  }
  if (endDate) {
    query += ` AND date <= $${i}`
    params.push(endDate)
    i++
  }

  query += ` ORDER BY fisio_id, date ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const createPlanning = async (fisioId, date, type, notes = null) => {
  const result = await pool.query(
    `INSERT INTO fisio_planning (fisio_id, date, type, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fisio_id, date) DO UPDATE
     SET type = $3, notes = $4, updated_at = NOW()
     RETURNING *`,
    [fisioId, date, type, notes]
  )
  return result.rows[0]
}

const updatePlanning = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  for (const [k, v] of Object.entries(updates)) {
    if (['type', 'notes'].includes(k)) {
      fields.push(`${k} = $${i}`)
      values.push(v)
      i++
    }
  }

  if (fields.length === 0) return null

  fields.push(`updated_at = $${i}`)
  values.push(new Date())
  i++

  values.push(id)

  const result = await pool.query(
    `UPDATE fisio_planning SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deletePlanning = async (id) => {
  const result = await pool.query(
    `DELETE FROM fisio_planning WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

const deletePlanningByFisioAndDate = async (fisioId, date) => {
  const result = await pool.query(
    `DELETE FROM fisio_planning WHERE fisio_id = $1 AND date = $2 RETURNING *`,
    [fisioId, date]
  )
  return result.rows[0]
}

module.exports = {
  pool,
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment,
  getAllFisios,
  getFisioById,
  createFisio,
  updateFisio,
  deleteFisio,
  createUser,
  getUserByEmail,
  getUserByUsername,
  getPlanningByFisioAndDate,
  getPlanningByFisio,
  getAllPlanning,
  createPlanning,
  updatePlanning,
  deletePlanning,
  deletePlanningByFisioAndDate
}