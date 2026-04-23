# FisioCom - Backend

Sistema de gestión de citas para fisioterapia con integración WhatsApp Business API.

## 🚀 Características

- ✅ API REST completa para gestión de citas
- ✅ Integración con WhatsApp Business API de Meta
- ✅ Validación automática de disponibilidad
- ✅ Sugerencias de alternativas cuando no hay disponibilidad
- ✅ Base de datos PostgreSQL
- ✅ Webhook para recibir mensajes de WhatsApp
- ✅ CORS habilitado para conectar frontend Vue 3

## 📋 Requisitos Previos

- Node.js >= 18.0.0
- PostgreSQL 12+
- Docker (opcional)
- Cuenta en Meta For Developers con acceso a WhatsApp Business API

## 🔧 Instalación

### 1. Clonar y configurar el proyecto

```bash
cd FisioCom
npm install
```

### 2. Configurar variables de entorno

Copia el archivo `.env.example` a `.env` y rellena con tus credenciales:

```bash
cp .env.example .env
```

Edita el `.env`:

```env
# Base de datos
DB_USER=fisiocom
DB_PASSWORD=tu_password_seguro
DB_HOST=localhost
DB_PORT=5432
DB_NAME=fisiocom_db

# WhatsApp API (obtenido de Meta For Developers)
PHONE_NUMBER_ID=1074317399095849
WHATSAPP_TOKEN=tu_access_token
VERIFY_TOKEN=tu_verify_token_aleatorio

# Servidor
PORT=3000
```

### 3. Base de datos

#### Opción A: PostgreSQL local

```bash
# Crear base de datos
createdb fisiocom_db

# El servidor creará las tablas automáticamente al iniciar
```

#### Opción B: Docker Compose

```bash
docker-compose up -d
```

### 4. Iniciar servidor

```bash
npm start
```

El servidor estará disponible en `http://localhost:3000`

## 🔌 Endpoints API

### Gestión de Citas

- `GET /api/appointments` - Obtener todas las citas
- `GET /api/appointments/:id` - Obtener cita específica
- `GET /api/appointments/range/:startDate/:endDate` - Citas en rango de fechas
- `POST /api/appointments` - Crear nueva cita
- `PUT /api/appointments/:id` - Actualizar cita
- `DELETE /api/appointments/:id` - Eliminar cita

### Disponibilidad

- `GET /api/slots/:date` - Obtener horarios disponibles para una fecha (YYYY-MM-DD)

### WhatsApp Webhook

- `GET /webhook` - Verificación de webhook (Meta)
- `POST /webhook` - Recibir mensajes de WhatsApp

## 💬 Flujo WhatsApp

1. **Cliente envía "cita"** → Backend verifica disponibilidad del día
2. **Si hay disponibilidad** → Muestra horas disponibles
3. **Si no hay disponibilidad** → Sugiere 3 próximas fechas con horas
4. **Cliente selecciona horario** → Se reserva automáticamente y recibe confirmación

## 🔐 Configuración WhatsApp Business API

