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

// ===================== MIDDLEWARE =====================

app.use(express.json());

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

// ===================== DÍAS SEMANA =====================

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

// ===================== HELPERS =====================

const normalizeTime = (t) => t.trim().slice(0, 5);

const getNextAvailableDates = async () => {
  const alternatives = [];
  let date = new Date();

  while (alternatives.length < 3) {
    const dateStr = date.toISOString().split('T')[0];
    const slots = await getAvailableSlots(dateStr);

    if (slots.length > 0) {
      alternatives.push({
        date: dateStr,
        slots: slots.slice(0, 3)
      });
    }

    date.setDate(date.getDate() + 1);
  }

  return alternatives;
};

// ===================== WEBHOOK =====================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

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
  } catch (error) {
    console.error(error);
    res.sendStatus(200);
  }
});

// ===================== LOGICA PRINCIPAL =====================

const handleMessage = async (from, text) => {
  try {

    // ---------- DÍAS NATURALES ----------
    for (const [dayName, dayIndex] of Object.entries(dayMap)) {
      if (text.includes(dayName)) {

        const targetDate = getNextWeekday(dayIndex);
        const slots = await getAvailableSlots(targetDate);

        const dateObj = new Date(targetDate);
        const readable = dateObj.toLocaleDateString('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'long'
        });

        if (slots.length > 0) {
          await sendMessage(
            from,
            `📅 ${readable}\n\nHorarios:\n${slots.join(', ')}`
          );
        } else {
          await sendMessage(from, `❌ No hay disponibilidad para ${readable}`);
        }

        return;
      }
    }

    // ---------- COMANDO GENERAL ----------
    if (text.includes('cita') || text.includes('disponible')) {

      const today = new Date().toISOString().split('T')[0];
      const slots = await getAvailableSlots(today);

      if (slots.length > 0) {
        await sendMessage(from, `✅ Hoy:\n${slots.join(', ')}`);
      } else {
        const alternatives = await getNextAvailableDates();

        let msg = `❌ Hoy no hay disponibilidad\n\n`;

        alternatives.forEach((alt, i) => {
          const d = new Date(alt.date).toLocaleDateString('es-ES', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          });

          msg += `${i + 1}. ${d}: ${alt.slots.join(', ')}\n`;
        });

        await sendMessage(from, msg);
      }

      return;
    }

    // ---------- HORA HOY ----------
    if (/^\d{1,2}:\d{2}$/.test(text)) {

      const time = normalizeTime(text);
      const date = new Date().toISOString().split('T')[0];

      const available = await getAvailableSlots(date);
      const normalized = available.map(normalizeTime);

      if (normalized.includes(time)) {

        const datetime = `${date}T${time}:00`;
        await bookAppointment(from, datetime);

        await sendMessage(from, `✅ Cita confirmada hoy a las ${time}`);

      } else {
        await sendMessage(from, `❌ Hora no disponible`);
      }

      return;
    }

    // ---------- ALTERNATIVAS ----------
    if (/^\d\s\d{1,2}:\d{2}$/.test(text)) {

      const [opt, time] = text.split(' ');
      const alternatives = await getNextAvailableDates();

      const selected = alternatives[parseInt(opt) - 1];

      if (selected?.slots.includes(time)) {

        const cleanTime = normalizeTime(time);
        const datetime = `${selected.date}T${cleanTime}:00`;

        await bookAppointment(from, datetime);

        await sendMessage(from, `✅ Cita confirmada`);

      } else {
        await sendMessage(from, `❌ No disponible`);
      }

      return;
    }

    // ---------- DEFAULT ----------
    await sendMessage(
      from,
      `👋 Escribe "cita" o un día (ej: jueves)`
    );

  } catch (error) {
    console.error(error);
    await sendMessage(from, '❌ Error procesando mensaje');
  }
};

// ===================== API =====================

app.get('/api/appointments', async (_, res) => {
  res.json(await getAllAppointments());
});

// ===================== START =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Running on ${PORT}`);
});

module.exports = app;