const { Pool } = require('pg');

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER || 'fisiocom',
  password: process.env.DB_PASSWORD || 'password123',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'fisiocom_db',
});

// Initialize database schema
(async () => {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      datetime TIMESTAMP NOT NULL,
      duration INTEGER DEFAULT 60,
      service TEXT DEFAULT 'physio',
      status TEXT DEFAULT 'confirmed',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('Database schema initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
})();

// Get available time slots for a given date
// Working hours: 09:00–20:00, 60 min slots
const getAvailableSlots = async (date) => {
  const start = new Date(`${date}T09:00:00`);
  const end = new Date(`${date}T20:00:00`);
  const slots = [];
  for (let time = new Date(start); time < end; time.setMinutes(time.getMinutes() + 60)) {
    slots.push(time.toTimeString().slice(0, 5)); // HH:MM
  }

  try {
    // Query booked slots for the given date
    const result = await pool.query(
      `SELECT datetime FROM appointments WHERE DATE(datetime) = $1`,
      [date]
    );
    const booked = result.rows.map(r => new Date(r.datetime).toTimeString().slice(0, 5));
    const available = slots.filter(s => !booked.includes(s));
    return available;
  } catch (err) {
    console.error('DB error:', err);
    return [];
  }
};

// Book an appointment
const bookAppointment = async (phone, datetime, service = 'physio') => {
  try {
    // Basic check to prevent double booking
    const checkResult = await pool.query(
      `SELECT id FROM appointments WHERE datetime = $1`,
      [datetime]
    );
    
    if (checkResult.rows.length > 0) {
      throw new Error('Slot already booked');
    }

    // Insert new appointment
    const insertResult = await pool.query(
      `INSERT INTO appointments (phone, datetime, service) VALUES ($1, $2, $3) RETURNING *`,
      [phone, datetime, service]
    );

    return insertResult.rows[0];
  } catch (err) {
    throw err;
  }
};

// Get all appointments
const getAllAppointments = async () => {
  try {
    const result = await pool.query(
      `SELECT * FROM appointments ORDER BY datetime ASC`
    );
    return result.rows;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
};

// Get appointments by date range
const getAppointmentsByDateRange = async (startDate, endDate) => {
  try {
    const result = await pool.query(
      `SELECT * FROM appointments WHERE datetime >= $1 AND datetime <= $2 ORDER BY datetime ASC`,
      [startDate, endDate]
    );
    return result.rows;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
};

// Get appointment by ID
const getAppointmentById = async (id) => {
  try {
    const result = await pool.query(
      `SELECT * FROM appointments WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
};

// Update appointment
const updateAppointment = async (id, updates) => {
  try {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }

    fields.push(`updated_at = $${paramCount}`);
    values.push(new Date());
    values.push(id);

    const result = await pool.query(
      `UPDATE appointments SET ${fields.join(', ')} WHERE id = $${paramCount + 1} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
};

// Delete appointment
const deleteAppointment = async (id) => {
  try {
    const result = await pool.query(
      `DELETE FROM appointments WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
};

module.exports = { 
  getAvailableSlots, 
  bookAppointment,
  getAllAppointments,
  getAppointmentsByDateRange,
  getAppointmentById,
  updateAppointment,
  deleteAppointment,
  pool 
};