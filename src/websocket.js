const WebSocket = require('ws');

// Global clients store: { userId: Set<WebSocket> }
const clients = new Map();
let globalWss = null;  // Store wss globally for heartbeat

// Initialize WebSocket server
const initWebSocketServer = (server) => {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  globalWss = wss;  // Save reference for heartbeat

  wss.on('connection', (ws, req) => {
    console.log(`🔌 WebSocket connection attempt from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');

    console.log(`  userId=${userId}, token=${token ? 'present' : 'missing'}`);

    // Basic auth check (token validation optional)
    if (!userId) {
      console.log(`  ❌ Rejected: no userId`);
      ws.close(4000, 'userId required');
      return;
    }

    // Register client
    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId).add(ws);

    // Heartbeat: mark connection as alive
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    console.log(`✅ WebSocket connected: userId=${userId}, total connections for user=${clients.get(userId).size}, total connected users=${clients.size}`);

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

  // Ping all connected clients every 30 seconds (heartbeat)
  const heartbeatInterval = setInterval(() => {
    if (globalWss) {
      console.log(`💓 Heartbeat check: ${globalWss.clients.size} total connections`);
      globalWss.clients.forEach((ws) => {
        // Close stale connections
        if (ws.isAlive === false) {
          console.log('   💀 Terminating stale connection');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }
  }, 30000);

  // Cleanup interval on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
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
