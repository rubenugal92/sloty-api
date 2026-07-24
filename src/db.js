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
  } else {
    // Sin userId: buscar rango mínimo/máximo de plannings ese día
    const plannings = await prisma.planning.findMany({
      where: {
        date: {
          gte: start,
          lt: new Date(start.getTime() + 24 * 60 * 60 * 1000),
        },
        type: 'work',
        user: { isActive: true },
      },
      select: { startTime: true, endTime: true },
    })
    
    if (plannings.length === 0) return [] // No hay trabajadores ese día
    
    // Encontrar rango mínimo-máximo
    let minHour = 24
    let maxHour = 0
    plannings.forEach(p => {
      const pStart = parseInt(p.startTime?.slice(0, 2), 10) || 9
      const pEnd = parseInt(p.endTime?.slice(0, 2), 10) || 20
      minHour = Math.min(minHour, pStart)
      maxHour = Math.max(maxHour, pEnd)
    })
    
    startHourLocal = minHour === 24 ? 9 : minHour
    endHourLocal = maxHour === 0 ? 20 : maxHour
  }

  // Generate slots in local time (HH:MM format) - every 15 minutes
  for (let h = startHourLocal; h < endHourLocal; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`)
    slots.push(`${String(h).padStart(2, '0')}:15`)
    slots.push(`${String(h).padStart(2, '0')}:30`)
    slots.push(`${String(h).padStart(2, '0')}:45`)
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
    select: { datetime: true, userId: true },
  })

  if (userId) {
    // Para un usuario específico: excluir sus citas
    const booked = appointments.map(a => {
      const utcTime = new Date(a.datetime)
      const localTime = new Date(utcTime.getTime() + 2 * 60 * 60 * 1000)
      return localTime.toISOString().slice(11, 16)
    })
    return slots.filter(s => !booked.includes(s))
  } else {
    // Sin userId: retornar slots donde NO TODOS los empleados estén ocupados
    // Obtener todos empleados disponibles ese día
    const availableUsers = await getAvailableUsersForDate(date)
    if (availableUsers.length === 0) return []
    
    // Para cada slot, verificar si hay AL MENOS UN empleado disponible
    const slotsWithAvailability = []
    for (const slot of slots) {
      for (const user of availableUsers) {
        const available = await getAvailableUsersForDateAndTime(date, slot, user.companyId)
        if (available.find(u => u.id === user.id)) {
          slotsWithAvailability.push(slot)
          break // Al menos uno disponible, pasar al siguiente slot
        }
      }
    }
    return slotsWithAvailability
  }
}

const getAvailableUsersForDate = async (date, center_id = null) => {
  const dateObj = new Date(`${date}T00:00:00`)
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id

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
      ...(centerIdInt !== null && centerIdInt !== undefined && Number.isInteger(centerIdInt) && { centerId: centerIdInt }),
    },
    orderBy: { name: 'asc' },
  })
}

const getAvailableUsersForDateAndTime = async (date, time, center_id = null) => {
  // time formato: "09:00", "14:30" (hora local España UTC+2)
  const dateObj = new Date(`${date}T00:00:00`)
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  const [hours, minutes] = time.split(':').map(Number)
  
  // Crear datetime local y convertir a UTC
  // Si usuario selecciona 12:00 local (UTC+2), guardar como 10:00 UTC
  const localDatetime = new Date(dateObj)
  localDatetime.setHours(hours, minutes, 0, 0)
  const datetimeObj = new Date(localDatetime.getTime() - 2 * 60 * 60 * 1000)
  
  // Buscar usuarios que:
  // 1. Tengan planning (trabajo) en esa fecha
  // 2. No tengan cita reservada en esa hora exacta (UTC)
  // 3. Estén dentro de su horario de trabajo (startTime <= hora < endTime)
  const allUsers = await prisma.user.findMany({
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
      ...(centerIdInt !== null && centerIdInt !== undefined && Number.isInteger(centerIdInt) && { centerId: centerIdInt }),
    },
    include: {
      plannings: {
        where: {
          date: {
            gte: dateObj,
            lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
          },
          type: 'work',
        },
      },
    },
    orderBy: { name: 'asc' },
  })
  
  // Filtrar por horario: solo usuarios cuyo planning cubre la hora solicitada
  const usersInTimeRange = allUsers.filter(user => {
    const planning = user.plannings?.[0] // asume 1 planning por día
    if (!planning) return false
    
    // Parsear startTime y endTime (formato "HH:MM")
    const [startHour, startMin] = planning.startTime ? planning.startTime.split(':').map(Number) : [0, 0]
    const [endHour, endMin] = planning.endTime ? planning.endTime.split(':').map(Number) : [24, 0]
    
    // Convertir a minutos desde medianoche para comparar
    const startTotalMin = startHour * 60 + startMin
    const endTotalMin = endHour * 60 + endMin
    const requestedTotalMin = hours * 60 + minutes
    
    // Verificar que hora solicitada está dentro del rango
    return requestedTotalMin >= startTotalMin && requestedTotalMin < endTotalMin
  })
  
  // Filtrar: excluir usuarios que tengan cita en esa hora exacta
  const bookedAppointments = await prisma.appointment.findMany({
    where: {
      datetime: datetimeObj,
      status: { not: 'cancelled' },
    },
    select: { userId: true },
  })
  
  const bookedUserIds = new Set(bookedAppointments.map(a => a.userId))
  return usersInTimeRange.filter(u => !bookedUserIds.has(u.id))
}

const getLeastBusyUserForDateAndTime = async (date, time, users, center_id = null) => {
  // De una lista de usuarios, retorna el que tenga MENOS citas en esa fecha
  if (!users || users.length === 0) return null
  if (users.length === 1) return users[0]
  
  const dateObj = new Date(`${date}T00:00:00`)
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  
  // Contar citas por usuario en esa fecha
  const appointmentCounts = await Promise.all(
    users.map(async (user) => {
      const count = await prisma.appointment.count({
        where: {
          userId: user.id,
          datetime: {
            gte: dateObj,
            lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
          },
          status: { not: 'cancelled' },
          ...(centerIdInt !== null && { centerId: centerIdInt }),
        },
      })
      return { user, count }
    })
  )
  
  // Retornar usuario con menor count
  return appointmentCounts.reduce((least, current) => 
    current.count < least.count ? current : least
  ).user
}

const bookAppointment = async (
  phone,
  datetime,
  service = 'physio',
  userId = null,
  notes = null,
  center_id = null,
  customer_name = null
) => {
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  let targetCenterId = centerIdInt

  if (!targetCenterId && userId) {
    const user = await prisma.user.findUnique({
      where: { id: typeof userId === 'string' ? parseInt(userId, 10) : userId },
      select: { centerId: true },
    })
    targetCenterId = user?.centerId || null
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

  if (!targetCenterId) {
    throw new Error('Invalid center for appointment')
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
      centerId: targetCenterId,
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

const getAllAppointments = async (center_id = null) => {
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  return await prisma.appointment.findMany({
    where: {
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
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

const getAppointmentById = async (id, center_id = null) => {
  const appointmentId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(appointmentId)) {
    throw new Error('Invalid appointment id')
  }

  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  return await prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
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

const getAppointmentByCustomId = async (custom_id, center_id = null) => {
  return await prisma.appointment.findFirst({
    where: {
      customId: custom_id,
      status: { not: 'cancelled' },
      ...(center_id !== null && { centerId: center_id }),
    },
  })
}

const cancelAppointmentByCustomId = async (custom_id, center_id = null) => {
  return await prisma.appointment.updateMany({
    where: {
      customId: custom_id,
      status: { not: 'cancelled' },
      ...(center_id !== null && { centerId: center_id }),
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

const getAllUsers = async (center_id = null) => {
  return await prisma.user.findMany({
    where: {
      isActive: true,
      ...(center_id !== null && center_id !== undefined && { centerId: center_id }),
    },
    orderBy: { name: 'asc' },
  })
}

const getUserById = async (id, center_id = null) => {
  const userId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(userId)) {
    throw new Error('Invalid user id')
  }

  return await prisma.user.findFirst({
    where: {
      id: userId,
      ...(center_id !== null && center_id !== undefined && { centerId: center_id }),
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
  center_id = null
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
      centerId: center_id,
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
    center_id: 'centerId',
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

const getPlanningByUserAndDate = async (userId, date, center_id = null) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
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
      ...(centerIdInt !== null && centerIdInt !== undefined && Number.isInteger(centerIdInt) && { centerId: centerIdInt }),
    },
  })
}

const getPlanningByUser = async (
  userId,
  startDate = null,
  endDate = null,
  center_id = null
) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  return await prisma.planning.findMany({
    where: {
      userId: userIdInt,
      ...(startDate && { date: { gte: new Date(`${startDate}T00:00:00`) } }),
      ...(endDate && { date: { lte: new Date(`${endDate}T23:59:59`) } }),
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
    },
  })
}

const getPlanningByUserAndDateRange = async (userId, startDate, endDate, center_id = null) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const startDateObj = new Date(`${startDate}T00:00:00`)
  const endDateObj = new Date(`${endDate}T23:59:59`)

  return await prisma.planning.findMany({
    where: {
      userId: userIdInt,
      date: {
        gte: startDateObj,
        lte: endDateObj,
      },
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
    },
    orderBy: [{ date: 'asc' }],
  })
}

const getPlanningById = async (id, center_id = null) => {
  const planningId = typeof id === 'string' ? parseInt(id, 10) : id
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(planningId)) {
    throw new Error('Invalid planning id')
  }

  return await prisma.planning.findFirst({
    where: {
      id: planningId,
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
    },
  })
}

const getAllPlanning = async (startDate = null, endDate = null, center_id = null) => {
  return await prisma.planning.findMany({
    where: {
      ...(startDate && { date: { gte: new Date(`${startDate}T00:00:00`) } }),
      ...(endDate && { date: { lte: new Date(`${endDate}T23:59:59`) } }),
      ...(center_id !== null && center_id !== undefined && { centerId: center_id }),
    },
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
  })
}

const createPlanning = async (
  userId,
  date,
  type,
  notes = null,
  center_id = null,
  start_time = null,
  end_time = null
) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const dateObj = new Date(`${date}T00:00:00`)

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
      centerId: centerIdInt,
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
  const planningId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(planningId)) {
    throw new Error('Invalid planning id')
  }

  return await prisma.planning.delete({
    where: { id: planningId },
  })
}

const deletePlanningByUserAndDate = async (userId, date, center_id = null) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const dateObj = new Date(`${date}T00:00:00`)

  return await prisma.planning.deleteMany({
    where: {
      userId: userIdInt,
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
      date: {
        gte: dateObj,
        lt: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000),
      },
    },
  })
}

const deletePlanningByUserAndDateRange = async (userId, startDate, endDate, center_id = null) => {
  const userIdInt = typeof userId === 'string' ? parseInt(userId, 10) : userId
  const centerIdInt = typeof center_id === 'string' ? parseInt(center_id, 10) : center_id
  if (!Number.isInteger(userIdInt)) {
    throw new Error('Invalid userId')
  }

  const startDateObj = new Date(`${startDate}T00:00:00`)
  const endDateObj = new Date(`${endDate}T23:59:59`)

  return await prisma.planning.deleteMany({
    where: {
      userId: userIdInt,
      ...(centerIdInt !== null && centerIdInt !== undefined && { centerId: centerIdInt }),
      date: {
        gte: startDateObj,
        lte: endDateObj,
      },
    },
  })
}

// =====================================================================
// CENTERS
// =====================================================================

const createCenter = async (
  companyId,
  name,
  address = null,
  phone = null,
  whatsapp = {}
) => {
  const companyIdInt = typeof companyId === 'string' ? parseInt(companyId, 10) : companyId
  if (!Number.isInteger(companyIdInt)) {
    throw new Error('Invalid company id')
  }

  return await prisma.center.create({
    data: {
      companyId: companyIdInt,
      name,
      address,
      phone,
      whatsappPhoneNumberId: whatsapp.phone_number_id || null,
      whatsappAccessToken: whatsapp.access_token || null,
      whatsappDisplayNumber: whatsapp.display_number || null,
      whatsappBusinessAccountId: whatsapp.whatsapp_business_account_id || null,
      whatsappBusinessId: whatsapp.business_id || null,
      whatsappConnectedAt: whatsapp.connected_at || null,
      whatsappConnectionStatus: whatsapp.connection_status || 'disconnected',
      tokenUpdatedAt: whatsapp.token_updated_at || null,
      tokenExpiresAt: whatsapp.token_expires_at || null,
    },
  })
}

const getCenterById = async (id) => {
  const centerId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(centerId)) {
    throw new Error('Invalid center id')
  }

  return await prisma.center.findFirst({
    where: { id: centerId, isActive: true },
  })
}

const getCentersByCompanyId = async (companyId) => {
  const companyIdInt = typeof companyId === 'string' ? parseInt(companyId, 10) : companyId
  if (!Number.isInteger(companyIdInt)) {
    throw new Error('Invalid company id')
  }

  return await prisma.center.findMany({
    where: { companyId: companyIdInt, isActive: true },
    orderBy: { name: 'asc' },
  })
}

const getCenterByWhatsappPhoneId = async (phone_number_id) => {
  if (!phone_number_id) return null

  return await prisma.center.findFirst({
    where: {
      whatsappPhoneNumberId: phone_number_id,
      isActive: true,
    },
  })
}

const updateCenter = async (id, updates) => {
  const centerId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(centerId)) {
    throw new Error('Invalid center id')
  }

  const fieldMap = {
    name: 'name',
    address: 'address',
    phone: 'phone',
    is_active: 'isActive',
    isActive: 'isActive',
    whatsapp_phone_number_id: 'whatsappPhoneNumberId',
    whatsappPhoneNumberId: 'whatsappPhoneNumberId',
    whatsapp_access_token: 'whatsappAccessToken',
    whatsappAccessToken: 'whatsappAccessToken',
    whatsapp_display_number: 'whatsappDisplayNumber',
    whatsappDisplayNumber: 'whatsappDisplayNumber',
    whatsapp_business_account_id: 'whatsappBusinessAccountId',
    whatsappBusinessAccountId: 'whatsappBusinessAccountId',
    whatsapp_business_id: 'whatsappBusinessId',
    whatsappBusinessId: 'whatsappBusinessId',
    whatsapp_connected_at: 'whatsappConnectedAt',
    whatsappConnectedAt: 'whatsappConnectedAt',
    whatsapp_connection_status: 'whatsappConnectionStatus',
    whatsappConnectionStatus: 'whatsappConnectionStatus',
    token_updated_at: 'tokenUpdatedAt',
    tokenUpdatedAt: 'tokenUpdatedAt',
    token_expires_at: 'tokenExpiresAt',
    tokenExpiresAt: 'tokenExpiresAt',
  }

  const data = {}

  for (const [k, v] of Object.entries(updates)) {
    const mappedKey = fieldMap[k]
    if (mappedKey) {
      data[mappedKey] = v
    }
  }

  if (Object.keys(data).length === 0) {
    throw new Error('No valid center fields to update')
  }

  return await prisma.center.update({
    where: { id: centerId },
    data,
  })
}

const deleteCenter = async (id) => {
  const centerId = typeof id === 'string' ? parseInt(id, 10) : id
  if (!Number.isInteger(centerId)) {
    throw new Error('Invalid center id')
  }

  return await prisma.center.delete({
    where: { id: centerId },
  })
}

const saveCenterWhatsappConfig = async (centerId, config) => {
  const centerIdInt = typeof centerId === 'string' ? parseInt(centerId, 10) : centerId
  if (!Number.isInteger(centerIdInt)) {
    throw new Error('Invalid center id')
  }

  return await prisma.center.update({
    where: { id: centerIdInt },
    data: {
      whatsappPhoneNumberId: config.phone_number_id || null,
      whatsappAccessToken: config.access_token || null,
      whatsappDisplayNumber: config.display_number || null,
      whatsappBusinessAccountId: config.whatsapp_business_account_id || null,
      whatsappBusinessId: config.business_id || null,
      whatsappConnectedAt: config.connected_at || new Date(),
      whatsappConnectionStatus: config.connection_status || 'connected',
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
  phone = null
) => {
  return await prisma.company.create({
    data: {
      name,
      companyCode: company_code,
      contactEmail: contact_email,
      phone,
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

  // Buscar en Center, luego retornar la Company
  const center = await prisma.center.findFirst({
    where: {
      whatsappPhoneNumberId: phone_number_id,
      isActive: true,
    },
    include: { company: true },
  })

  return center?.company || null
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
  center_id = null
) => {
  return await prisma.sessionAction.create({
    data: {
      phone,
      centerId: center_id,
      action,
      step,
      sessionData: sessionData || null,
      errorMessage: errorMsg,
      success,
    },
  })
}

const getSessionActionHistory = async (phone, center_id = null, limit = 50) => {
  return await prisma.sessionAction.findMany({
    where: {
      phone,
      ...(center_id !== null && center_id !== undefined && { centerId: center_id }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

const getFailedSessionActions = async (center_id = null, limit = 100) => {
  return await prisma.sessionAction.findMany({
    where: {
      success: false,
      ...(center_id !== null && center_id !== undefined && { centerId: center_id }),
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
  getPlanningByUserAndDateRange,
  getPlanningById,
  getAvailableUsersForDate,
  getAvailableUsersForDateAndTime,
  getLeastBusyUserForDateAndTime,
  getAllPlanning,
  createPlanning,
  updatePlanning,
  deletePlanning,
  deletePlanningByUserAndDate,
  deletePlanningByUserAndDateRange,
  createCenter,
  getCenterById,
  getCentersByCompanyId,
  getCenterByWhatsappPhoneId,
  updateCenter,
  deleteCenter,
  saveCenterWhatsappConfig,
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