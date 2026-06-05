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
    // Tabla de empresas (VADA)
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        company_code TEXT UNIQUE NOT NULL,
        contact_email TEXT,
        phone TEXT,
        whatsapp_phone_number_id TEXT,
        whatsapp_access_token TEXT,
        whatsapp_display_number TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Migraciones (instalaciones existentes)
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT`)
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_access_token    TEXT`)
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_display_number  TEXT`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS companies_waba_phone_id_uidx ON companies (whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL`)

    // Tabla unificada de usuarios (reemplaza usuarios + users)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        username TEXT UNIQUE,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        phone TEXT,
        type TEXT DEFAULT 'staff',
        specialties TEXT,
        role TEXT DEFAULT 'user',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // NOTA: el campo `type` es string libre (cargo/puesto): peluquero, fisio, camarero, etc.

    // Tabla de citas (con user_id y company_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        phone TEXT NOT NULL,
        customer_name TEXT,
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

    // Migración: añadir customer_name a tablas existentes
    await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_name TEXT`)


    // Tabla de plannings de usuarios (con company_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS planning (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('work', 'vacation', 'sick')),
        start_time TIME,
        end_time TIME,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      )
    `)

    // Migraciones (ALTER si la tabla ya existía)
    await client.query(`ALTER TABLE planning ADD COLUMN IF NOT EXISTS start_time TIME`)
    await client.query(`ALTER TABLE planning ADD COLUMN IF NOT EXISTS end_time   TIME`)

    // Índice único parcial para prevenir doble-booking del mismo empleado en el mismo datetime
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS appointments_user_datetime_active_uidx
      ON appointments (user_id, datetime)
      WHERE status != 'cancelled'
    `)

    // Tabla de registro de acciones de sesión (para debugging y auditoría)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_actions (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        company_id INTEGER REFERENCES companies(id),
        action TEXT NOT NULL,
        step TEXT,
        session_data JSONB,
        error_message TEXT,
        success BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Índice para búsquedas rápidas por teléfono
    await client.query(`
      CREATE INDEX IF NOT EXISTS session_actions_phone_idx ON session_actions(phone, created_at DESC)
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
  const end   = `${date}T23:59:59`
  const slots = []

  // Rango horario por defecto (local España): 09:00-20:00
  let startHourLocal = 9
  let endHourLocal   = 20

  if (userId) {
    const planning = await getPlanningByUserAndDate(userId, date)
    if (planning && planning.type !== 'work') return []
    if (planning && planning.start_time) {
      startHourLocal = parseInt(planning.start_time.slice(0, 2), 10)
    }
    if (planning && planning.end_time) {
      endHourLocal = parseInt(planning.end_time.slice(0, 2), 10)
    }
  }

  // Generar slots locales y guardarlos en formato "HH:MM"
  for (let h = startHourLocal; h < endHourLocal; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`)
  }

  // Excluir slots ya bookeados para ese user
  let query = `SELECT datetime FROM appointments WHERE datetime >= $1 AND datetime <= $2 AND status != 'cancelled'`
  let params = [start, end]
  if (userId) {
    query += ` AND user_id = $3`
    params.push(userId)
  }

  const result = await pool.query(query, params)
  const booked = result.rows.map(r => {
    const utcTime = new Date(r.datetime)
    const localTime = new Date(utcTime.getTime() + 2 * 60 * 60 * 1000)
    return localTime.toISOString().slice(11, 16)
  })

  return slots.filter(s => !booked.includes(s))
}

const getAvailableUsersForDate = async (date, company_id = null) => {
  let query = `SELECT u.* FROM users u
     INNER JOIN planning p ON u.id = p.user_id AND p.date = $1
     WHERE u.is_active = true AND p.type = 'work'`
  const params = [date]
  
  if (company_id) {
    query += ` AND u.company_id = $2`
    params.push(company_id)
  }
  
  query += ` ORDER BY u.name ASC`
  
  const result = await pool.query(query, params)
  return result.rows
}

// ===================== CREATE =====================
const bookAppointment = async (phone, datetime, service = 'physio', userId = null, notes = null, company_id = null, customer_name = null) => {
  const check = await pool.query(
    `SELECT id FROM appointments WHERE datetime = $1 AND user_id = $2 AND status != 'cancelled'`,
    [datetime, userId]
  )

  if (check.rows.length > 0) {
    throw new Error('Slot ocupado')
  }

  // Generar custom_id: phone + datetime + random
  // Formato: "34612345678-20240515-1500-abc123"
  const dateObj = new Date(datetime)
  const dateStr = dateObj.toISOString().split('T')[0].replace(/-/g, '') // YYYYMMDD
  const timeStr = dateObj.toISOString().split('T')[1].slice(0, 5).replace(':', '') // HHMM
  const randomId = Math.random().toString(36).substring(2, 8).toUpperCase()
  const custom_id = `${phone}-${dateStr}-${timeStr}-${randomId}`

  const result = await pool.query(
    `INSERT INTO appointments (company_id, phone, customer_name, datetime, service, user_id, notes, custom_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [company_id, phone, customer_name, datetime, service, userId, notes, custom_id]
  )

  return result.rows[0]
}

