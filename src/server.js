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

const { sendMessage, sendTemplateMessage } = require('./whatsapp');

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

// ===================== DÍAS DE LA SEMANA =====================

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

  // normalizar a medianoche local (IMPORTANTE)
  today.setHours(0, 0, 0, 0);

  const result = new Date(today);

  const diff = (weekday - today.getDay() + 7) % 7;

  // si es hoy, saltamos a la próxima semana
  result.setDate(today.getDate() + (diff === 0 ? 7 : diff));

  return result.toLocaleDateString('en-CA'); 
  // YYYY-MM-DD en LOCAL (NO UTC)
};

// ===================== WHATSAPP WEBHOOK =====================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
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
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

// ===================== HELPERS =====================

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

// ===================== LOGICA PRINCIPAL =====================

const handleMessage = async (from, text) => {
  try {

    // ===================== 1. DÍAS NATURALES =====================
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
            `📅 ${readable}\n\nHorarios disponibles:\n${slots.join(', ')}\n\nResponde con la hora (ej: 10:00)`
          );
        } else {
          await sendMessage(
            from,
            `❌ No hay disponibilidad para ${readable}`
          );
        }

        return;
      }
    }

    // ===================== 2. COMANDO GENERAL =====================
    if (text.includes('cita') || text.includes('booking') || text.includes('disponible')) {

      const today = new Date().toISOString().split('T')[0];
      const slots = await getAvailableSlots(today);

      if (slots.length > 0) {
        await sendMessage(
          from,
          `✅ Disponibilidad hoy:\n${slots.join(', ')}\n\nResponde con la hora (ej: 10:00)`
        );
      } else {

        const alternatives = await getNextAvailableDates();

        let msg = `❌ Hoy no hay disponibilidad\n\n📅 Próximos días:\n\n`;

        alternatives.forEach((alt, i) => {
          const d = new Date(alt.date).toLocaleDateString('es-ES', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          });

          msg += `${i + 1}. ${d}\n   ${alt.slots.join(', ')}\n`;
        });

        msg += `\nResponde: "1 10:00"`;
        await sendMessage(from, msg);
      }

      return;
    }

    // ===================== 3. HORA HOY =====================
    if (/^\d{1,2}:\d{2}$/.test(text)) {

      const time = text;
      const date = new Date().toISOString().split('T')[0];

      const available = await getAvailableSlots(date);

      const normalizedSlots = available.map(s => s.trim().slice(0,5));

if (normalizedSlots.includes(time.trim().slice(0,5)))

        const datetime = `${date}T${time}:00`;
        await bookAppointment(from, datetime);

        await sendMessage(
          from,
          `✅ Cita confirmada hoy a las ${time}`
        );

      } else {
        await sendMessage(from, `❌ Hora no disponible`);
      }

      return;
    }

    // ===================== 4. OPCIÓN ALTERNATIVA =====================
    if (/^\d\s\d{1,2}:\d{2}$/.test(text)) {

      const [opt, time] = text.split(' ');
      const alternatives = await getNextAvailableDates();

      const selected = alternatives[parseInt(opt) - 1];

      if (selected?.slots.includes(time)) {

        const datetime = `${selected.date}T${time}:00`;
        await bookAppointment(from, datetime);

        await sendMessage(from, `✅ Cita confirmada`);

      } else {
        await sendMessage(from, `❌ No disponible`);
      }

      return;
    }

    // ===================== 5. DEFAULT =====================
    await sendMessage(
      from,
      `👋 Hola! Escribe "cita" o dime un día (ej: jueves)`
    );

  } catch (error) {
    console.error('Handle message error:', error);
    await sendMessage(from, '❌ Error procesando mensaje');
  }
};

// ===================== API REST =====================

app.get('/api/appointments', async (req, res) => {
  try {
    const data = await getAllAppointments();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

app.get('/api/slots/:date', async (req, res) => {
  try {
    const slots = await getAvailableSlots(req.params.date);
    res.json(slots);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

app.get('/api/appointments/:id', async (req, res) => {
  try {
    const data = await getAppointmentById(req.params.id);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { phone, datetime, service } = req.body;
    const result = await bookAppointment(phone, datetime, service);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

app.put('/api/appointments/:id', async (req, res) => {
  try {
    const result = await updateAppointment(req.params.id, req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const result = await deleteAppointment(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

// ===================== START SERVER =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Webhook: /webhook`);
  console.log(`📡 API ready`);
});

module.exports = app;