1. Ve a [Meta For Developers](https://developers.facebook.com)
2. Crea una aplicación de tipo "Negocio"
3. Agrega el producto "WhatsApp"
4. Obtén:
   - `PHONE_NUMBER_ID`: ID del número de teléfono
   - `WHATSAPP_TOKEN`: Token de acceso
   - `VERIFY_TOKEN`: Token de verificación (crear uno aleatorio)

5. Configura webhook en Meta:
   - URL: `https://tudominio.com/webhook`
   - Token de verificación: El que configuraste en `.env`
   - Suscríbete a eventos: `messages`

## 📦 Docker Compose

El archivo `docker-compose.yml` incluye:

- PostgreSQL 14
- Volumen persistente para datos
- Red interna

```bash
# Iniciar servicios
docker-compose up -d

# Ver logs
docker-compose logs -f

# Detener servicios
docker-compose down
```

## 🧪 Testing

Prueba los endpoints con curl:

```bash
# Obtener todas las citas
curl http://localhost:3000/api/appointments

# Obtener slots disponibles para hoy
curl "http://localhost:3000/api/slots/2026-04-23"

# Crear cita
curl -X POST http://localhost:3000/api/appointments \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+34666123456",
    "datetime": "2026-04-25T10:00:00",
    "service": "physio",
    "notes": "Primer cliente"
  }'
```

## 🏗️ Estructura del Proyecto

```
FisioCom/
├── src/
│   ├── server.js         # Servidor Express
│   ├── db.js             # Funciones de base de datos
│   ├── whatsapp.js       # Integración WhatsApp
│   └── scheduler.js      # Tareas programadas (opcional)
├── docker-compose.yml    # Configuración Docker
├── package.json
├── .env.example
└── README.md
```

## 📝 Variables de Base de Datos

La tabla `appointments` incluye:

- `id`: ID único (PRIMARY KEY)
- `phone`: Teléfono del cliente
- `datetime`: Fecha y hora de la cita
- `duration`: Duración en minutos (default: 60)
- `service`: Tipo de servicio (physio, sports, rehab, massage)
- `status`: Estado (confirmed, pending, cancelled)
- `notes`: Notas adicionales
- `created_at`: Fecha de creación
- `updated_at`: Fecha de actualización

## 🚨 Troubleshooting

### "Connection refused" en PostgreSQL
- Verifica que PostgreSQL está corriendo: `psql -U postgres`
- Si usas Docker: `docker-compose ps`

### "Cannot connect to WhatsApp API"
- Verifica que WHATSAPP_TOKEN es válido
- Revisa que PHONE_NUMBER_ID es correcto
- Comprueba conexión a internet

### Webhook no recibe mensajes
- Verifica que el dominio es https (Meta requiere HTTPS)
- Usa ngrok para tunelizar localhost: `ngrok http 3000`
- Comprueba VERIFY_TOKEN coincide en Meta y `.env`

## 📚 Documentación

Ver también:
- [Frontend Vue 3](../FisioCom-front/README.md)
- [Meta WhatsApp API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api)

## 📄 Licencia

ISC - WhatsApp Appointment Booking Service

A minimal Node.js service for handling physiotherapy appointment bookings via WhatsApp Business Cloud API.

## Features

- Webhook integration with Meta WhatsApp Cloud API
- Simple keyword-based intent detection
- SQLite database for appointment storage
- Availability checking and booking
- Deployable on Fly.io

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables (see below)
4. Run: `npm start`

## Environment Variables

Create a `.env` file in the root directory:

```
WHATSAPP_TOKEN=your_whatsapp_access_token
PHONE_NUMBER_ID=your_phone_number_id
VERIFY_TOKEN=your_webhook_verify_token
PORT=3000  # optional, defaults to 3000
```

## WhatsApp Setup

1. Create a Meta Business account and WhatsApp Business API access
2. Get your `WHATSAPP_TOKEN` and `PHONE_NUMBER_ID` from Meta
3. Set the webhook URL to `https://your-domain.com/webhook`
4. Use `VERIFY_TOKEN` for webhook verification

## Usage

- Users send "cita" to request booking
- System responds with available slots
- Users select a time (e.g., "10:00")
- System books and confirms

## Deployment on Fly.io

1. Install Fly CLI
2. `fly launch` (follow prompts)
3. Set secrets: `fly secrets set WHATSAPP_TOKEN=...` etc.
4. Deploy: `fly deploy`

## Project Structure

```
src/
  server.js      # Main Express server and webhook
  whatsapp.js    # Message sending function
  db.js          # SQLite database operations
  scheduler.js   # Placeholder for future features
```

## API Endpoints

- `GET /webhook` - Webhook verification
- `POST /webhook` - Incoming message handling

## Notes

- Uses simple keyword matching for intents (no AI)
- Slots: 60 min, 09:00-20:00
- Prevents double booking
- Logs to console