// Devuelve el último nombre conocido para un teléfono (para que el bot recuerde al cliente)
const getLastCustomerNameByPhone = async (phone) => {
  const result = await pool.query(
    `SELECT customer_name FROM appointments
     WHERE phone = $1 AND customer_name IS NOT NULL AND customer_name != ''
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone]
  )
  return result.rows[0]?.customer_name || null
}

// ===================== GET ALL (FALTABA EXPORT BIEN) =====================
const getAllAppointments = async (company_id = null) => {
  let query = `
    SELECT a.*,
           u.name AS user_name,
           u.specialties AS user_specialties
    FROM appointments a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE 1=1`
  const params = []

  if (company_id) {
    query += ` AND a.company_id = $1`
    params.push(company_id)
  }

  query += ` ORDER BY a.datetime ASC`

  const result = await pool.query(query, params)
  return result.rows
}

const getAppointmentById = async (id, company_id = null) => {
  let query = `
    SELECT a.*,
           u.name AS user_name,
           u.specialties AS user_specialties
    FROM appointments a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.id = $1`
  const params = [id]

  if (company_id) {
    query += ` AND a.company_id = $2`
    params.push(company_id)
  }

  const result = await pool.query(query, params)
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

const getAppointmentByCustomId = async (custom_id, company_id = null) => {
  let query = `SELECT * FROM appointments WHERE custom_id = $1 AND status != 'cancelled'`
  const params = [custom_id]
  
  if (company_id !== null) {
    query += ` AND company_id = $2`
    params.push(company_id)
  }
  
  const result = await pool.query(query, params)
  return result.rows[0]
}

const cancelAppointmentByCustomId = async (custom_id, company_id = null) => {
  let query = `UPDATE appointments SET status = 'cancelled', updated_at = NOW() 
     WHERE custom_id = $1 AND status != 'cancelled'`
  const params = [custom_id]
  let paramIndex = 2
  
  if (company_id !== null) {
    query += ` AND company_id = $${paramIndex}`
    params.push(company_id)
    paramIndex++
  }
  
  query += ` RETURNING *`
  
  const result = await pool.query(query, params)
  return result.rows[0]
}

// ===================== users =====================
const getAllUsers = async (company_id = null) => {
  let query = `SELECT * FROM users WHERE is_active = true`
  const params = []
  
  if (company_id) {
    query += ` AND company_id = $1`
    params.push(company_id)
  }
  
  query += ` ORDER BY name ASC`
  
  const result = await pool.query(query, params)
  return result.rows
}

const getUserById = async (id, company_id = null) => {
  let query = `SELECT * FROM users WHERE id = $1`
  const params = [id]
  
  if (company_id) {
    query += ` AND company_id = $2`
    params.push(company_id)
  }
  
  const result = await pool.query(query, params)
  return result.rows[0] || null
}

const createUser = async (username, name, email, password, phone = null, type = null, specialties = null, company_id = null) => {
  const result = await pool.query(
    `INSERT INTO users (company_id, username, name, email, password, phone, type, specialties)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [company_id, username, name, email, password, phone, type, specialties]
  )
  return result.rows[0]
}

