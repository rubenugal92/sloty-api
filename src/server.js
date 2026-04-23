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

// Middleware for JSON parsing
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ============== WHATSAPP WEBHOOK ================

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

// Helper function to get next 3 available dates with slots
const getNextAvailableDates = async () => {
  const alternatives = [];
  let date = new Date();
  
  while (alternatives.length < 3) {
    const dateStr = date.toISOString().split('T')[0];
    const slots = await getAvailableSlots(dateStr);
    
    if (slots.length > 0) {
      alternatives.push({
        date: dateStr,
        slots: slots.slice(0, 3) // First 3 slots
      });
    }
    
    date.setDate(date.getDate() + 1); // Next day
  }
  
  return alternatives;
};

// Improved message handling
const handleMessage = async (from, text) => {
  try {
    // Check if it's requesting availability or booking
    if (text.includes('cita') || text.includes('booking') || text.includes('disponible')) {
      const today = new Date().toISOString().split('T')[0];
      const slots = await getAvailableSlots(today);
      
      if (slots.length > 0) {
        // If slots available today
        await sendMessage(
          from, 
          `✅ Tengo disponibilidad hoy. Horarios disponibles:\n${slots.join(', ')}\n\nResponde con la hora que prefieres (ej: 10:00)`
        );
      } else {
        // If no slots today, show alternatives
        const alternatives = await getNextAvailableDates();
        let responseText = `❌ No hay disponibilidad hoy.\n\n📅 Próximas fechas disponibles:\n\n`;
        
        alternatives.forEach((alt, index) => {
          const dateObj = new Date(alt.date);
          const dayName = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
          responseText += `${index + 1}. ${dayName}\n   Horas: ${alt.slots.join(', ')}\n`;
        });
        
        responseText += `\nResponde con el número de día y hora (ej: "1 10:00" para opción 1 a las 10:00)`;
        
        await sendMessage(from, responseText);
      }
    } else if (/^\d{1,2}:\d{2}$/.test(text)) {
      // Time selection for today, e.g., "12:00"
      const time = text;
      const date = new Date().toISOString().split('T')[0];
      const datetime = `${date}T${time}:00`;
      const available = await getAvailableSlots(date);
      
      if (available.includes(time)) {
        await bookAppointment(from, datetime);
        const dateObj = new Date(datetime);
        const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
        await sendMessage(from, `✅ ¡Cita confirmada!\n📅 ${formattedDate}\n🕐 ${time}\n\nTe esperamos. ¡Hasta pronto! 🏥`);
      } else {
        await sendMessage(from, `❌ La hora ${time} no está disponible.\n\nUsa el comando "cita" para ver otras opciones.`);
      }
    } else if (/^\d\s\d{1,2}:\d{2}$/.test(text)) {
      // Alternative date selection, e.g., "1 10:00"
      const [optionStr, time] = text.split(' ');
      const option = parseInt(optionStr);
      const alternatives = await getNextAvailableDates();
      
      if (option > 0 && option <= alternatives.length) {
        const selectedAlt = alternatives[option - 1];
        if (selectedAlt.slots.includes(time)) {
          const datetime = `${selectedAlt.date}T${time}:00`;
          await bookAppointment(from, datetime);
          const dateObj = new Date(datetime);
          const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
          await sendMessage(from, `✅ ¡Cita confirmada!\n📅 ${formattedDate}\n🕐 ${time}\n\nTe esperamos. ¡Hasta pronto! 🏥`);
        } else {
          await sendMessage(from, `❌ La hora ${time} no está disponible en esa fecha.\n\nUsa "cita" para ver otras opciones.`);
        }
      } else {
        await sendMessage(from, `❌ Opción inválida. Usa "cita" para ver las opciones disponibles.`);
      }
    } else {
      // Default response
      await sendMessage(
        from, 
        `👋 ¡Hola! Soy el asistente de citas de fisioterapia.\n\n¿Qué necesitas?\n\n📅 Escribe "cita" para reservar una cita\n❓ Escribe "disponible" para ver horarios`
      );
    }
  } catch (error) {
    console.error('Handle message error:', error);
    await sendMessage(from, '😞 Ocurrió un error. Por favor intenta de nuevo.');
  }
};

// ============== REST API ENDPOINTS ================

// Get all appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const appointments = await getAllAppointments();
    res.json(appointments);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// Get available slots for a specific date
app.get('/api/slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const slots = await getAvailableSlots(date);
    res.json({ date, slots });
  } catch (error) {
    console.error('Error fetching slots:', error);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// Get appointments by date range
app.get('/api/appointments/range/:startDate/:endDate', async (req, res) => {
  try {
    const { startDate, endDate } = req.params;
    const appointments = await getAppointmentsByDateRange(startDate, endDate);
    res.json(appointments);
  } catch (error) {
    console.error('Error fetching appointments by range:', error);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// Get specific appointment
app.get('/api/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await getAppointmentById(id);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    res.json(appointment);
  } catch (error) {
    console.error('Error fetching appointment:', error);
    res.status(500).json({ error: 'Failed to fetch appointment' });
  }
});

// Create new appointment
app.post('/api/appointments', async (req, res) => {
  try {
    const { phone, datetime, service, notes } = req.body;
    
    if (!phone || !datetime) {
      return res.status(400).json({ error: 'Missing required fields: phone, datetime' });
    }
    
    const appointment = await bookAppointment(phone, datetime, service);
    res.status(201).json(appointment);
  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ error: error.message || 'Failed to create appointment' });
  }
});

// Update appointment
app.put('/api/appointments/:id', async (req, res) => {
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
  } catch (error) {
    console.error('Error updating appointment:', error);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

// Delete appointment
app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await deleteAppointment(id);
    
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    
    res.json({ message: 'Appointment deleted successfully', appointment });
  } catch (error) {
    console.error('Error deleting appointment:', error);
    res.status(500).json({ error: 'Failed to delete appointment' });
  }
});

// ============== SERVER START ================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp webhook ready at http://localhost:${PORT}/webhook`);
  console.log(`📅 API endpoints ready at http://localhost:${PORT}/api/appointments`);
});

module.exports = app;