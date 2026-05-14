const { sendMessage } = require('./whatsapp');

// =====================================================================
// CREDENCIALES WABA POR CONVERSACIÓN
// =====================================================================
// Asociamos las credenciales del WABA de cada tenant al `from` que escribe,
// para que cada `reply()` use las del tenant correcto sin tener que pasar
// el arg por cada handler.
const wabaCredsByFrom = new Map();

const reply = async (from, text) => {
  const creds = wabaCredsByFrom.get(from) || null;
  await sendMessage(from, text, creds);
};
const {
  getAvailableSlots,
  bookAppointment,
  getAvailableUsersForDate,
  getPlanningByUserAndDate,
  getAppointmentByCustomId,
  cancelAppointmentByCustomId,
  getLastCustomerNameByPhone,
} = require('./db');

// =====================================================================
// SESIÓN POR USUARIO (con TTL)
// =====================================================================
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const sessions = new Map();

const getSession = (from) => {
  const s = sessions.get(from);
  if (!s) return null;
  if (Date.now() - s.touched > SESSION_TTL_MS) {
    sessions.delete(from);
    return null;
  }
  return s;
};

const setSession = (from, patch) => {
  const prev = sessions.get(from) || {};
  const next = { ...prev, ...patch, touched: Date.now() };
  sessions.set(from, next);
  return next;
};

const clearSession = (from) => sessions.delete(from);

// =====================================================================
// NORMALIZACIÓN
// =====================================================================
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(s).toLowerCase().trim();

// =====================================================================
// INTENT DETECTION (tolerante a sinónimos y typos comunes)
// =====================================================================
const INTENTS = {
  greet: ['hola', 'buenas', 'que tal', 'hey', 'holi', 'buenos dias', 'buenas tardes', 'buenas noches', 'hi', 'hello'],
  book: ['cita', 'reserva', 'reservar', 'agendar', 'agenda', 'pedir hora', 'quiero ir', 'me gustaria', 'necesito hora', 'puedo ir', 'apuntar'],
  cancel: ['anular', 'cancelar', 'borrar', 'eliminar', 'no puedo ir', 'no podre'],
  help: ['ayuda', 'help', 'info', 'que puedes', 'opciones', 'que sabes hacer'],
  restart: ['menu', 'volver', 'reiniciar', 'empezar de nuevo', 'otra vez', 'menu principal', 'salir', 'cancelar accion', 'olvidalo'],
  yes: ['si', 'sii', 'siii', 'vale', 'ok', 'okay', 'oki', 'claro', 'perfecto', 'dale', 'confirmar', 'confirmo', 'adelante', 'venga'],
  no: ['no', 'nope', 'mejor no', 'paso', 'cancela'],
  thanks: ['gracias', 'thanks', 'thx', 'muchas gracias', 'mil gracias'],
  skip: ['pasar', 'nada', 'skip', 'saltar', 'ninguna', 'omitir', 'sin notas'],
};

const matchIntent = (text, intent) => {
  const n = norm(text);
  return INTENTS[intent].some(k => n === k || n.includes(k));
};

// =====================================================================
// PARSERS DE FECHA (heredados, robustecidos)
// =====================================================================
const dayMap = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

const monthMap = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const getNextWeekday = (weekday, allowToday = false) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const result = new Date(today);
  const diff = (weekday - today.getDay() + 7) % 7;
  result.setDate(today.getDate() + (diff === 0 && !allowToday ? 7 : diff));
  return toISO(result);
};

const parseRelativeDate = (text) => {
  const n = norm(text);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/\bhoy\b/.test(n)) return toISO(today);
  if (/\bmanana\b/.test(n)) {
    const d = new Date(today);
    d.setDate(today.getDate() + 1);
    return toISO(d);
  }
  if (/\bpasado\s*manana\b/.test(n)) {
    const d = new Date(today);
    d.setDate(today.getDate() + 2);
    return toISO(d);
  }
  return null;
};

const parseSpanishDate = (text) => {
  const n = norm(text);
  const m = n.match(/(\d{1,2})\s*(?:de\s*)?([a-z]+)(?:\s*(?:de\s*)?\s*(\d{4}))?/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = monthMap[m[2]];
  if (!month || day < 1 || day > 31) return null;

  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate.getDate() !== day || candidate.getMonth() !== month - 1) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  candidate.setHours(0, 0, 0, 0);
  if (!m[3] && candidate < today) candidate.setFullYear(year + 1);

  return toISO(candidate);
};

