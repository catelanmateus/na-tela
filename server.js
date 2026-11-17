const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

const PORT = process.env.PORT || 3000;

// Com LiveKit (SFU), quem transmite envia um único fluxo e o servidor repassa.
// Sem ele, a mídia vai P2P em malha (cada um envia para todos).
const LIVEKIT = process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
  ? { url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET }
  : null;
const roomService = LIVEKIT
  ? new RoomServiceClient(LIVEKIT.url.replace(/^ws/, 'http'), LIVEKIT.key, LIVEKIT.secret)
  : null;

// Na malha P2P o upload de quem transmite cresce com cada espectador, então salas pequenas.
const MAX_PEERS = Number(process.env.MAX_PEERS) || (LIVEKIT ? 30 : 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
// Cliente do LiveKit servido daqui (versão travada pelo package-lock, sem CDN).
const LIVEKIT_CLIENT = path.join(path.dirname(require.resolve('livekit-client')), 'livekit-client.umd.js');
app.get('/vendor/livekit-client.js', (req, res) => res.sendFile(LIVEKIT_CLIENT, { maxAge: '1d' }));
// Supressão de ruído por IA (RNNoise em WebAssembly), roda no navegador de quem fala.
const NOISE_DIST = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
app.get('/vendor/noise/index.js', (req, res) => res.sendFile(path.join(NOISE_DIST, 'index.js'), { maxAge: '1d' }));
app.get('/vendor/noise/rnnoiseWorklet.js', (req, res) => res.sendFile(path.join(NOISE_DIST, 'rnnoise', 'workletProcessor.js'), { maxAge: '1d' }));
for (const file of ['rnnoise.wasm', 'rnnoise_simd.wasm']) {
  app.get(`/vendor/noise/${file}`, (req, res) => res.type('application/wasm').sendFile(path.join(NOISE_DIST, file), { maxAge: '7d' }));
}

// key (nome em minúsculas) -> { name, salt, passHash, peers: Map<socketId, {name, sharing, muted, screenStreamId, micStreamId}> }
const rooms = new Map();

const roomKey = (name) => String(name || '').trim().toLowerCase();
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
// Prefixo para não misturar com outras salas do mesmo projeto LiveKit.
const sfuRoomName = (key) => `na-tela:${key}`;

// O token só sai depois da senha conferida, e só vale para esta sala.
async function sfuToken(key, identity, name) {
  const at = new AccessToken(LIVEKIT.key, LIVEKIT.secret, { identity, name, ttl: '12h' });
  at.addGrant({ roomJoin: true, room: sfuRoomName(key), canPublish: true, canSubscribe: true, canPublishData: false });
  return at.toJwt();
}

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return list;
}

app.get('/api/config', (req, res) => res.json({ iceServers: iceServers(), maxPeers: MAX_PEERS, sfu: Boolean(LIVEKIT) }));

// Status das salas favoritas: /api/rooms?n=sala1&n=sala2
app.get('/api/rooms', (req, res) => {
  const names = [].concat(req.query.n || []).slice(0, 50);
  res.json(names.map((name) => {
    const room = rooms.get(roomKey(name));
    const peers = room ? [...room.peers.values()] : [];
    return {
      name,
      online: peers.length,
      live: peers.some((p) => p.sharing),
      locked: Boolean(room && room.passHash),
    };
  }));
});

app.get('/healthz', (req, res) => res.send('ok'));

const STATE_KEYS = ['sharing', 'muted', 'screenStreamId', 'micStreamId'];

function pickState(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of STATE_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    out[key] = typeof value === 'boolean' ? value : value == null ? null : String(value).slice(0, 100);
  }
  return out;
}

io.on('connection', (socket) => {
  let currentKey = null;

  socket.on('join', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (currentKey) return ack({ error: 'Você já está em uma sala.' });

    const roomName = String(payload?.room || '').trim().slice(0, 40);
    const displayName = String(payload?.name || '').trim().slice(0, 30) || 'Anônimo';
    const password = String(payload?.password || '');
    if (!roomName) return ack({ error: 'Informe o nome da sala.' });

    const key = roomKey(roomName);
    // O token é gerado antes das checagens (é assíncrono) e só é entregue se elas passarem,
    // assim a validação da sala abaixo continua síncrona e sem corrida.
    let livekit = null;
    if (LIVEKIT) {
      try {
        livekit = { url: LIVEKIT.url, token: await sfuToken(key, socket.id, displayName) };
      } catch (err) {
        console.error('livekit token', err);
        return ack({ error: 'Falha ao preparar a transmissão. Tente de novo.' });
      }
      if (!socket.connected) return;
      if (currentKey) return ack({ error: 'Você já está em uma sala.' });
    }

    let room = rooms.get(key);
    if (!room) {
      // Quem cria a sala define a senha.
      const salt = crypto.randomBytes(16).toString('hex');
      room = { name: roomName, salt, passHash: password ? hashPassword(password, salt) : null, peers: new Map() };
      rooms.set(key, room);
    } else if (room.passHash && hashPassword(password, room.salt) !== room.passHash) {
      return ack({ error: 'Senha incorreta.' });
    } else if (room.peers.size >= MAX_PEERS) {
      return ack({ error: `Sala cheia (máximo ${MAX_PEERS} pessoas).` });
    }

    const peers = [...room.peers].map(([id, p]) => ({ id, ...p }));
    const me = { name: displayName, sharing: false, muted: false, screenStreamId: null, micStreamId: null, ...pickState(payload) };
    room.peers.set(socket.id, me);
    currentKey = key;
    socket.join(key);
    // Emitido antes do ack: os outros já conhecem o novo par quando a oferta WebRTC dele chegar.
    socket.to(key).emit('peer-joined', { id: socket.id, ...me });
    ack({ ok: true, id: socket.id, room: room.name, locked: Boolean(room.passHash), peers, livekit });
  });

  socket.on('signal', (msg) => {
    const room = currentKey && rooms.get(currentKey);
    if (!room || !msg || !room.peers.has(msg.to)) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  socket.on('state', (patch) => {
    const room = currentKey && rooms.get(currentKey);
    const me = room?.peers.get(socket.id);
    if (!me) return;
    const clean = pickState(patch);
    Object.assign(me, clean);
    socket.to(currentKey).emit('peer-state', { id: socket.id, ...clean });
  });

  socket.on('chat', (text) => {
    const room = currentKey && rooms.get(currentKey);
    const me = room?.peers.get(socket.id);
    const msg = String(text || '').trim().slice(0, 500);
    if (!me || !msg) return;
    io.to(currentKey).emit('chat', { id: socket.id, name: me.name, text: msg, ts: Date.now() });
  });

  function leave() {
    if (!currentKey) return;
    const room = rooms.get(currentKey);
    if (room) {
      room.peers.delete(socket.id);
      socket.to(currentKey).emit('peer-left', { id: socket.id });
      // Quem saiu da sala não continua recebendo vídeo pelo SFU.
      roomService?.removeParticipant(sfuRoomName(currentKey), socket.id).catch(() => {});
      if (room.peers.size === 0) rooms.delete(currentKey);
    }
    socket.leave(currentKey);
    currentKey = null;
  }

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => {
  console.log(`Na Tela rodando em http://localhost:${PORT}`);
});
