const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// =====================================================================
// APPOINTMENTS / CITAS
// =====================================================================

const getAvailableSlots = async (date, userId = null) => {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(`${date}T23:59:59`)
  const slots = []

  // Default time range (Spain: 09:00-20:00)
  let startHourLocal = 9
  let endHourLocal = 20

  if (userId) {
    const planning = await getPlanningByUserAndDate(userId, date)
    if (planning && planning.type !== 'work') return []
    if (planning && planning.startTime) {
      startHourLocal = parseInt(planning.startTime.slice(0, 2), 10)
    }
    if (planning && planning.endTime) {
      endHourLocal = parseInt(planning.endTime.slice(0, 2), 10)
    }
  }

  // Generate slots in local time (HH:MM format)
  for (let h = startHourLocal; h < endHourLocal; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`)
  }

  // Exclude already booked slots
  const appointments = await prisma.appointment.findMany({
    where: {
      datetime: {
        gte: start,
        lte: end,
      },
      status: { not: 'cancelled' },
      ...(userId && { userId }),
    },
    select: { datetime: true },
  })

  const booked = appointments.map(a => {
    const utcTime = new Date(a.datetime)
    const localTime = new Date(utcTime.getTime() + 2 * 60 * 60 * 1000)
    return localTime.toISOString().slice(11, 16)
  })

  return slots.filter(s => !booked.includes(s))
}

const getAvailableUsersForDate = async (date, company_id = null) => {
  const dateObj = new Date(`${date}T00:00:00`)

  return await prisma.user.findMany({
    where: {
      isActive: true,
      plannings: {
        some: {
          date: {
            gte: dateObj,
            lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
          },
          type: 'work',
        },
      },
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
    orderBy: { name: 'asc' },
  })
}

const bookAppointment = async (
  phone,
  datetime,
  service = 'physio',
  userId = null,
  notes = null,
  company_id = null,
  customer_name = null
) => {
  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  let targetCompanyId = companyIdInt

  if (!targetCompanyId && userId) {
    const user = await prisma.user.findUnique({
      where: { id: typeof userId === 'string' ? parseInt(userId, 10) : userId },
      select: { companyId: true },
    })
    targetCompanyId = user?.companyId || null
  }

  // Check if slot is already booked
  const existing = await prisma.appointment.findFirst({
    where: {
      datetime: new Date(datetime),
      userId,
      status: { not: 'cancelled' },
    },
  })

  if (existing) {
    throw new Error('Slot ocupado')
  }

  if (!targetCompanyId) {
    throw new Error('Invalid company for appointment')
  }

  // Generate custom_id
  const dateObj = new Date(datetime)
  const dateStr = dateObj.toISOString().split('T')[0].replace(/-/g, '')
  const timeStr = dateObj.toISOString().split('T')[1].slice(0, 5).replace(':', '')
  const randomId = Math.random().toString(36).substring(2, 8).toUpperCase()

  const custom_id = `${dateStr}-${timeStr}-${randomId}`

  return await prisma.appointment.create({
    data: {
      phone,
      customerName: customer_name,
      datetime: new Date(datetime),
      userId,
      companyId: targetCompanyId,
      service,
      notes,
      customId: custom_id,
      status: 'confirmed',
    },
  })
}

const getLastCustomerNameByPhone = async (phone) => {
  const appointment = await prisma.appointment.findFirst({
    where: {
      phone,
      customerName: { not: null },
    },
    select: { customerName: true },
    orderBy: { createdAt: 'desc' },
  })

  return appointment?.customerName || null
}

const getAllAppointments = async (company_id = null) => {
  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  return await prisma.appointment.findMany({
    where: {
      ...(companyIdInt !== null && companyIdInt !== undefined && { companyId: companyIdInt }),
    },
    include: {
      user: {
        select: {
          name: true,
          specialties: true,
        },
      },
    },
    orderBy: { datetime: 'asc' },
  })
}

const getAppointmentById = async (id, company_id = null) => {
  const appointmentId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(appointmentId)) {
    throw new Error('Invalid appointment id')
  }

  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  return await prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      ...(companyIdInt !== null && companyIdInt !== undefined && { companyId: companyIdInt }),
    },
    include: {
      user: {
        select: {
          name: true,
          specialties: true,
        },
      },
    },
  })
}

const updateAppointment = async (id, updates) => {
  const appointmentId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(appointmentId)) {
    throw new Error('Invalid appointment id')
  }
  const allowedFields = ['status', 'notes', 'service', 'duration']
  const data = {}

  for (const [k, v] of Object.entries(updates)) {
    if (allowedFields.includes(k)) {
      data[k] = v
    }
  }

  return await prisma.appointment.update({
    where: { id: appointmentId },
    data,
  })
}

const deleteAppointment = async (id) => {
  const appointmentId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(appointmentId)) {
    throw new Error('Invalid appointment id')
  }

  return await prisma.appointment.delete({
    where: { id: appointmentId },
  })
}

const getAppointmentByCustomId = async (custom_id, company_id = null) => {
  return await prisma.appointment.findFirst({
    where: {
      customId: custom_id,
      status: { not: 'cancelled' },
      ...(company_id !== null && { companyId: company_id }),
    },
  })
}

const cancelAppointmentByCustomId = async (custom_id, company_id = null) => {
  return await prisma.appointment.updateMany({
    where: {
      customId: custom_id,
      status: { not: 'cancelled' },
      ...(company_id !== null && { companyId: company_id }),
    },
    data: {
      status: 'cancelled',
      updatedAt: new Date(),
    },
  })
}

// =====================================================================
// USERS
// =====================================================================

const getAllUsers = async (company_id = null) => {
  return await prisma.user.findMany({
    where: {
      isActive: true,
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
    orderBy: { name: 'asc' },
  })
}

const getUserById = async (id, company_id = null) => {
  const userId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(userId)) {
    throw new Error('Invalid user id')
  }

  return await prisma.user.findFirst({
    where: {
      id: userId,
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
  })
}

const createUser = async (
  username,
  name,
  email,
  password,
  phone = null,
  type = null,
  specialties = null,
  company_id = null
) => {
  return await prisma.user.create({
    data: {
      username,
      name,
      email,
      password,
      phone,
      type,
      specialties,
      companyId: company_id,
    },
  })
}

const updateUser = async (id, updates) => {
  const userId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(userId)) {
    throw new Error('Invalid user id')
  }

  const fieldMap = {
    username: 'username',
    name: 'name',
    email: 'email',
    password: 'password',
    phone: 'phone',
    type: 'type',
    specialties: 'specialties',
    is_active: 'isActive',
    isActive: 'isActive',
  }

  const data = {}

  for (const [k, v] of Object.entries(updates)) {
    const mappedKey = fieldMap[k]
    if (mappedKey) {
      data[mappedKey] = v
    }
  }

  return await prisma.user.update({
    where: { id: userId },
    data,
  })
}

const deleteUser = async (id) => {
  const userId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(userId)) {
    throw new Error('Invalid user id')
  }

  return await prisma.user.update({
    where: { id: userId },
    data: { isActive: false },
  })
}

const getUserByEmail = async (email) => {
  return await prisma.user.findUnique({
    where: { email },
  })
}

const getUserByUsername = async (username) => {
  return await prisma.user.findUnique({
    where: { username },
  })
}

// =====================================================================
// PLANNING
// =====================================================================

const getPlanningByUserAndDate = async (userId, date, company_id = null) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const dateObj = new Date(`${date}T00:00:00`)

  return await prisma.planning.findFirst({
    where: {
      userId: userIdInt,
      date: {
        gte: dateObj,
        lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
      },
      ...(companyIdInt !== null && companyIdInt !== undefined && { companyId: companyIdInt }),
    },
  })
}

const getPlanningByUser = async (
  userId,
  startDate = null,
  endDate = null,
  company_id = null
) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  return await prisma.planning.findMany({
    where: {
      userId: userIdInt,
      ...(startDate && { date: { gte: new Date(`${startDate}T00:00:00Z`) } }),
      ...(endDate && { date: { lte: new Date(`${endDate}T23:59:59Z`) } }),
      ...(companyIdInt !== null && companyIdInt !== undefined && { companyId: companyIdInt }),
    },
  })
}

const getAllPlanning = async (startDate = null, endDate = null, company_id = null) => {
  return await prisma.planning.findMany({
    where: {
      ...(startDate && { date: { gte: new Date(`${startDate}T00:00:00Z`) } }),
      ...(endDate && { date: { lte: new Date(`${endDate}T23:59:59Z`) } }),
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
  })
}

const createPlanning = async (
  userId,
  date,
  type,
  notes = null,
  company_id = null,
  start_time = null,
  end_time = null
) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const companyIdInt = typeof company_id === 'string' ? parseInt(company_id, 10) : company_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const dateObj = new Date(`${date}T00:00:00Z`)

  return await prisma.planning.upsert({
    where: {
      userId_date: {
        userId: userIdInt,
        date: dateObj,
      },
    },
    update: {
      type,
      notes,
      startTime: start_time,
      endTime: end_time,
    },
    create: {
      userId: userIdInt,
      date: dateObj,
      type,
      notes,
      companyId: companyIdInt,
      startTime: start_time,
      endTime: end_time,
    },
  })
}

const updatePlanning = async (id, updates) => {
  const fieldMap = {
    type: 'type',
    notes: 'notes',
    start_time: 'startTime',
    end_time: 'endTime',
    startTime: 'startTime',
    endTime: 'endTime',
  }
  const data = {}

  for (const [k, v] of Object.entries(updates)) {
    const mappedKey = fieldMap[k]
    if (mappedKey) {
      data[mappedKey] = v
    }
  }

  return await prisma.planning.update({
    where: { id },
    data,
  })
}

const deletePlanning = async (id) => {
  return await prisma.planning.delete({
    where: { id },
  })
}

const deletePlanningByUserAndDate = async (userId, date) => {
  const dateObj = new Date(`${date}T00:00:00Z`)

  return await prisma.planning.deleteMany({
    where: {
      userId,
      date: {
        gte: dateObj,
        lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
      },
    },
  })
}

// =====================================================================
// COMPANIES
// =====================================================================

const createCompany = async (
  name,
  company_code,
  contact_email = null,
  phone = null,
  whatsapp = {}
) => {
  return await prisma.company.create({
    data: {
      name,
      companyCode: company_code,
      contactEmail: contact_email,
      phone,
      whatsappPhoneNumberId: whatsapp.phone_number_id || null,
      whatsappAccessToken: whatsapp.access_token || null,
      whatsappDisplayNumber: whatsapp.display_number || null,
    },
  })
}

const getAllCompanies = async () => {
  return await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  })
}

const getCompanyById = async (id) => {
  return await prisma.company.findFirst({
    where: { id, isActive: true },
  })
}

const getCompanyByCode = async (company_code) => {
  return await prisma.company.findFirst({
    where: { companyCode: company_code, isActive: true },
  })
}

const getCompanyByWhatsappPhoneId = async (phone_number_id) => {
  if (!phone_number_id) return null

  return await prisma.company.findFirst({
    where: {
      whatsappPhoneNumberId: phone_number_id,
      isActive: true,
    },
  })
}

const updateCompany = async (id, updates) => {
  const companyId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(companyId)) {
    throw new Error('Invalid company id')
  }

  const fieldMap = {
    name: 'name',
    company_code: 'companyCode',
    companyCode: 'companyCode',
    contact_email: 'contactEmail',
    contactEmail: 'contactEmail',
    phone: 'phone',
    is_active: 'isActive',
    isActive: 'isActive',
    whatsapp_phone_number_id: 'whatsappPhoneNumberId',
    whatsappPhoneNumberId: 'whatsappPhoneNumberId',
    whatsapp_access_token: 'whatsappAccessToken',
    whatsappAccessToken: 'whatsappAccessToken',
    whatsapp_display_number: 'whatsappDisplayNumber',
    whatsappDisplayNumber: 'whatsappDisplayNumber',
  }

  const data = {}

  for (const [k, v] of Object.entries(updates)) {
    const mappedKey = fieldMap[k]
    if (mappedKey) {
      data[mappedKey] = v
    }
  }

  if (Object.keys(data).length === 0) {
    throw new Error('No valid company fields to update')
  }

  return await prisma.company.update({
    where: { id: companyId },
    data,
  })
}

// =====================================================================
// SESSION ACTIONS (Logging)
// =====================================================================

const logSessionAction = async (
  phone,
  action,
  step = null,
  sessionData = null,
  errorMsg = null,
  success = true,
  company_id = null
) => {
  return await prisma.sessionAction.create({
    data: {
      phone,
      companyId: company_id,
      action,
      step,
      sessionData: sessionData || null,
      errorMessage: errorMsg,
      success,
    },
  })
}

const getSessionActionHistory = async (phone, company_id = null, limit = 50) => {
  return await prisma.sessionAction.findMany({
    where: {
      phone,
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

const getFailedSessionActions = async (company_id = null, limit = 100) => {
  return await prisma.sessionAction.findMany({
    where: {
      success: false,
      ...(company_id !== null && company_id !== undefined && { companyId: company_id }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

module.exports = {
  prisma,
  getAvailableSlots,
  bookAppointment,
  getLastCustomerNameByPhone,
  getAllAppointments,
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
  deletePlanningByUserAndDate,
  createCompany,
  getAllCompanies,
  getCompanyById,
  getCompanyByCode,
  getCompanyByWhatsappPhoneId,
  updateCompany,
  logSessionAction,
  getSessionActionHistory,
  getFailedSessionActions,
}