const updateUser = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  for (const [k, v] of Object.entries(updates)) {
    if (['username', 'name', 'email', 'password', 'phone', 'type', 'specialties', 'is_active'].includes(k)) {
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
const getPlanningByUserAndDate = async (userId, date, company_id = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user 
     FROM planning p
     JOIN users u ON p.user_id = u.id
     WHERE p.user_id = $1 AND p.date = $2`
  const params = [userId, date]
  
  if (company_id) {
    query += ` AND p.company_id = $3`
    params.push(company_id)
  }
  
  const result = await pool.query(query, params)
  return result.rows[0] || null
}

const getPlanningById = async (id, company_id = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user 
     FROM planning p
     JOIN users u ON p.user_id = u.id
     WHERE p.id = $1`
  const params = [id]

  if (company_id) {
    query += ` AND p.company_id = $2`
    params.push(company_id)
  }

  const result = await pool.query(query, params)
  return result.rows[0] || null
}

const getPlanningByUser = async (userId, startDate = null, endDate = null, company_id = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user FROM planning p
               JOIN users u ON p.user_id = u.id
               WHERE p.user_id = $1`
  const params = [userId]
  let i = 2

  if (company_id) {
    query += ` AND p.company_id = $${i}`
    params.push(company_id)
    i++
  }

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

const getAllPlanning = async (startDate = null, endDate = null, company_id = null) => {
  let query = `SELECT p.*, json_build_object('id', u.id, 'name', u.name, 'email', u.email) as user FROM planning p
               JOIN users u ON p.user_id = u.id
               WHERE 1=1`
  const params = []
  let i = 1

  if (company_id) {
    query += ` AND p.company_id = $${i}`
    params.push(company_id)
    i++
  }

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

const createPlanning = async (userId, date, type, notes = null, company_id = null, start_time = null, end_time = null) => {
  const result = await pool.query(
    `INSERT INTO planning (company_id, user_id, date, type, notes, start_time, end_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, date) DO UPDATE
     SET type = $4, notes = $5, start_time = $6, end_time = $7, updated_at = NOW()
     RETURNING *`,
    [company_id, userId, date, type, notes, start_time, end_time]
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

// ===================== COMPANIES =====================
const createCompany = async (name, company_code, contact_email = null, phone = null, whatsapp = {}) => {
  const result = await pool.query(
    `INSERT INTO companies (name, company_code, contact_email, phone, whatsapp_phone_number_id, whatsapp_access_token, whatsapp_display_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      name, company_code, contact_email, phone,
      whatsapp.phone_number_id || null,
      whatsapp.access_token || null,
      whatsapp.display_number || null,
    ]
  )
  return result.rows[0]
}

const getAllCompanies = async () => {
  const result = await pool.query(
    `SELECT * FROM companies WHERE is_active = true ORDER BY name ASC`
  )
  return result.rows
}

const getCompanyById = async (id) => {
  const result = await pool.query(
    `SELECT * FROM companies WHERE id = $1 AND is_active = true`,
    [id]
  )
  return result.rows[0]
}

const getCompanyByCode = async (company_code) => {
  const result = await pool.query(
    `SELECT * FROM companies WHERE company_code = $1 AND is_active = true`,
    [company_code]
  )
  return result.rows[0]
}

const getCompanyByWhatsappPhoneId = async (phone_number_id) => {
  if (!phone_number_id) return null
  const result = await pool.query(
    `SELECT * FROM companies WHERE whatsapp_phone_number_id = $1 AND is_active = true LIMIT 1`,
    [phone_number_id]
  )
  return result.rows[0] || null
}

const updateCompany = async (id, updates) => {
  const fields = []
  const values = []
  let i = 1

  const allowed = [
    'name', 'contact_email', 'phone', 'is_active',
    'whatsapp_phone_number_id', 'whatsapp_access_token', 'whatsapp_display_number',
  ]
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) {
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
    `UPDATE companies SET ${fields.join(', ')}
     WHERE id = $${i}
     RETURNING *`,
    values
  )

  return result.rows[0]
}

// ===================== SESSION ACTIONS (Logging) =====================
const logSessionAction = async (phone, action, step = null, sessionData = null, errorMsg = null, success = true, company_id = null) => {
  const result = await pool.query(
    `INSERT INTO session_actions (phone, company_id, action, step, session_data, error_message, success)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [phone, company_id, action, step, sessionData ? JSON.stringify(sessionData) : null, errorMsg, success]
  )
  return result.rows[0]
}

const getSessionActionHistory = async (phone, company_id = null, limit = 50) => {
  let query = `SELECT * FROM session_actions WHERE phone = $1`
  const params = [phone]
  let i = 2

  if (company_id) {
    query += ` AND company_id = $${i}`
    params.push(company_id)
    i++
  }

  query += ` ORDER BY created_at DESC LIMIT $${i}`
  params.push(limit)

  const result = await pool.query(query, params)
  return result.rows
}

const getFailedSessionActions = async (company_id = null, limit = 100) => {
  let query = `SELECT * FROM session_actions WHERE success = false`
  const params = []
  let i = 1

  if (company_id) {
    query += ` AND company_id = $${i}`
    params.push(company_id)
    i++
  }

  query += ` ORDER BY created_at DESC LIMIT $${i}`
  params.push(limit)

  const result = await pool.query(query, params)
  return result.rows
}

module.exports = {
  pool,
  getAvailableSlots,
  bookAppointment,
  getLastCustomerNameByPhone,
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
  getPlanningById,
  getPlanningByUser,
  getAvailableUsersForDate,
  getAllPlanning,
  createPlanning,
  updatePlanning,
  deletePlanning,
  deletePlanningByUserAndDate,
  createCompany,
  getAllCompanies,
  getCompanyById,
  getCompanyByCode,
  getCompanyByWhatsappPhoneId,
  updateCompany,
  logSessionAction,
  getSessionActionHistory,
  getFailedSessionActions
}