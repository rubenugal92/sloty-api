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
  updateCompany
} = require('./db');

const { sendMessage } = require('./whatsapp');
const { handleMessage } = require('./bot');

const app = express();

app.use(express.json());

// ===================== JWT SECRET =====================
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ===================== HELPERS DE SCOPE MULTI-TENANT =====================
// Resuelve a qué company_id filtrar las queries:
// - superadmin: null (acceso global) salvo que pase ?company_id= para acotar
// - admin / user: siempre su propia company_id (del JWT)
const resolveCompanyScope = (req) => {
  if (req.user?.role === 'superadmin') {
    return req.query.company_id ? parseInt(req.query.company_id, 10) : null;
  }
  return req.user?.company_id;
};

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
          if (change.field !== 'messages') continue;

          // Resolver el tenant a partir del phone_number_id que envía Meta.
          // Fallback a env vars (legacy single-tenant) si la company no se encuentra.
          const phoneNumberId = change.value?.metadata?.phone_number_id || null;
          let companyId, credentials;
          if (phoneNumberId) {
            const company = await getCompanyByWhatsappPhoneId(phoneNumberId);
            if (company) {
              companyId = company.id;
              credentials = {
                phone_number_id: company.whatsapp_phone_number_id,
                access_token: company.whatsapp_access_token,
              };
            }
          }
          if (!companyId) {
            companyId = parseInt(process.env.DEFAULT_WHATSAPP_COMPANY_ID || '1', 10);
            credentials = null; // bot/whatsapp.js caerán a env vars
          }

          for (const message of change.value.messages || []) {
            if (message.type !== 'text') continue;
            const from = message.from;
            const text = message.text.body;
            await handleMessage(from, text, companyId, credentials);
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
    const { username, name, email, password, specialities, phone, type, company_code } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: username, email, password' });
    }

    // Si se proporciona company_code, usarlo; de lo contrario usar compañía por defecto
    let company_id = null;
    if (company_code) {
      const company = await getCompanyByCode(company_code);
      if (!company) {
        return res.status(404).json({ error: 'Company code not found' });
      }
      company_id = company.id;
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createUser(username, name, email, hashedPassword, phone, type, specialities, company_id);

    res.status(201).json({ message: 'User registered successfully', user: { id: user.id, email: user.email, username: user.username, company_id: user.company_id } });
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
      { id: user.id, email: user.email, username: user.username, role: user.role, company_id: user.company_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ 
      message: 'Login successful', 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        username: user.username, 
        name: user.name, 
        role: user.role,
        company_id: user.company_id
      } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// ===================== API =====================

app.get('/api/appointments', verifyToken, async (req, res) => {
  try {
    // Los usuarios normales solo ven sus citas
    // Los admins ven todas las citas de su empresa
    let company_id = req.user.company_id;
    
    // Si es superadmin sin company específica, puede ver todo
    if (req.user.role === 'superadmin' && req.query.company_id) {
      company_id = parseInt(req.query.company_id, 10);
    }
    
    const appointments = await getAllAppointments(company_id);
    res.json(appointments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching appointments' });
  }
});

app.get('/api/appointments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await getAppointmentById(id, resolveCompanyScope(req));
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
    const { phone, customer_name, datetime, service, status, notes, duration, user_id, company_id } = req.body;

    if (!phone || !datetime || !user_id) {
      return res.status(400).json({ error: 'phone, datetime, and user_id are required' });
    }

    const targetCompanyId = req.user.role === 'superadmin' ? company_id || req.user.company_id : req.user.company_id;
    const appointment = await bookAppointment(phone, datetime, service, user_id, notes, targetCompanyId, customer_name);
    res.status(201).json(appointment);
  } catch (err) {
    console.error(err);
    if (err.message?.includes('Slot ocupado') || err.code === '23505') {
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

    const appointment = await getAppointmentById(id, resolveCompanyScope(req));
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const updated = await updateAppointment(id, updates);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating appointment' });
  }
});

app.delete('/api/appointments/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const appointment = await getAppointmentById(id, resolveCompanyScope(req));
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const deleted = await deleteAppointment(id);
    res.json({ message: 'Appointment deleted', appointment: deleted });
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

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    let company_id = req.user.company_id;
    if (req.user.role === 'superadmin' && req.query.company_id) {
      company_id = parseInt(req.query.company_id, 10);
    }

    const users = await getAllUsers(company_id);
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

app.get('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id, resolveCompanyScope(req));
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
    const { username, name, email, phone, type, specialties, password, company_id } = req.body;

    if (!username || !name || !email) {
      return res.status(400).json({ error: 'Username, name and email are required' });
    }

    const targetCompanyId = req.user.role === 'superadmin' ? company_id || req.user.company_id : req.user.company_id;
    if (req.user.role === 'superadmin' && !targetCompanyId) {
      return res.status(400).json({ error: 'company_id is required for superadmin user creation' });
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : await bcrypt.hash('defaultPass123', 10);
    const user = await createUser(username, name, email, hashedPassword, phone, type, specialties, targetCompanyId);
    res.status(201).json(user);
  } catch (err) {
    console.error('Error creating user:', err);
    if (err.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: err.message || 'Error creating user' });
  }
});

