# FisioCom - WhatsApp Appointment Booking Service

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