const parseNumericDate = (text) => {
  const m = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?\b/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;

  const candidate = new Date(year, month - 1, day);
  if (candidate.getDate() !== day || candidate.getMonth() !== month - 1) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!m[3] && candidate < today) candidate.setFullYear(year + 1);

  return toISO(candidate);
};

const parseWeekday = (text) => {
  const n = norm(text);
  for (const [name, idx] of Object.entries(dayMap)) {
    if (n.includes(name)) return getNextWeekday(idx, /\beste\b/.test(n));
  }
  return null;
};

const parseDateFromText = (text) =>
  parseRelativeDate(text) || parseSpanishDate(text) || parseNumericDate(text) || parseWeekday(text);

const formatReadableDate = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
};

// =====================================================================
// PARSER DE HORA (acepta 9, 9h, 9am, 9:30, 9.30, "a las 10", etc.)
// =====================================================================
const parseTime = (text) => {
  const t = norm(text);
  let h, m = 0, suffix;

  // 9:30 / 9.30 / 9,30 / 9h30
  let match = t.match(/(\d{1,2})\s*[:\.,h]\s*(\d{2})\s*(am|pm)?/);
  if (match) {
    h = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
    suffix = match[3];
  } else {
    // 9 / 9h / 9 am / 9pm / a las 9
    match = t.match(/(?:a\s+las\s+)?(\d{1,2})\s*(h|am|pm)?\b/);
    if (match) {
      h = parseInt(match[1], 10);
      suffix = match[2] === 'h' ? undefined : match[2];
    }
  }

  if (h == null || isNaN(h) || m < 0 || m > 59) return null;
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23) return null;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// =====================================================================
// MATCHING DE PROFESIONAL (por número o nombre parcial)
// =====================================================================
const matchUserChoice = (text, users) => {
  const t = norm(text);

  const numMatch = t.match(/^(\d{1,2})$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < users.length) return users[idx];
  }

  const candidates = users.filter(u => {
    const name = norm(u.name);
    if (!name) return false;
    if (name === t) return true;
    if (name.includes(t) && t.length >= 3) return true;
    return name.split(/\s+/).some(p => p.length >= 3 && t.includes(p));
  });

  return candidates.length === 1 ? candidates[0] : null;
};

