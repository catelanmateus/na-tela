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
const MAX_PEERS_P2P = 10;
const MAX_PEERS_SFU = Number(process.env.MAX_PEERS) || 15;

/* ---------- proteção contra abuso ----------
   O Render e o LiveKit gratuitos têm limite de uso. Estes valores evitam que alguém de
   fora (ou um robô) gaste o plano. Todos podem ser trocados por variável de ambiente. */
const ACCESS_CODE = process.env.ACCESS_CODE || '';                   // vazio = sem código de acesso
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 20;                // salas abertas ao mesmo tempo
const MAX_SFU_ROOMS = Number(process.env.MAX_SFU_ROOMS) || 3;         // salas no LiveKit; as outras vão P2P (grátis)
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 200;   // conexões abertas no total
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 10;    // abas abertas por IP
const SFU_SWEEP_MS = Number(process.env.SFU_SWEEP_MS) || 120_000;     // varredura de quem sobrou no LiveKit

// Balde de fichas: até `max` ações seguidas, recarregando `max` a cada `perMs`.
function rateLimiter(max, perMs) {
  const buckets = new Map();
  const take = (key) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: max, at: now };
    b.tokens = Math.min(max, b.tokens + ((now - b.at) * max) / perMs);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  // Esquece quem já recarregou tudo, para o mapa não crescer para sempre.
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (now - b.at > perMs) buckets.delete(key);
  }, 60_000).unref();
  return take;
}

const limits = {
  connect: rateLimiter(20, 60_000),  // novas conexões por IP
  join: rateLimiter(10, 60_000),     // tentativas de entrar (inclusive senha/código errado) por IP
  http: rateLimiter(120, 60_000),    // chamadas à /api por IP
  chat: rateLimiter(5, 5_000),       // mensagens por conexão
  signal: rateLimiter(400, 10_000),  // sinalização WebRTC por conexão (rajadas de ICE são normais)
  state: rateLimiter(30, 10_000),    // mudanças de estado por conexão
};

