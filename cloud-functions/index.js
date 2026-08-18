// ./cloud-functions/index.js
/**
 * PIXEL RUSH — Cloud Function for EdgeOne Pages
 * -----------------------------------------------------
 * Express server với WebSocket relay cho multiplayer game.
 * Sử dụng EdgeOne Blob để lưu trữ dữ liệu phòng chơi.
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
import { getStore } from "@edgeone/pages-blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '../dist');
const INDEX_HTML = join(DIST_DIR, 'index.html');

const PORT = process.env.PORT || 8000;
const MAX_PLAYERS = 2;
const BLOB_STORE_NAME = "pixel-rush-rooms";

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

// Helper functions for Blob storage
const getRoomKey = (roomCode) => `rooms/${roomCode}.json`;
const getStatusKey = (roomCode) => `status/${roomCode}.json`;

// API endpoint: danh sách phòng chơi
app.get('/rooms', async (req, res) => {
  try {
    const store = getStore(BLOB_STORE_NAME);
    const { blobs } = await store.list({ prefix: 'rooms/' });
    
    const roomList = [];
    for (const blob of blobs) {
      const roomCode = blob.key.replace('rooms/', '').replace('.json', '');
      try {
        const roomData = await store.get(blob.key, { type: 'json' });
        if (roomData && Array.isArray(roomData.players)) {
          const statusData = await store.get(getStatusKey(roomCode), { type: 'json' });
          roomList.push({
            room: roomCode,
            players: roomData.players.length,
            max: MAX_PLAYERS,
            status: statusData?.status || 'lobby',
            pilots: roomData.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
          });
        }
      } catch (e) {
        console.error(`Error reading room ${roomCode}:`, e);
      }
    }
    
    res.json({
      maxPlayers: MAX_PLAYERS,
      rooms: roomList,
    });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// API endpoint: status server
app.get('/status', async (req, res) => {
  try {
    const store = getStore(BLOB_STORE_NAME);
    const { blobs } = await store.list({ prefix: 'rooms/' });
    
    const openRooms = [];
    for (const blob of blobs) {
      const roomCode = blob.key.replace('rooms/', '').replace('.json', '');
      try {
        const roomData = await store.get(blob.key, { type: 'json' });
        if (roomData && Array.isArray(roomData.players)) {
          openRooms.push({
            room: roomCode,
            players: roomData.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
          });
        }
      } catch (e) {
        console.error(`Error reading room ${roomCode}:`, e);
      }
    }
    
    res.json({
      name: 'PIXEL RUSH relay server',
      ws: `ws://localhost:${PORT}/ws?room=<ROOM_CODE>`,
      rooms: `http://localhost:${PORT}/rooms`,
      maxPlayers: MAX_PLAYERS,
      open: openRooms,
    });
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
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

const broadcast = async (store, roomCode, clients, obj, exceptId) => {
  for (const c of clients) {
    if (c.id !== exceptId) {
      send(c.ws, obj);
    }
  }
};

wss.on('connection', async (ws, req) => {
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

  const store = getStore(BLOB_STORE_NAME);
  const roomKey = getRoomKey(roomCode);
  
  // Đọc dữ liệu phòng từ Blob
  let roomData = await store.get(roomKey, { type: 'json' });
  if (!roomData) {
    roomData = { players: [] };
  }
  
  let list = roomData.players || [];

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
  
  // Thêm client vào danh sách và lưu vào Blob
  list.push(client);
  await store.setJSON(roomKey, { players: list });
  
  // Lưu trạng thái phòng nếu chưa có
  const statusKey = getStatusKey(roomCode);
  let statusData = await store.get(statusKey, { type: 'json' });
  if (!statusData) {
    await store.setJSON(statusKey, { status: 'lobby' });
  }

  ws.on('message', async (data) => {
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
      
      // Cập nhật thông tin player trong Blob
      const playerIndex = list.findIndex(p => p.id === client.id);
      if (playerIndex !== -1) {
        list[playerIndex].name = client.name;
        list[playerIndex].color = client.color;
        await store.setJSON(roomKey, { players: list });
      }
      
      await broadcast(
        store,
        roomCode,
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
      await store.setJSON(statusKey, { status: 'battle' });
    } else if (t === 'lobby') {
      await store.setJSON(statusKey, { status: 'lobby' });
    }

    // Forward message đến các player khác (cho WebRTC signaling và game state)
    m.from = client.id;
    await broadcast(store, roomCode, list, m, client.id);
  });

  ws.on('close', async () => {
    const idx = list.findIndex(c => c.id === client.id);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    
    await broadcast(store, roomCode, list, { t: 'peer-leave', id: client.id });
    
    if (list.length === 0) {
      // Xóa phòng khi không còn player
      await store.delete(roomKey);
      await store.delete(statusKey);
    } else {
      // Cập nhật danh sách player trong Blob
      await store.setJSON(roomKey, { players: list });
      // Player đầu tiên còn lại trở thành HOST
      await broadcast(store, roomCode, list, { t: 'host', id: list[0].id });
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
export default app;

