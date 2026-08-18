// ./cloud-functions/ws/[[default]].js
/**
 * PIXEL RUSH — Cloud Function for EdgeOne Pages
 * -----------------------------------------------------
 * Express server với WebSocket relay cho multiplayer game.
 * 
 * Endpoints:
 *   /                    Game frontend (served from dist/)
 *   /ws?room=ROOM_CODE   WebSocket relay cho WebRTC signaling
 *   /rooms               API danh sách phòng chơi
 *   /status              JSON debug page
 */

import express from "express";
import { WebSocketServer } from 'ws';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '../../dist');
const INDEX_HTML = join(DIST_DIR, 'index.html');

const PORT = process.env.PORT || 8000;
const MAX_PLAYERS = 2;

const app = express();

// Middleware logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Upgrade');
  next();
});

// Serve static files from dist/
app.use(express.static(DIST_DIR, {
  fallthrough: true,
  index: 'index.html'
}));

// Fallback cho root path nếu chưa build
app.get('/', (req, res) => {
  if (existsSync(INDEX_HTML)) {
    res.sendFile(INDEX_HTML);
  } else {
    res.status(503).send('Run npm run build first to generate dist/ folder');
  }
});

// API endpoint: danh sách phòng chơi
const rooms = new Map();
const roomStatus = new Map();

app.get('/rooms', (req, res) => {
  const roomList = [...rooms.entries()].map(([room, list]) => ({
    room,
    players: list.length,
    max: MAX_PLAYERS,
    status: roomStatus.get(room) || 'lobby',
    pilots: list.map(c => ({ id: c.id, name: c.name, color: c.color })),
  }));
  
  res.json({
    maxPlayers: MAX_PLAYERS,
    rooms: roomList,
  });
});

// API endpoint: status server
app.get('/status', (req, res) => {
  res.json({
    name: 'PIXEL RUSH relay server',
    ws: `ws://localhost:${PORT}/ws?room=<ROOM_CODE>`,
    rooms: `http://localhost:${PORT}/rooms`,
    maxPlayers: MAX_PLAYERS,
    open: [...rooms.entries()].map(([room, list]) => ({
      room,
      players: list.map(c => ({ id: c.id, name: c.name, color: c.color })),
    })),
  });
});

// Tạo HTTP server từ Express app
const server = http.createServer(app);

// Thiết lập WebSocket server
const wss = new WebSocketServer({ noServer: true });

let seq = 0;

const send = (ws, obj) => {
  try {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(obj));
    }
  } catch {
    // ignore broken socket
  }
};

const broadcast = (room, obj, except) => {
  for (const c of room) {
    if (c.id !== except) {
      send(c.ws, obj);
    }
  }
};

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const roomCode = url.searchParams.get('room')?.trim().toUpperCase() || 'default';
  const id = `p${++seq}`;
  
  const client = {
    id,
    ws,
    room: roomCode,
    name: 'Pilot',
    color: '#888',
  };

  let list = rooms.get(roomCode);
  if (!list) {
    list = [];
    rooms.set(roomCode, list);
    roomStatus.set(roomCode, 'lobby');
  }

  // Phòng đầy - từ chối kết nối
  if (list.length >= MAX_PLAYERS) {
    send(ws, { t: 'error', msg: 'Room is full' });
    ws.close(4001, 'room full');
    return;
  }

  // Người đầu tiên trở thành HOST
  const youHost = list.length === 0;
  send(ws, {
    t: 'welcome',
    id,
    room: roomCode,
    youHost,
    maxPlayers: MAX_PLAYERS,
    peers: list.map(c => ({ id: c.id, name: c.name, color: c.color })),
  });
  
  list.push(client);

  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return; // ignore non-JSON frames
    }
    
    const t = String(m.t || '');

    if (t === 'join') {
      // Client thông báo tên và màu
      client.name = typeof m.name === 'string' ? m.name : client.name;
      client.color = typeof m.color === 'string' ? m.color : client.color;
      
      broadcast(
        list,
        { 
          t: 'peer-join', 
          from: client.id, 
          id: client.id, 
          name: client.name, 
          color: client.color 
        },
        client.id
      );
      return;
    }

    if (t === 'bye') {
      ws.close(1000, 'bye');
      return;
    }

    // Cập nhật trạng thái phòng
    if (t === 'start') {
      roomStatus.set(roomCode, 'battle');
    } else if (t === 'lobby') {
      roomStatus.set(roomCode, 'lobby');
    }

    // Forward message đến các player khác (cho WebRTC signaling và game state)
    m.from = client.id;
    broadcast(list, m, client.id);
  });

  ws.on('close', () => {
    const idx = list.indexOf(client);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    
    broadcast(list, { t: 'peer-leave', id: client.id });
    
    if (list.length === 0) {
      rooms.delete(roomCode);
      roomStatus.delete(roomCode);
    } else {
      // Player đầu tiên còn lại trở thành HOST
      broadcast(list, { t: 'host', id: list[0].id });
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// Xử lý WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Export server để EdgeOne Cloud Functions sử dụng
export default server;