// =====================================================================
// MENSAJES (con variantes para naturalidad)
// =====================================================================
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const M = {
  welcome: () => pick([
    `¡Hola! 👋 Soy tu asistente de citas. Puedo ayudarte a *reservar* una cita o *cancelar* una existente.\n\n¿Qué te apetece hacer?`,
    `¡Hey! 👋 ¿En qué puedo ayudarte hoy? Dime *reservar* para pedir cita o *cancelar* si quieres anular alguna.`,
    `¡Buenas! 😊 Cuéntame, ¿quieres *reservar* una cita o *cancelar* alguna?`,
  ]),
  askName: () => pick([
    `¡Hola! 👋 Antes de empezar, ¿cómo te llamas?`,
    `¡Bienvenido! 😊 Para personalizar tu cita, dime cómo te llamas.`,
  ]),
  nameTooShort: () => `¿Me dices tu nombre completo, porfa? Necesito al menos un par de letras 🙂`,
  askDate: (name) => name
    ? pick([
        `¡Vale ${name}! 😊 ¿Para qué día te viene bien?\n\nPuedes decirme cosas como:\n• _hoy_, _mañana_, _pasado mañana_\n• _este viernes_, _lunes_\n• _22 de mayo_, _22/05_`,
        `Perfecto ${name}. ¿Qué día quieres? Algo como _mañana_, _este viernes_ o _22 de mayo_ vale.`,
      ])
    : pick([
        `Genial 😊 ¿Para qué día te viene bien?\n\nPuedes decirme cosas como:\n• _hoy_, _mañana_, _pasado mañana_\n• _este viernes_, _lunes_\n• _22 de mayo_, _22/05_`,
        `¡Vamos allá! ¿Qué día quieres? Algo como _mañana_, _este viernes_ o _22 de mayo_ vale.`,
      ]),
  recognized: (name) => `¡Hola de nuevo, ${name}! 👋 ¿Te ayudo a reservar otra cita?`,
  dateNotUnderstood: () => `Mmm, no he pillado la fecha 🤔. Prueba con _mañana_, _este viernes_, _22 de mayo_ o _22/05_.`,
  noProfessionalsThatDay: (readable) =>
    `Vaya 😔 El ${readable} no tengo a nadie disponible. ¿Probamos con otra fecha?`,
  listProfessionals: (readable, list) =>
    `📅 Para el *${readable}* tengo disponibles a:\n\n${list}\n\nResponde con el *número* o el *nombre* del profesional que prefieras.`,
  invalidChoice: () => pick([
    `Mmm, no he encontrado a ese profesional 🤔. Dime el número de la lista o el nombre tal como aparece.`,
    `No te he entendido del todo 😅. Prueba con el número que ves en la lista (ej: 1) o el nombre.`,
  ]),
  noSlots: (name, readable) =>
    `Lo siento, *${name}* no tiene huecos el ${readable} 😕. ¿Quieres probar otra fecha o con otro profesional?`,
  listSlots: (name, slots) =>
    `Perfecto ✨ será con *${name}*.\n\nEstos son los horarios libres:\n${slots.map(s => `🕒 ${s}`).join('\n')}\n\n¿A qué hora te viene mejor? (puedes escribir _09:00_, _9:30_, _10am_…)`,
  invalidTime: (slots) =>
    `Esa hora no la tengo libre 😅. Te dejo los huecos disponibles:\n${slots.map(s => `🕒 ${s}`).join('\n')}`,
  askNotes: () =>
    `¡Anotado! 📝 ¿Quieres dejarme alguna nota o motivo? (tipo de servicio, observaciones, etc.)\n\nSi no, escribe *pasar* y la dejamos sin notas.`,
  confirmSummary: ({ readable, time, name, notes, customerName }) =>
    `Antes de confirmar, te resumo:\n\n👤 Cliente: *${customerName}*\n📅 *${readable}* a las *${time}*\n💼 Con *${name}*\n📝 ${notes || '_(sin notas)_'}\n\n¿Lo reservo? Responde *sí* para confirmar o *no* para cancelar.`,
  bookingConfirmed: ({ readable, time, name, customId, notes, customerName }) =>
    `✅ ¡Cita confirmada${customerName ? `, ${customerName}` : ''}!\n\n📅 ${readable}\n🕒 ${time}\n💼 ${name}\n📝 ${notes || '_(sin notas)_'}\n\n🔑 Código de tu cita: *${customId}*\n\nGuárdalo bien — lo necesitarás si quieres cancelarla. ¡Te esperamos! 🙌`,
  bookingError: () =>
    `Uff, algo se ha torcido al guardar la cita 😖. ¿Probamos otra vez en un momento?`,
  bookingDeclined: () =>
    `Sin problema, no reservo nada 👍. Si cambias de idea, escríbeme cuando quieras.`,
  awaitingYesNo: () =>
    `Necesito un *sí* o un *no* para confirmar 🙂`,
  askCancelId: () =>
    `Sin problema. ¿Cuál es el código de tu cita? (algo tipo *34612345678-20240515-1500-ABC123*)`,
  cancelNotFound: () =>
    `No he encontrado ninguna cita con ese código 🔍. Asegúrate de copiarlo tal cual te lo dimos al reservar.`,
  cancelDone: (id) =>
    `Hecho ✅ tu cita queda anulada:\n*${id}*\n\nSi quieres volver a reservar, aquí estoy 😊`,
  cancelError: () =>
    `Vaya, no he podido cancelarla 😟. Inténtalo de nuevo dentro de un ratito.`,
  help: () =>
    `Esto es lo que sé hacer:\n\n📅 *Reservar* — dime "quiero una cita" o directamente el día\n❌ *Cancelar* — escribe "cancelar" y tu código de cita\n🔁 *Volver al inicio* — escribe "menú" en cualquier momento\n\n¿Por dónde empezamos?`,
  restarted: () =>
    `Listo, empezamos de cero 🔄. ¿Qué quieres hacer? *reservar* o *cancelar*.`,
  thanks: () => pick([`¡A ti! 😊`, `¡De nada! 🙌`, `Un placer ayudarte ✨`]),
  notUnderstood: () => pick([
    `Mmm, no acabo de pillarte 🤔. Escribe *menú* para empezar de nuevo, o dime directamente _reservar_ o _cancelar_.`,
    `Eso no lo he entendido 😅. Puedes decir *menú* para ver opciones.`,
  ]),
};

