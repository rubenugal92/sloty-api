const express = require('express');
const {
  getAvailableSlots,
  bookAppointment,
  getAllAppointments,
  getAppointmentsByDateRange,
  getAppointmentById,
  updateAppointment,
  deleteAppointment
} = require('./db');

const { sendMessage } = require('./whatsapp');

const app = express();

app.use(express.json());

// ===================== STATE (IMPORTANTE) =====================
const userContext = new Map();

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

// ===================== LOGICA =====================

const handleMessage = async (from, text) => {
  try {

    // ---------- DETECTAR DÍA ----------
    for (const [dayName, dayIndex] of Object.entries(dayMap)) {
      if (text.includes(dayName)) {

        const targetDate = getNextWeekday(dayIndex);

        userContext.set(from, { date: targetDate });

        const slots = await getAvailableSlots(targetDate);

        const readable = new Date(targetDate + "T00:00:00").toLocaleDateString('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'long'
        });

        await sendMessage(
          from,
          `📅 ${readable}\n\nHorarios:\n${slots.join(', ')}\n\nResponde con la hora (ej: 10:00)`
        );

        return;
      }
    }

    // ---------- COMANDO GENERAL ----------
    if (text.includes('cita') || text.includes('disponible')) {

      const today = new Date().toISOString().split('T')[0];
      const slots = await getAvailableSlots(today);

      await sendMessage(
        from,
        slots.length > 0
          ? `✅ Hoy:\n${slots.join(', ')}`
          : `❌ Hoy no hay disponibilidad`
      );

      return;
    }

    // ---------- HORA CON CONTEXTO ----------
    if (/^\d{1,2}:\d{2}$/.test(text)) {

      const time = normalizeTime(text);
      const context = userContext.get(from);

      if (!context?.date) {
        await sendMessage(from, "❌ Primero dime un día (ej: lunes)");
        return;
      }

      const date = context.date;

      const available = await getAvailableSlots(date);
      const normalized = available.map(normalizeTime);

      if (normalized.includes(time)) {

        const datetime = `${date}T${time}:00`;

        await bookAppointment(from, datetime);

        await sendMessage(
          from,
          `✅ Cita confirmada para ${date} a las ${time}`
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

app.get('/api/appointments', async (_, res) => {
  res.json(await getAllAppointments());
});

// ===================== START =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

module.exports = app;