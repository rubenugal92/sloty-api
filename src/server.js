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

const monthMap = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
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

const formatReadableDate = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
};

const parseSpanishDate = (text) => {
  const explicitDate = text.match(/(\b\d{1,2})\s*(?:de\s*)?([a-záéíóúñ]+)(?:\s*(?:de\s*)?\s*(\d{4}))?/i);
  if (!explicitDate) return null;

  const day = parseInt(explicitDate[1], 10);
  const monthName = explicitDate[2].toLowerCase();
  const yearPart = explicitDate[3];
  const month = monthMap[monthName];

  if (!month || day < 1 || day > 31) return null;

  let year = yearPart ? parseInt(yearPart, 10) : new Date().getFullYear();
  const candidate = new Date(year, month - 1, day);

  if (candidate.getDate() !== day || candidate.getMonth() !== month - 1) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  candidate.setHours(0, 0, 0, 0);

  if (!yearPart && candidate < today) {
    candidate.setFullYear(year + 1);
  }

  return candidate.toISOString().split('T')[0];
};

const parseNumericDate = (text) => {
  const numericDate = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?\b/);
  if (!numericDate) return null;

  const day = parseInt(numericDate[1], 10);
  const month = parseInt(numericDate[2], 10);
  let year = numericDate[3] ? parseInt(numericDate[3], 10) : new Date().getFullYear();

  if (!numericDate[3] && new Date(year, month - 1, day) < new Date()) {
    year += 1;
  }

  const candidate = new Date(year, month - 1, day);
  if (candidate.getDate() !== day || candidate.getMonth() !== month - 1) return null;

  return candidate.toISOString().split('T')[0];
};

