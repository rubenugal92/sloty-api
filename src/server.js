const express = require('express');
const {
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteAppointment
} = require('./db');

const { sendMessage } = require('./whatsapp');

const app = express();

app.use(express.json());

// ===================== CORS =====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===================== LOG =====================
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ===================== DAY MAP =====================
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

// ===================== DATE HELPERS =====================
const normalizeTime = (t) => t.trim().slice(0, 5);

const getNextWeekday = (weekday) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = new Date(today);
  const diff = (weekday - today.getDay() + 7) % 7;

  result.setDate(today.getDate() + (diff === 0 ? 7 : diff));

  return result.toISOString().split('T')[0]; // 🔥 FIX CONSISTENTE
};

// ===================== WEBHOOK =====================
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      body.entry?.forEach(entry => {
        entry.changes?.forEach(change => {
          if (change.field === 'messages') {
            change.value.messages?.forEach(async (message) => {
              if (message.type === 'text') {
                const from = message.from;
                const text = message.text.body.toLowerCase().trim();
                await handleMessage(from, text);
              }
            });
          }
        });
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ===================== CONTEXT =====================
const userContext = new Map();

// ===================== LOGIC =====================
const handleMessage = async (from, text) => {

  for (const [dayName, dayIndex] of Object.entries(dayMap)) {
    if (text.includes(dayName)) {

      const date = getNextWeekday(dayIndex);
      userContext.set(from, { date });

      const slots = await getAvailableSlots(date);

      await sendMessage(
        from,
        `📅 ${date}\n\n${slots.join(', ')}\n\nResponde hora`
      );

      return;
    }
  }

  if (/^\d{1,2}:\d{2}$/.test(text)) {

    const context = userContext.get(from);

    if (!context?.date) {
      return sendMessage(from, "Primero dime un día");
    }

    const date = context.date;
    const time = normalizeTime(text);

    const available = await getAvailableSlots(date);

    if (available.map(normalizeTime).includes(time)) {

      await bookAppointment(from, `${date}T${time}:00`);

      userContext.delete(from);

      return sendMessage(from, `OK cita ${date} ${time}`);
    }

    return sendMessage(from, "No disponible");
  }

  return sendMessage(from, "Di un día");
};

// ===================== API CRUD (FIX CRÍTICO) =====================

// GET ALL
app.get('/api/appointments', async (_, res) => {
  res.json(await getAllAppointments());
});

// GET ONE
app.get('/api/appointments/:id', async (req, res) => {
  const data = await getAppointmentById(req.params.id);
  if (!data) return res.sendStatus(404);
  res.json(data);
});

app.get('/api/slots/:date', async (req, res) => {
  try {
    const { date } = req.params;

    const slots = await getAvailableSlots(date);

    res.json(slots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching slots' });
  }
});

// CREATE
app.post('/api/appointments', async (req, res) => {
  const { phone, datetime, service } = req.body;
  const result = await bookAppointment(phone, datetime, service);
  res.json(result);
});

// UPDATE
app.put('/api/appointments/:id', async (req, res) => {
  const result = await updateAppointment(req.params.id, req.body);
  if (!result) return res.sendStatus(404);
  res.json(result);
});

// DELETE
app.delete('/api/appointments/:id', async (req, res) => {
  const result = await deleteAppointment(req.params.id);
  if (!result) return res.sendStatus(404);
  res.json(result);
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ${PORT}`));

module.exports = app;