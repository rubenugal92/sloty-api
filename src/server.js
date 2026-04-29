const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentsByDateRange,
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
  getUserByUsername
} = require('./db');

const { sendMessage } = require('./whatsapp');

const app = express();

app.use(express.json());

// ===================== JWT SECRET =====================
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ===================== STATE (IMPORTANTE) =====================
const userContext = new Map();

// ===================== MIDDLEWARE DE AUTENTICACIÓN =====================
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// ===================== CORS + LOG =====================

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ===================== DÍAS =====================

const dayMap = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miércoles: 3,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sábado: 6,
  sabado: 6
};

// ===================== FECHAS (FIX REAL) =====================

const normalizeTime = (t) => t.trim().slice(0, 5);

const getNextWeekday = (weekday) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = new Date(today);
  const diff = (weekday - today.getDay() + 7) % 7;

  result.setDate(today.getDate() + (diff === 0 ? 7 : diff));

  const year = result.getFullYear();
  const month = String(result.getMonth() + 1).padStart(2, '0');
  const day = String(result.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

// ===================== WEBHOOK =====================

// Verificación del webhook (META lo requiere)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Token de verificación inválido');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages') {
            for (const message of change.value.messages || []) {
              if (message.type === 'text') {
                const from = message.from;
                const text = message.text.body.toLowerCase().trim();
                await handleMessage(from, text);
              }
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ===================== AUTH ENDPOINTS =====================

// Registro
app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createUser(username, email, hashedPassword);

    res.status(201).json({ message: 'User registered successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error registering user' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ message: 'Login successful', token, user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// ===================== LOGICA =====================

const handleMessage = async (from, text) => {
  try {

    // ---------- DETECTAR DÍA ----------
    for (const [dayName, dayIndex] of Object.entries(dayMap)) {
      if (text.includes(dayName)) {

        const targetDate = getNextWeekday(dayIndex);

        const readable = new Date(targetDate + "T00:00:00").toLocaleDateString('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'long'
        });

        // Obtener todos los fisios disponibles
        const fisios = await getAllFisios();
        const fisioList = fisios.map((f, i) => `${i + 1}. ${f.name}`).join('\n');

        userContext.set(from, { date: targetDate, step: 'selecting-fisio' });

        await sendMessage(
          from,
          `📅 ${readable}\n\n¿Con qué fisioterapeuta deseas la sesión?\n\n${fisioList}\n\nResponde con el número (ej: 1)`
        );

        return;
      }
    }

    // ---------- SELECCIONANDO FISIO ----------
    const context = userContext.get(from);
    if (context?.step === 'selecting-fisio' && /^\d+$/.test(text)) {
      const fisios = await getAllFisios();
      const fisioIndex = parseInt(text) - 1;

      if (fisioIndex < 0 || fisioIndex >= fisios.length) {
        await sendMessage(from, `❌ Número inválido. Intenta de nuevo.`);
        return;
      }

      const selectedFisio = fisios[fisioIndex];
      userContext.set(from, { ...context, fisio_id: selectedFisio.id, fisioName: selectedFisio.name, step: 'selecting-time' });

      const slots = await getAvailableSlots(context.date, selectedFisio.id);

      if (slots.length === 0) {
        await sendMessage(from, `❌ ${selectedFisio.name} no tiene disponibilidad en ${context.date}. Elige otro día.`);
        userContext.delete(from);
        return;
      }

      await sendMessage(
        from,
        `✅ Con ${selectedFisio.name}\n\nHorarios disponibles:\n${slots.join(', ')}\n\nResponde con la hora (ej: 10:00)`
      );

      return;
    }

    // ---------- COMANDO GENERAL ----------
    if (text.includes('cita') || text.includes('disponible')) {

      const today = new Date().toISOString().split('T')[0];
      const fisios = await getAllFisios();

      let response = `¿Quieres reservar una cita?\n\nResponde con un día (ej: lunes, martes, etc.)`;

      await sendMessage(from, response);

      return;
    }

    // ---------- HORA CON CONTEXTO ----------
    if (/^\d{1,2}:\d{2}$/.test(text)) {

      const time = normalizeTime(text);
      const context = userContext.get(from);

      if (!context?.date || !context?.fisio_id) {
        await sendMessage(from, "❌ Primero dime un día y un fisio");
        return;
      }

      const date = context.date;
      const fisioId = context.fisio_id;

      const available = await getAvailableSlots(date, fisioId);
      const normalized = available.map(normalizeTime);

      if (normalized.includes(time)) {

        // 🔥 FIX: Convertir a UTC restando 2 horas (CEST = UTC+2)
        // Si usuario dice 15:00 España, guardamos como 13:00 UTC en la BD
        const [hours, minutes] = time.split(':').map(Number);
        const utcHours = String((hours - 2 + 24) % 24).padStart(2, '0');
        const datetime = `${date}T${utcHours}:${minutes}:00`;

        await bookAppointment(from, datetime, 'physio', fisioId);

        await sendMessage(
          from,
          `✅ Cita confirmada para ${date} a las ${time} con ${context.fisioName}`
        );

        userContext.delete(from);

      } else {
        await sendMessage(from, `❌ Hora no disponible`);
      }

      return;
    }

    // ---------- DEFAULT ----------
    await sendMessage(
      from,
      `👋 Escribe un día (ej: lunes) o "cita"`
    );

  } catch (err) {
    console.error(err);
    await sendMessage(from, "❌ Error");
  }
};

// ===================== API =====================

app.get('/api/appointments', verifyToken, async (_, res) => {
  try {
    const appointments = await getAllAppointments();
    res.json(appointments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching appointments' });
  }
});

app.get('/api/appointments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await getAppointmentById(id);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    res.json(appointment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching appointment' });
  }
});