const parseDateFromText = (text) => {
  const explicitDate = parseSpanishDate(text) || parseNumericDate(text);
  if (explicitDate) return explicitDate;

  for (const [dayName, dayIndex] of Object.entries(dayMap)) {
    if (text.includes(dayName)) {
      return getNextWeekday(dayIndex);
    }
  }

  return null;
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
    const { username, name, email, password, specialities, phone, type } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createUser(username, name, email, hashedPassword, specialities, phone, type);

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

    res.json({ message: 'Login successful', token, user: { id: user.id, email: user.email, username: user.username, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// ===================== LOGICA =====================

const handleMessage = async (from, text) => {
  try {
    const context = userContext.get(from);
    const targetDate = context?.step === 'awaiting-date' ? parseDateFromText(text) : parseDateFromText(text);

    if (targetDate && (context?.step === 'awaiting-date' || !context)) {
      const readable = formatReadableDate(targetDate);
      const users = await getAvailableUsersForDate(targetDate);

      if (users.length === 0) {
        await sendMessage(from, `¡Vaya! Lo sentimos mucho, no hay fisioterapeutas disponibles el ${readable}. Si no le importa, mejor pruebe con otra fecha.`);
        return;
      }

      const userList = users.map((u, i) => `${i + 1}. ${u.name}`).join('\n');
      userContext.set(from, { date: targetDate, step: 'selecting-user', availableUsers: users });

      await sendMessage(
        from,
        `📅 ${readable}\n\nPara este día, estos son los fisioterapeutas disponibles:\n\n${userList}\n\nSelecciona cual quieres que te atienda indicando su número en el listado (ej: 1)`
      );

      return;
    }

    // ---------- SELECCIONANDO User ----------
    if (context?.step === 'selecting-user' && /^\d+$/.test(text)) {
      const users = context.availableUsers || await getAvailableUsersForDate(context.date);
      const userIndex = parseInt(text, 10) - 1;

      if (userIndex < 0 || userIndex >= users.length) {
        await sendMessage(from, `❌ Número inválido. Responde con el número del fisioterapeuta que aparece en la lista.`);
        return;
      }

      const selectedUser = users[userIndex];

      // Validar si el usuario está disponible ese día (no de vacaciones ni de baja)
      const planning = await getPlanningByUserAndDate(selectedUser.id, context.date);
      if (planning && (planning.type === 'vacation' || planning.type === 'sick')) {
        await sendMessage(from, `❌ ${selectedUser.name} no está disponible el ${formatReadableDate(context.date)}. Elige otro día o usuario.`);
        userContext.delete(from);
        return;
      }

      userContext.set(from, { ...context, user_id: selectedUser.id, userName: selectedUser.name, step: 'selecting-time' });

      const slots = await getAvailableSlots(context.date, selectedUser.id);

      if (slots.length === 0) {
        await sendMessage(from, `❌ ${selectedUser.name} no tiene disponibilidad el ${formatReadableDate(context.date)}. Elige otro día.`);
        userContext.delete(from);
        return;
      }

      await sendMessage(
        from,
        `✅ ¡Genial! Pues que sea con ${selectedUser.name}\n\n Sus horarios disponibles son los siguientes:\n${slots.join(', ')}\n\nResponde con la hora tal y como se muestra en el ejemplo (ejemplo: 10:00)`
      );

      return;
    }

    // ---------- COMANDO GENERAL (MENSAJE INICIAL) ----------
    if (text.includes('cita') || text.includes('disponible') || text.includes('hola') || !context) {
      const response = `¡Hola! 👋 Bienvenido a FisioCom.\n\n¿Qué necesitas?\n\n1️⃣ Escriba "cita" para RESERVAR una cita\n2️⃣ Escriba "anular" para CANCELAR una cita existente\n\nEstamos aquí para ayudarte 😊`;
      userContext.set(from, { step: 'choosing-action' });
      await sendMessage(from, response);
      return;
    }

    // ---------- ELEGIR ACCIÓN (Cita o Anular) ----------
    if (context?.step === 'choosing-action') {
      const lowerText = text.toLowerCase();
      
      if (lowerText.includes('cita') || lowerText.includes('reserv')) {
        // Flujo de NUEVA CITA
        userContext.set(from, { step: 'awaiting-date' });
        await sendMessage(from, `✅ Perfecto. Vamos a reservar tu cita.\n\n¿Para qué día la necesitas? Escribe:\n- lunes\n- próximo miércoles\n- 22 de mayo\n- 22/05`);
        return;
      }
      
      if (lowerText.includes('anular') || lowerText.includes('cancelar') || lowerText.includes('eliminar')) {
        // Flujo de ANULAR CITA
        userContext.set(from, { step: 'asking-cancel-id' });
        await sendMessage(from, `❌ Vamos a anular tu cita.\n\n¿Cuál es el ID de tu cita? (Te lo proporcionamos cuando la reservaste, formato: 34612345678-20240515-1500-ABC123)`);
        return;
      }
      
      await sendMessage(from, `❌ No entiendo. Por favor escribe "cita" para reservar o "anular" para cancelar.`);
      return;
    }

    // ---------- PEDIR ID PARA ANULAR ----------
    if (context?.step === 'asking-cancel-id') {
      const customId = text.trim().toUpperCase();
      
      try {
        const appointment = await getAppointmentByCustomId(customId);
        
        if (!appointment) {
          await sendMessage(from, `❌ No encontramos una cita con ese ID. Verifica que sea correcto e intenta de nuevo.`);
          return;
        }
        
        // Confirmar cancelación
        await cancelAppointmentByCustomId(customId);
        await sendMessage(from, `✅ ¡Cita cancelada correctamente!\n\nTu cita del ${appointment.datetime.split('T')[0]} a las ${appointment.datetime.split('T')[1].slice(0, 5)} ha sido anulada.`);
        userContext.delete(from);
      } catch (error) {
        console.error('Error cancelando cita:', error);
        await sendMessage(from, `❌ Error al cancelar la cita. Intenta de nuevo.`);
        userContext.delete(from);
      }
      return;
    }

    // ---------- HORA CON CONTEXTO ----------
    if (/^\d{1,2}:\d{2}$/.test(text)) {

      const time = normalizeTime(text);
      const context = userContext.get(from);

      if (!context?.date || !context?.user_id) {
        await sendMessage(from, "❌ Primero dime un día y un usuario");
        return;
      }

      const date = context.date;
      const userId = context.user_id;

      const available = await getAvailableSlots(date, userId);
      const normalized = available.map(normalizeTime);

      if (normalized.includes(time)) {

        // 🔥 FIX: Convertir a UTC restando 2 horas (CEST = UTC+2)
        // Si usuario dice 15:00 España, guardamos como 13:00 UTC en la BD
        const [hours, minutes] = time.split(':').map(Number);

        const utcHours = String((hours - 2 + 24) % 24).padStart(2, '0');
        const utcMinutes = String(minutes).padStart(2, '0');

        const datetime = `${date}T${utcHours}:${utcMinutes}:00`;

        // Guardar la hora y cambiar a paso "asking-notes"
        userContext.set(from, { ...context, datetime, step: 'asking-notes' });

        await sendMessage(
          from,
          `✅ Perfecto! Cita para ${date} a las ${time} con ${context.userName}\n\n¿Cuál es tu problema o dolencia? Describe brevemente qué necesitas que tratemos (por ejemplo: dolor de espalda, lesión de rodilla, etc)`
        );

      } else {
        await sendMessage(from, `❌ Hora no disponible`);
      }

      return;
    }

    // ---------- PIDIENDO NOTAS ----------
    if (context?.step === 'asking-notes') {
      const notes = text;
      const { datetime, user_id: userId } = context;

      try {
        // Guardar la cita con las notas
        const appointment = await bookAppointment(from, datetime, 'physio', userId, notes);

        const customId = appointment.custom_id;
        const appointmentTime = datetime.split('T')[1].slice(0, 5);

        await sendMessage(
          from,
          `✅ ¡Cita confirmada!\n\n📋 Resumen:\n- Fecha y hora: ${context.date} a las ${appointmentTime}\n- Fisioterapeuta: ${context.userName}\n- Dolencia: ${notes}\n\n🔑 ID de tu cita: ${customId}\n\n⚠️ IMPORTANTE: Guarda este ID para poder anular la cita si lo necesitas. ¡Nos vemos pronto!`
        );

        userContext.delete(from);
      } catch (error) {
        console.error('Error al guardar cita con notas:', error);
        await sendMessage(from, '❌ Error al confirmar la cita. Intenta de nuevo.');
        userContext.delete(from);
      }

      return;
    }

    // ---------- DEFAULT ----------
    await sendMessage(
      from,
      `👋 No entiendo esa opción. Escribe "cita" para reservar o "anular" para cancelar.`
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
    const { phone, datetime, service, status, notes, duration, user_id } = req.body;

    if (!phone || !datetime || !user_id) {
      return res.status(400).json({ error: 'phone, datetime, and user_id are required' });
    }

    const appointment = await bookAppointment(phone, datetime, service, user_id, notes);
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
    const { user_id } = req.query

    if (!date || date === 'undefined') {
      return res.status(400).json({ error: 'Invalid date' })
    }

    const slots = await getAvailableSlots(date, user_id ? parseInt(user_id) : null)

    res.json({
      date,
      slots
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error fetching slots' })
  }
})

// ===================== USERS ENDPOINTS =====================

app.get('/api/users', verifyToken, async (_, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

app.get('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching user' });
  }
});

app.post('/api/users', verifyToken, async (req, res) => {
  try {
    const { name, email, phone, type, specialties } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const user = await createUser(name, email, phone, type, specialties);
    res.status(201).json(user);
  } catch (err) {
    console.error('Error creating user:', err);
    if (err.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message || 'Error creating user' });
  }
});

app.put('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const user = await updateUser(id, updates);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating user' });
  }
});

