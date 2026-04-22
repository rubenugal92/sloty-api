const express = require('express');
const { getAvailableSlots, bookAppointment } = require('./db');
const { sendMessage } = require('./whatsapp');

const app = express();

// Middleware for JSON parsing
app.use(express.json());

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Webhook verification endpoint (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook for incoming messages (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Validate webhook payload
    if (body.object === 'whatsapp_business_account') {
      body.entry.forEach(entry => {
        entry.changes.forEach(change => {
          if (change.field === 'messages') {
            change.value.messages.forEach(async (message) => {
              if (message.type === 'text') {
                const from = message.from; // User phone number
                const text = message.text.body.toLowerCase().trim();
                await handleMessage(from, text);
              }
            });
          }
        });
      });
    }

    // Always return 200 to acknowledge receipt
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    // Still return 200 to prevent retries
    res.sendStatus(200);
  }
});

// Simple intent handling based on keywords
const handleMessage = async (from, text) => {
  try {
    if (text.includes('cita') || text.includes('booking')) {
      // Request for booking, show available slots for today
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const slots = await getAvailableSlots(date);
      if (slots.length > 0) {
        await sendMessage(from, `Slots disponibles hoy: ${slots.join(', ')}. Elige uno enviando la hora (ej: 10:00).`);
      } else {
        await sendMessage(from, 'No hay slots disponibles hoy. Intenta mañana.');
      }
    } else if (text.includes('hora') || text.includes('disponible')) {
      // Availability check
      const date = new Date().toISOString().split('T')[0];
      const slots = await getAvailableSlots(date);
      if (slots.length > 0) {
        await sendMessage(from, `Slots disponibles: ${slots.join(', ')}`);
      } else {
        await sendMessage(from, 'No hay disponibilidad.');
      }
    } else if (/^\d{1,2}:\d{2}$/.test(text)) {
      // Time selection, e.g., "12:00"
      const time = text;
      const date = new Date().toISOString().split('T')[0];
      const datetime = `${date}T${time}:00`; // ISO format
      const available = await getAvailableSlots(date);
      if (available.includes(time)) {
        await bookAppointment(from, datetime);
        await sendMessage(from, `Cita reservada para ${time}. ¡Gracias!`);
      } else {
        await sendMessage(from, `El slot ${time} no está disponible. Elige otro.`);
      }
    } else {
      // Default response
      await sendMessage(from, 'Hola, envía "cita" para reservar una cita.');
    }
  } catch (error) {
    console.error('Handle message error:', error);
    await sendMessage(from, 'Ocurrió un error. Intenta de nuevo.');
  }
};

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});