// =====================================================================
// HANDLERS POR STEP
// =====================================================================

const handleIdle = async (from, text, companyId) => {
  const possibleDate = parseDateFromText(text);

  if (matchIntent(text, 'book') || possibleDate) {
    // Si ya conocemos al cliente por el teléfono, saltamos asking-name
    const knownName = await getLastCustomerNameByPhone(from);
    if (knownName) {
      setSession(from, { step: 'awaiting-date', companyId, customerName: knownName });
      if (possibleDate) {
        return handleAwaitingDate(from, text, companyId, getSession(from));
      }
      await reply(from, M.askDate(knownName));
      return;
    }
    // Cliente nuevo → preguntar nombre primero
    setSession(from, { step: 'asking-name', companyId, pendingDate: possibleDate || null });
    await reply(from, M.askName());
    return;
  }

  if (matchIntent(text, 'cancel')) {
    setSession(from, { step: 'asking-cancel-id', companyId });
    await reply(from, M.askCancelId());
    return;
  }

  await reply(from, M.welcome());
};

const handleAskingName = async (from, text, companyId, session) => {
  const name = text.trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    await reply(from, M.nameTooShort());
    return;
  }
  // Si traíamos una fecha pendiente del primer mensaje, vamos directos a procesarla
  if (session.pendingDate) {
    setSession(from, { step: 'awaiting-date', companyId, customerName: name, pendingDate: null });
    return handleAwaitingDate(from, session.pendingDate, companyId, getSession(from));
  }
  setSession(from, { step: 'awaiting-date', companyId, customerName: name });
  await reply(from, M.askDate(name));
};

const handleAwaitingDate = async (from, text, companyId, session) => {
  const date = parseDateFromText(text);
  if (!date) {
    await reply(from, M.dateNotUnderstood());
    return;
  }

  const users = await getAvailableUsersForDate(date, companyId);
  if (!users.length) {
    await reply(from, M.noProfessionalsThatDay(formatReadableDate(date)));
    return;
  }

  setSession(from, { step: 'selecting-user', date, availableUsers: users, companyId });
  const list = users
    .map((u, i) => `*${i + 1}.* ${u.name}${u.specialties ? ` _(${u.specialties})_` : ''}`)
    .join('\n');
  await reply(from, M.listProfessionals(formatReadableDate(date), list));
};

const handleSelectingUser = async (from, text, companyId, session) => {
  // Permitir cambiar de fecha en mitad del flujo
  const newDate = parseDateFromText(text);
  if (newDate && newDate !== session.date) {
    setSession(from, { step: 'awaiting-date', companyId });
    return handleAwaitingDate(from, text, companyId, getSession(from));
  }

  const user = matchUserChoice(text, session.availableUsers || []);
  if (!user) {
    await reply(from, M.invalidChoice());
    return;
  }

  const planning = await getPlanningByUserAndDate(user.id, session.date, companyId);
  if (planning && (planning.type === 'vacation' || planning.type === 'sick')) {
    await reply(from, M.noSlots(user.name, formatReadableDate(session.date)));
    return;
  }

  const slots = await getAvailableSlots(session.date, user.id);
  if (!slots.length) {
    await reply(from, M.noSlots(user.name, formatReadableDate(session.date)));
    return;
  }

  const normalizedSlots = slots.map(s => s.slice(0, 5));
  setSession(from, {
    step: 'selecting-time',
    userId: user.id,
    userName: user.name,
    slots: normalizedSlots,
    companyId,
  });
  await reply(from, M.listSlots(user.name, normalizedSlots));
};

const handleSelectingTime = async (from, text, companyId, session) => {
  // Cambio de fecha mid-flow
  const newDate = parseDateFromText(text);
  if (newDate && newDate !== session.date) {
    setSession(from, { step: 'awaiting-date', companyId });
    return handleAwaitingDate(from, text, companyId, getSession(from));
  }

  const time = parseTime(text);
  if (!time) {
    await reply(from, M.invalidTime(session.slots || []));
    return;
  }

  const slots = await getAvailableSlots(session.date, session.userId);
  const normalized = slots.map(s => s.slice(0, 5));
  if (!normalized.includes(time)) {
    await reply(from, M.invalidTime(normalized));
    return;
  }

  // 🔥 Conversión local España (UTC+2 CEST) → UTC
  const [hours, minutes] = time.split(':').map(Number);
  const utcHours = String((hours - 2 + 24) % 24).padStart(2, '0');
  const utcMinutes = String(minutes).padStart(2, '0');
  const datetime = `${session.date}T${utcHours}:${utcMinutes}:00`;

  setSession(from, { step: 'asking-notes', time, datetime, companyId });
  await reply(from, M.askNotes());
};