app.delete('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await deleteUser(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting user' });
  }
});

// ===================== PLANNING ENDPOINTS =====================

app.get('/api/planning', verifyToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    
    // Si el usuario es admin, puede ver todos los plannings
    if (req.user.role === 'admin') {
      const planning = await getAllPlanning(start_date, end_date);
      return res.json(planning);
    }

    // Si no es admin, solo puede ver el planning de un usuario específico
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const planning = await getPlanningByUser(user_id, start_date, end_date);
    res.json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching planning' });
  }
});

app.get('/api/planning/user/:user_id', verifyToken, async (req, res) => {
  try {
    const { user_id } = req.params;
    const { start_date, end_date } = req.query;

    // Solo admin o el propio usuario pueden ver el planning
    if (req.user.role !== 'admin' && req.user.id !== parseInt(user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const planning = await getPlanningByUser(user_id, start_date, end_date);
    res.json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching planning' });
  }
});

app.post('/api/planning', verifyToken, async (req, res) => {
  try {
    const { user_id, date, type, notes } = req.body;

    if (!user_id || !date || !type) {
      return res.status(400).json({ error: 'user_id, date, and type are required' });
    }

    // Solo admin puede crear plannings
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can create planning' });
    }

    const planning = await createPlanning(user_id, date, type, notes);
    res.status(201).json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error creating planning' });
  }
});

// ===================== PLANNING BULK (RANGO DE FECHAS) =====================
app.post('/api/planning/bulk', verifyToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date, type, notes, include_weekends } = req.body;

    if (!user_id || !start_date || !end_date || !type) {
      return res.status(400).json({ error: 'user_id, start_date, end_date, and type are required' });
    }

    // Solo admin puede crear plannings
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can create planning' });
    }

    // Generar todas las fechas en el rango
    const start = new Date(start_date);
    const end = new Date(end_date);
    const dates = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      // Si include_weekends es false, saltar fines de semana (sábado=6, domingo=0)
      if (!include_weekends && (d.getDay() === 0 || d.getDay() === 6)) {
        continue;
      }
      
      // Convertir a formato YYYY-MM-DD
      const dateStr = d.toLocaleDateString('en-CA');
      dates.push(dateStr);
    }

    // Crear planning para cada fecha
    const createdPlannings = [];
    for (const date of dates) {
      const planning = await createPlanning(user_id, date, type, notes);
      createdPlannings.push(planning);
    }

    res.status(201).json({
      message: `Created ${createdPlannings.length} planning entries`,
      count: createdPlannings.length,
      plannings: createdPlannings
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error creating planning bulk' });
  }
});

app.put('/api/planning/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    // Solo admin puede actualizar plannings
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can update planning' });
    }

    const planning = await updatePlanning(id, updates);
    if (!planning) {
      return res.status(404).json({ error: 'Planning not found' });
    }
    res.json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating planning' });
  }
});

app.delete('/api/planning/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Solo admin puede eliminar plannings
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can delete planning' });
    }

    const planning = await deletePlanning(id);
    if (!planning) {
      return res.status(404).json({ error: 'Planning not found' });
    }
    res.json({ message: 'Planning deleted', planning });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting planning' });
  }
});

// ===================== START =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

module.exports = app;