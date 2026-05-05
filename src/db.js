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
        type TEXT DEFAULT 'fisio',
        specialties TEXT,
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
        custom_id TEXT UNIQUE,
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

  // Si el usuario no trabaja ese día, no hay slots disponibles.
  if (userId) {
    const planning = await getPlanningByUserAndDate(userId, date)
    if (planning && planning.type !== 'work') {
      return []
    }
  }

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

const getAvailableUsersForDate = async (date) => {
  const result = await pool.query(
    `SELECT u.* FROM users u
     INNER JOIN planning p ON u.id = p.user_id AND p.date = $1
     WHERE u.is_active = true AND p.type = 'work'
     ORDER BY u.name ASC`,
    [date]
  )
  return result.rows
}

// ===================== CREATE =====================
const bookAppointment = async (phone, datetime, service = 'physio', userId = null, notes = null) => {
  const check = await pool.query(
    `SELECT id FROM appointments WHERE datetime = $1 AND user_id = $2 AND status != 'cancelled'`,
    [datetime, userId]
  )

  if (check.rows.length > 0) {
    throw new Error('Slot ocupado')
  }

  // Generar custom_id: phone + datetime + random
  // Formato: "34612345678-20240515-1500-abc123"
  console.log('datetime recibido:', datetime)
  const dateObj = new Date(datetime)
  console.log('dateObj:', dateObj)
  const dateStr = dateObj.toISOString().split('T')[0].replace(/-/g, '') // YYYYMMDD
  const timeStr = dateObj.toISOString().split('T')[1].slice(0, 5).replace(':', '') // HHMM
  const randomId = Math.random().toString(36).substring(2, 8).toUpperCase()
  const custom_id = `${phone}-${dateStr}-${timeStr}-${randomId}`

  const result = await pool.query(
    `INSERT INTO appointments (phone, datetime, service, user_id, notes, custom_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [phone, datetime, service, userId, notes, custom_id]
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

const getAppointmentByCustomId = async (custom_id) => {
  const result = await pool.query(
    `SELECT * FROM appointments WHERE custom_id = $1 AND status != 'cancelled'`,
    [custom_id]
  )
  return result.rows[0]
}

const cancelAppointmentByCustomId = async (custom_id) => {
  const result = await pool.query(
    `UPDATE appointments SET status = 'cancelled', updated_at = NOW() 
     WHERE custom_id = $1 AND status != 'cancelled'
     RETURNING *`,
    [custom_id]
  )
  return result.rows[0]
}

// ===================== users =====================
const getAllUsers = async () => {
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

const createUser = async (username,name, email, password, phone = null, type = null, specialties = null) => {
  const result = await pool.query(
    `INSERT INTO users (username, name, email, password, phone, type, specialties)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [username, name, email, password, phone, type, specialties]
  )
  return result.rows[0]
}

const updateUser = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  for (const [k, v] of Object.entries(updates)) {
    if (['username', 'name', 'email', 'phone', 'type', 'specialties', 'is_active'].includes(k)) {
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
    `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user 
     FROM planning p
     JOIN users u ON p.user_id = u.id
     WHERE p.user_id = $1 AND p.date = $2`,
    [userId, date]
  )
  return result.rows[0] || null
}

const getPlanningByUser = async (userId, startDate = null, endDate = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user FROM planning p
               JOIN users u ON p.user_id = u.id
               WHERE p.user_id = $1`
  const params = [userId]
  let i = 2

  if (startDate) {
    query += ` AND p.date >= $${i}`
    params.push(startDate)
    i++
  }
  if (endDate) {
    query += ` AND p.date <= $${i}`
    params.push(endDate)
    i++
  }

  query += ` ORDER BY p.date ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const getAllPlanning = async (startDate = null, endDate = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user FROM planning p
               JOIN users u ON p.user_id = u.id
               WHERE 1=1`
  const params = []
  let i = 1

  if (startDate) {
    query += ` AND p.date >= $${i}`
    params.push(startDate)
    i++
  }
  if (endDate) {
    query += ` AND p.date <= $${i}`
    params.push(endDate)
    i++
  }

  query += ` ORDER BY p.user_id, p.date ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const createPlanning = async (userId, date, type, notes = null) => {
  const result = await pool.query(
    `INSERT INTO planning (user_id, date, type, notes)
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
    `UPDATE planning SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

const deletePlanning = async (id) => {
  const result = await pool.query(
    `DELETE FROM planning WHERE id = $1 RETURNING *`,
    [id]
  )
  return result.rows[0]
}

const deletePlanningByUserAndDate = async (userId, date) => {
  const result = await pool.query(
    `DELETE FROM planning WHERE user_id = $1 AND date = $2 RETURNING *`,
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
  getAppointmentByCustomId,
  cancelAppointmentByCustomId,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserByEmail,
  getUserByUsername,
  getPlanningByUserAndDate,
  getPlanningByUser,
  getAvailableUsersForDate,
  getAllPlanning,
  createPlanning,
  updatePlanning,
  deletePlanning,
  deletePlanningByUserAndDate
}