app.put('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    let updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const user = await getUserById(id, resolveCompanyScope(req));
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (updates.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmin can assign superadmin role' });
    }

    if (updates.password) {
      updates.password = await bcrypt.hash(updates.password, 10);
    }

    const updated = await updateUser(id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating user' });
  }
});

app.delete('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id, resolveCompanyScope(req));
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deleted = await deleteUser(id);
    res.json({ message: 'User deleted', user: deleted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting user' });
  }
});

// ===================== PLANNING ENDPOINTS =====================

app.get('/api/planning', verifyToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    let company_id = req.user.company_id;
    if (req.user.role === 'superadmin' && req.query.company_id) {
      company_id = parseInt(req.query.company_id, 10);
    }

    if (req.user.role === 'admin' || req.user.role === 'superadmin') {
      const planning = await getAllPlanning(start_date, end_date, company_id);
      return res.json(planning);
    }

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const planning = await getPlanningByUser(user_id, start_date, end_date, company_id);
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
    let company_id = req.user.company_id;
    if (req.user.role === 'superadmin' && req.query.company_id) {
      company_id = parseInt(req.query.company_id, 10);
    }

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin' && req.user.id !== parseInt(user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const planning = await getPlanningByUser(user_id, start_date, end_date, company_id);
    res.json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching planning' });
  }
});

app.post('/api/planning', verifyToken, async (req, res) => {
  try {
    const { user_id, date, type, notes, company_id, start_time, end_time } = req.body;

    if (!user_id || !date || !type) {
      return res.status(400).json({ error: 'user_id, date, and type are required' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only admin can create planning' });
    }

    const targetCompanyId = req.user.role === 'superadmin' ? company_id || req.user.company_id : req.user.company_id;
    const planning = await createPlanning(user_id, date, type, notes, targetCompanyId, start_time || null, end_time || null);
    res.status(201).json(planning);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error creating planning' });
  }
});

// ===================== PLANNING BULK (RANGO DE FECHAS) =====================
app.post('/api/planning/bulk', verifyToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date, type, notes, include_weekends, company_id, start_time, end_time } = req.body;

    if (!user_id || !start_date || !end_date || !type) {
      return res.status(400).json({ error: 'user_id, start_date, end_date, and type are required' });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only admin can create planning' });
    }

    const targetCompanyId = req.user.role === 'superadmin' ? company_id || req.user.company_id : req.user.company_id;

    const start = new Date(start_date);
    const end = new Date(end_date);
    const dates = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (!include_weekends && (d.getDay() === 0 || d.getDay() === 6)) {
        continue;
      }
      const dateStr = d.toLocaleDateString('en-CA');
      dates.push(dateStr);
    }

    const createdPlannings = [];
    for (const date of dates) {
      const planning = await createPlanning(user_id, date, type, notes, targetCompanyId, start_time || null, end_time || null);
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

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only admin can update planning' });
    }

    const planning = await getPlanningById(id);
    if (!planning) {
      return res.status(404).json({ error: 'Planning not found' });
    }
    const updated = await updatePlanning(id, updates);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating planning' });
  }
});

app.delete('/api/planning/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only admin can delete planning' });
    }

    const planning = await getPlanningById(id);
    if (!planning) {
      return res.status(404).json({ error: 'Planning not found' });
    }
    const deleted = await deletePlanning(id);
    res.json({ message: 'Planning deleted', planning: deleted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting planning' });
  }
});

// ===================== MIDDLEWARE SUPERADMIN =====================
const verifySuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can access this resource' });
  }
  next();
};

// ===================== COMPANIES ENDPOINTS (SUPERADMIN ONLY) =====================

// Listar todas las empresas
app.get('/api/companies', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const companies = await getAllCompanies();
    res.json(companies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching companies' });
  }
});

// Crear nueva empresa
app.post('/api/companies', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const {
      name, company_code, contact_email, phone,
      whatsapp_phone_number_id, whatsapp_access_token, whatsapp_display_number,
    } = req.body;

    if (!name || !company_code) {
      return res.status(400).json({ error: 'Name and company_code are required' });
    }

    const existingCompany = await getCompanyByCode(company_code);
    if (existingCompany) {
      return res.status(409).json({ error: 'Company code already exists' });
    }

    const company = await createCompany(name, company_code, contact_email, phone, {
      phone_number_id: whatsapp_phone_number_id,
      access_token: whatsapp_access_token,
      display_number: whatsapp_display_number,
    });
    res.status(201).json({ message: 'Company created successfully', company });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error creating company' });
  }
});

// Obtener empresa por ID
app.get('/api/companies/:id', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const company = await getCompanyById(id);
    
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    
    res.json(company);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching company' });
  }
});

// Actualizar empresa
app.put('/api/companies/:id', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const company = await updateCompany(id, updates);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(company);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating company' });
  }
});

// ===================== START =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

module.exports = app;