// IP de quem chamou. No Render a conexão chega por proxy; o primeiro do X-Forwarded-For
// pode ser forjado, então os limites por IP são só uma camada: os totais também valem.
function clientIp(headers, fallback) {
  return String(headers['cf-connecting-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim() || fallback || '?';
}

// Comparação em tempo constante (não dá pista de quantos caracteres acertou).
function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const app = express();
const server = http.createServer(app);
// Uma oferta SDP com todos os codecs tem ~10 KB; 100 KB é folga de sobra.
const io = new Server(server, { maxHttpBufferSize: 100_000 });

app.use('/api', (req, res, next) => {
  if (limits.http(clientIp(req.headers, req.socket.remoteAddress))) return next();
  res.status(429).json({ error: 'Muitas requisições. Espere um pouco.' });
});
app.use(express.static(path.join(__dirname, 'public')));
// Cliente do LiveKit servido daqui (versão travada pelo package-lock, sem CDN).
const LIVEKIT_CLIENT = path.join(path.dirname(require.resolve('livekit-client')), 'livekit-client.umd.js');
app.get('/vendor/livekit-client.js', (req, res) => res.sendFile(LIVEKIT_CLIENT, { maxAge: '1d' }));
// Supressão de ruído por IA (RNNoise em WebAssembly), roda no navegador de quem fala.
const NOISE_DIST = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
app.get('/vendor/noise/index.js', (req, res) => res.sendFile(path.join(NOISE_DIST, 'index.js'), { maxAge: '1d' }));
app.get('/vendor/noise/rnnoiseWorklet.js', (req, res) => res.sendFile(path.join(NOISE_DIST, 'rnnoise', 'workletProcessor.js'), { maxAge: '1d' }));
app.get('/vendor/noise/gtcrnWorklet.js', (req, res) => res.sendFile(path.join(NOISE_DIST, 'gtcrn', 'workletProcessor.js'), { maxAge: '1d' }));
for (const file of ['rnnoise.wasm', 'rnnoise_simd.wasm', 'gtcrn.wasm']) {
  app.get(`/vendor/noise/${file}`, (req, res) => res.type('application/wasm').sendFile(path.join(NOISE_DIST, file), { maxAge: '7d' }));
}

// key (nome em minúsculas) -> { name, salt, passHash, sfu, peers: Map<socketId, {name, sharing, muted, screenStreamId, micStreamId}> }
// sfu: a sala usa o LiveKit (decidido ao criar, conforme o teto de MAX_SFU_ROOMS).
const rooms = new Map();
const sfuRoomCount = () => [...rooms.values()].filter((r) => r.sfu).length;
// Salas do LiveKit para as quais este servidor emitiu token (nome -> quando foi o último).
// A varredura só mexe nelas: outro site usando o mesmo projeto do LiveKit não tem as salas
// derrubadas por este. Cada sala é vigiada até o último token dela vencer.
const SFU_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const sfuRoomsIssued = new Map();

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

app.get('/api/config', (req, res) => res.json({ iceServers: iceServers(), sfu: Boolean(LIVEKIT), accessCode: Boolean(ACCESS_CODE) }));

// Status das salas favoritas: /api/rooms?n=sala1&n=sala2
// Com código de acesso, só responde para quem mandar o código (não revela quem está online).
app.get('/api/rooms', (req, res) => {
  if (ACCESS_CODE && !sameSecret(req.get('x-access-code'), ACCESS_CODE)) return res.status(403).json({ error: 'Código de acesso necessário.' });
  const names = [].concat(req.query.n || []).slice(0, 20);
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

// Conexões abertas por IP (para o teto MAX_CONN_PER_IP).
const connPerIp = new Map();

io.use((socket, next) => {
  const ip = clientIp(socket.handshake.headers, socket.handshake.address);
  if (io.engine.clientsCount > MAX_CONNECTIONS) return next(new Error('Servidor cheio. Tente mais tarde.'));
  if ((connPerIp.get(ip) || 0) >= MAX_CONN_PER_IP) return next(new Error('Muitas abas abertas.'));
  if (!limits.connect(ip)) return next(new Error('Muitas conexões. Espere um pouco.'));
  socket.data.ip = ip;
  next();
});

io.on('connection', (socket) => {
  let currentKey = null;
  const { ip } = socket.data;
  connPerIp.set(ip, (connPerIp.get(ip) || 0) + 1);

  // Quem passa muito do limite está inundando o servidor de propósito: derruba.
  let strikes = 0;
  const allowed = (limiter, key = socket.id) => {
    if (limiter(key)) return true;
    if (++strikes > 200) socket.disconnect(true);
    return false;
  };

  socket.on('join', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (currentKey) return ack({ error: 'Você já está em uma sala.' });
    if (!allowed(limits.join, ip)) return ack({ error: 'Muitas tentativas. Espere um minuto.' });
    if (ACCESS_CODE && !sameSecret(payload?.accessCode, ACCESS_CODE)) return ack({ error: 'Código de acesso incorreto.', needCode: true });

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
      if (rooms.size >= MAX_ROOMS) return ack({ error: 'Muitas salas abertas agora. Tente mais tarde.' });
      // Quem cria a sala define a senha. Acima do teto de salas no LiveKit, a sala vai P2P.
      const salt = crypto.randomBytes(16).toString('hex');
      room = {
        name: roomName,
        salt,
        passHash: password ? hashPassword(password, salt) : null,
        sfu: Boolean(LIVEKIT) && sfuRoomCount() < MAX_SFU_ROOMS,
        peers: new Map(),
      };
      rooms.set(key, room);
    } else if (room.passHash && hashPassword(password, room.salt) !== room.passHash) {
      return ack({ error: 'Senha incorreta.' });
    } else if (room.peers.size >= (room.sfu ? MAX_PEERS_SFU : MAX_PEERS_P2P)) {
      return ack({ error: `Sala cheia (máximo ${room.sfu ? MAX_PEERS_SFU : MAX_PEERS_P2P} pessoas).` });
    }
    if (!room.sfu) livekit = null;
    else sfuRoomsIssued.set(sfuRoomName(key), Date.now());

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
    if (!allowed(limits.signal)) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  socket.on('state', (patch) => {
    const room = currentKey && rooms.get(currentKey);
    const me = room?.peers.get(socket.id);
    if (!me || !allowed(limits.state)) return;
    const clean = pickState(patch);
    Object.assign(me, clean);
    socket.to(currentKey).emit('peer-state', { id: socket.id, ...clean });
  });

  socket.on('chat', (text) => {
    const room = currentKey && rooms.get(currentKey);
    const me = room?.peers.get(socket.id);
    const msg = String(text || '').trim().slice(0, 500);
    if (!me || !msg) return;
    if (!allowed(limits.chat)) return socket.emit('notice', 'Calma! Muitas mensagens seguidas.');
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
  socket.on('disconnect', () => {
    leave();
    const left = (connPerIp.get(ip) || 1) - 1;
    if (left > 0) connPerIp.set(ip, left);
    else connPerIp.delete(ip);
  });
});

// Varredura do LiveKit: tira quem está lá mas não numa sala daqui (token reaproveitado
// depois de sair, aba que caiu sem avisar, sala que virou P2P...). Cada minuto conectado
// ao LiveKit conta no plano, então ninguém fica "esquecido" lá.
if (roomService) {
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const [name, issuedAt] of sfuRoomsIssued) if (now - issuedAt > SFU_TOKEN_TTL_MS) sfuRoomsIssued.delete(name);
      if (!sfuRoomsIssued.size) return;
      for (const lkRoom of await roomService.listRooms([...sfuRoomsIssued.keys()])) {
        const room = rooms.get(lkRoom.name.slice('na-tela:'.length));
        const participants = await roomService.listParticipants(lkRoom.name);
        for (const p of participants) {
          if (room?.sfu && room.peers.has(p.identity)) continue;
          await roomService.removeParticipant(lkRoom.name, p.identity).catch(() => {});
          console.log(`LiveKit: removido ${p.identity} de ${lkRoom.name} (não está na sala)`);
        }
      }
    } catch (err) {
      console.warn('varredura do LiveKit:', err.message);
    }
  }, SFU_SWEEP_MS).unref();
}

server.listen(PORT, () => {
  console.log(`Na Tela rodando em http://localhost:${PORT}`);
});