app.post('/api/appointments', verifyToken, async (req, res) => {
  try {
    const { phone, datetime, service, status, notes, duration, fisio_id } = req.body;

    if (!phone || !datetime || !fisio_id) {
      return res.status(400).json({ error: 'phone, datetime, and fisio_id are required' });
    }

    const appointment = await bookAppointment(phone, datetime, service, fisio_id);
    res.status(201).json(appointment);
  } catch (err) {
    console.error(err);
    if (err.message.includes('Slot ocupado')) {
      return res.status(409).json({ error: 'Slot already booked' });
    }
    res.status(500).json({ error: 'Error creating appointment' });
  }
});

app.put('/api/appointments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const appointment = await updateAppointment(id, updates);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    res.json(appointment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating appointment' });
  }
});

app.delete('/api/appointments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await deleteAppointment(id);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    res.json({ message: 'Appointment deleted', appointment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting appointment' });
  }
});

app.get('/api/slots/:date', verifyToken, async (req, res) => {
  try {
    const { date } = req.params
    const { fisio_id } = req.query

    if (!date || date === 'undefined') {
      return res.status(400).json({ error: 'Invalid date' })
    }

    const slots = await getAvailableSlots(date, fisio_id ? parseInt(fisio_id) : null)

    res.json({
      date,
      slots
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error fetching slots' })
  }
})

// ===================== FISIOS ENDPOINTS =====================

app.get('/api/fisios', verifyToken, async (_, res) => {
  try {
    const fisios = await getAllFisios();
    res.json(fisios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching fisios' });
  }
});

app.get('/api/fisios/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const fisio = await getFisioById(id);
    if (!fisio) {
      return res.status(404).json({ error: 'Fisio not found' });
    }
    res.json(fisio);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching fisio' });
  }
});

app.post('/api/fisios', verifyToken, async (req, res) => {
  try {
    const { name, email, phone, specialties, license } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const fisio = await createFisio(name, email, phone, specialties, license);
    res.status(201).json(fisio);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Error creating fisio' });
  }
});

app.put('/api/fisios/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const fisio = await updateFisio(id, updates);
    if (!fisio) {
      return res.status(404).json({ error: 'Fisio not found' });
    }
    res.json(fisio);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating fisio' });
  }
});

app.delete('/api/fisios/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const fisio = await deleteFisio(id);
    if (!fisio) {
      return res.status(404).json({ error: 'Fisio not found' });
    }
    res.json({ message: 'Fisio deleted', fisio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting fisio' });
  }
});

// ===================== START =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

module.exports = app;