const handleAskingNotes = async (from, text, companyId, session) => {
  const notes = matchIntent(text, 'skip') ? '' : text.trim();
  setSession(from, { step: 'confirming', notes });
  await reply(from, M.confirmSummary({
    readable: formatReadableDate(session.date),
    time: session.time,
    name: session.userName,
    notes,
    customerName: session.customerName,
  }));
};

const handleConfirming = async (from, text, companyId, session) => {
  if (matchIntent(text, 'yes')) {
    try {
      const appointment = await bookAppointment(
        from,
        session.datetime,
        'general',
        session.userId,
        session.notes || '',
        session.companyId || companyId,
        session.customerName || null,
      );
      await reply(from, M.bookingConfirmed({
        readable: formatReadableDate(session.date),
        time: session.time,
        name: session.userName,
        notes: session.notes,
        customId: appointment.custom_id,
        customerName: session.customerName,
      }));
    } catch (err) {
      console.error('[bot] booking error:', err);
      if (err.message?.includes('Slot ocupado') || err.code === '23505') {
        await reply(from, `¡Uy! 😬 Justo ese hueco se acaba de ocupar. Si quieres, escribe *menú* y empezamos de nuevo.`);
      } else {
        await reply(from, M.bookingError());
      }
    }
    clearSession(from);
    return;
  }

  if (matchIntent(text, 'no')) {
    clearSession(from);
    await reply(from, M.bookingDeclined());
    return;
  }

  await reply(from, M.awaitingYesNo());
};

const handleCancelId = async (from, text) => {
  const id = text.trim().toUpperCase();
  try {
    const appointment = await getAppointmentByCustomId(id, null);
    if (!appointment) {
      await reply(from, M.cancelNotFound());
      return;
    }
    await cancelAppointmentByCustomId(id, appointment.company_id);
    await reply(from, M.cancelDone(id));
  } catch (err) {
    console.error('[bot] cancel error:', err);
    await reply(from, M.cancelError());
  }
  clearSession(from);
};

// =====================================================================
// ENTRY POINT
// =====================================================================
const DEFAULT_COMPANY_ID = parseInt(process.env.DEFAULT_WHATSAPP_COMPANY_ID || '1', 10);

const handleMessage = async (from, rawText, companyId = DEFAULT_COMPANY_ID, credentials = null) => {
  try {
    if (credentials) {
      wabaCredsByFrom.set(from, credentials);
    } else {
      wabaCredsByFrom.delete(from); // forzar fallback a env vars
    }

    const text = String(rawText || '').trim();
    if (!text) return;

    const session = getSession(from) || {};

    // -------- Comandos globales (funcionan en cualquier step) --------
    if (matchIntent(text, 'restart')) {
      clearSession(from);
      await reply(from, M.restarted());
      return;
    }

    if (matchIntent(text, 'help')) {
      await reply(from, M.help());
      return;
    }

    if (matchIntent(text, 'thanks') && !session.step) {
      await reply(from, M.thanks());
      return;
    }

    // -------- Dispatcher por step --------
    switch (session.step) {
      case undefined:
      case null:
        return handleIdle(from, text, companyId);
      case 'asking-name':
        return handleAskingName(from, text, companyId, session);
      case 'awaiting-date':
        return handleAwaitingDate(from, text, companyId, session);
      case 'selecting-user':
        return handleSelectingUser(from, text, companyId, session);
      case 'selecting-time':
        return handleSelectingTime(from, text, companyId, session);
      case 'asking-notes':
        return handleAskingNotes(from, text, companyId, session);
      case 'confirming':
        return handleConfirming(from, text, companyId, session);
      case 'asking-cancel-id':
        return handleCancelId(from, text);
      default:
        clearSession(from);
        await reply(from, M.notUnderstood());
    }
  } catch (err) {
    console.error('[bot] handleMessage error:', err);
    await reply(from, M.bookingError());
  }
};

module.exports = { handleMessage };
