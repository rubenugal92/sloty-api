const WebSocket = require('ws');

// Global clients store: { userId: Set<WebSocket> }
const clients = new Map();

// Initialize WebSocket server
const initWebSocketServer = (server) => {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');

    // Basic auth check (token validation optional)
    if (!userId) {
      ws.close(4000, 'userId required');
      return;
    }

    // Register client
    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId).add(ws);

    console.log(`✅ WebSocket connected: userId=${userId}`);

    ws.on('close', () => {
      const userClients = clients.get(userId);
      if (userClients) {
        userClients.delete(ws);
        if (userClients.size === 0) {
          clients.delete(userId);
        }
      }
      console.log(`❌ WebSocket disconnected: userId=${userId}`);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error (userId=${userId}):`, error);
    });
  });

  return wss;
};

// Broadcast appointment created to specific users or all
const broadcastAppointmentCreated = (appointment, targetUserIds = null) => {
  const message = JSON.stringify({
    type: 'appointment_created',
    data: appointment,
    timestamp: new Date().toISOString(),
  });

  if (targetUserIds) {
    // Send to specific users (can be array or single ID)
    const ids = Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds];
    console.log(`📤 Broadcasting appointment_created to users: ${ids.join(', ')}`);
    ids.forEach(userId => {
      const userClients = clients.get(String(userId));
      if (userClients) {
        console.log(`  ✅ User ${userId} has ${userClients.size} connection(s)`);
        userClients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
            console.log(`  📨 Message sent to user ${userId}`);
          }
        });
      } else {
        console.log(`  ❌ User ${userId} not connected`);
      }
    });
  } else {
    // Broadcast to all connected clients
    console.log(`📤 Broadcasting appointment_created to ALL users`);
    clients.forEach((userClients, userId) => {
      userClients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      });
    });
  }
};

// Broadcast appointment deleted
const broadcastAppointmentDeleted = (appointmentId, targetUserIds = null) => {
  const message = JSON.stringify({
    type: 'appointment_deleted',
    data: { id: appointmentId },
    timestamp: new Date().toISOString(),
  });

  if (targetUserIds) {
    const ids = Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds];
    ids.forEach(userId => {
      const userClients = clients.get(String(userId));
      if (userClients) {
        userClients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        });
      }
    });
  } else {
    clients.forEach((userClients) => {
      userClients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      });
    });
  }
};

module.exports = {
  initWebSocketServer,
  broadcastAppointmentCreated,
  broadcastAppointmentDeleted,
};
