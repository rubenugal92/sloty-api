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
    // Tabla unificada de usuarios (reemplaza usuarios + users)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        phone TEXT,
        specialties TEXT,
        license TEXT,
        type TEXT DEFAULT 'fisio',
        role TEXT DEFAULT 'user',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // LEGACY: Tabla users ya no se usa (ahora todos son users con type='fisio')
    // Se mantiene solo para backward compatibility

    // Tabla de citas (con user_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        datetime TIMESTAMP NOT NULL,
        user_id INTEGER REFERENCES users(id),
        duration INTEGER DEFAULT 60,
        service TEXT DEFAULT 'physio',
        status TEXT DEFAULT 'confirmed',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)


    // Tabla de plannings de usuarios
    await client.query(`
      CREATE TABLE IF NOT EXISTS planning (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('work', 'vacation', 'sick')),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      )
    `)
  } catch (err) {
    console.error('Table creation failed:', err)
  } finally {
    client.release()
  }
})();

// ===================== SLOTS =====================
const getAvailableSlots = async (date, userId = null) => {
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

  if (userId) {
    query += ` AND user_id = $3`
    params.push(userId)
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
const bookAppointment = async (phone, datetime, service = 'physio', userId = null) => {
  const check = await pool.query(
    `SELECT id FROM appointments WHERE datetime = $1 AND user_id = $2 AND status != 'cancelled'`,
    [datetime, userId]
  )

  if (check.rows.length > 0) {
    throw new Error('Slot ocupado')
  }

  const result = await pool.query(
    `INSERT INTO appointments (phone, datetime, service, user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [phone, datetime, service, userId]
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

// ===================== users =====================
const getAllusers = async () => {
  const result = await pool.query(
    `SELECT * FROM users WHERE is_active = true ORDER BY name ASC`
  )
  return result.rows
}

const getUserById = async (id) => {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  )
  return result.rows[0] || null
}

const createUser = async (name, email, phone = null, specialties = null, license = null) => {
  const result = await pool.query(
    `INSERT INTO users (name, email, phone, specialties, license)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, email, phone, specialties, license]
  )
  return result.rows[0]
}

const updateUser = async (id, updates) => {
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
    `UPDATE users SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deleteUser = async (id) => {
  const result = await pool.query(
    `UPDATE users SET is_active = false WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

// ===================== USUARIOS =====================

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
const getPlanningByUserAndDate = async (userId, date) => {
  const result = await pool.query(
    `SELECT * FROM user_planning WHERE user_id = $1 AND date = $2`,
    [userId, date]
  )
  return result.rows[0] || null
}

const getPlanningByUser = async (userId, startDate = null, endDate = null) => {
  let query = `SELECT * FROM user_planning WHERE user_id = $1`
  const params = [userId]
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
  let query = `SELECT * FROM user_planning WHERE 1=1`
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

  query += ` ORDER BY user_id, date ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const createPlanning = async (userId, date, type, notes = null) => {
  const result = await pool.query(
    `INSERT INTO user_planning (user_id, date, type, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE
     SET type = $3, notes = $4, updated_at = NOW()
     RETURNING *`,
    [userId, date, type, notes]
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
    `UPDATE user_planning SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deletePlanning = async (id) => {
  const result = await pool.query(
    `DELETE FROM user_planning WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

const deletePlanningByUserAndDate = async (userId, date) => {
  const result = await pool.query(
    `DELETE FROM user_planning WHERE user_id = $1 AND date = $2 RETURNING *`,
    [userId, date]
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
  getAllusers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserByEmail,
  getUserByUsername,
  getPlanningByUserAndDate,
  getPlanningByUser,
  getAllPlanning,
  createPlanning,
  updatePlanning,
  deletePlanning,
  deletePlanningByUserAndDate
}