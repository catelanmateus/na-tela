'use strict';

const $ = (sel) => document.querySelector(sel);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* armazenamento indisponível */ }
  },
};

// degradation: o que o encoder sacrifica quando falta rede/CPU.
const QUALITY = {
  game1080: { label: 'Jogo · 1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, hint: 'motion', degradation: 'balanced' },
  sharp1080: { label: 'Nítido · 1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, hint: 'motion', degradation: 'maintain-resolution' },
  game720: { label: 'Jogo · 720p 60fps', width: 1280, height: 720, fps: 60, bitrate: 5_000_000, hint: 'motion', degradation: 'balanced' },
  text1080: { label: 'Texto/código · 1080p 30fps', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, hint: 'detail', degradation: 'maintain-resolution' },
  light720: { label: 'Leve · 720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000, hint: 'motion', degradation: 'balanced' },
};

// H.264 costuma ter encoder de GPU (NVENC/QuickSync/AMF); VP8 é sempre na CPU.
const CODECS = {
  h264: { label: 'H.264 (GPU)', mime: 'video/H264' },
  av1: { label: 'AV1', mime: 'video/AV1' },
  vp9: { label: 'VP9', mime: 'video/VP9' },
  vp8: { label: 'VP8', mime: 'video/VP8' },
};

const SPEAK_THRESHOLD = 0.035;

const state = {
  myId: null,
  roomName: null,
  peers: new Map(),   // id -> peer
  tiles: new Map(),   // id -> { el, video, name }
  focusId: null,
  mic: null,
  screen: null,
  quality: null,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  audioCtx: null,
  meters: new Map(),  // key -> { src, analyser, buf, cb }
  speaking: new Map(),
  sfu: null,          // { room, micPub, screenPubs } quando a mídia passa pelo LiveKit
  sfuCfg: null,       // { url, token } se a sala usa o LiveKit (conecta só com mais alguém na sala)
  sfuAloneTimer: null,
  micChain: null,     // microfone com o filtro de ruído no caminho (state.mic = o que é enviado)
};

const socket = io();

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.iceServers) state.iceServers = cfg.iceServers;
    // Servidor fechado por código de acesso: o campo aparece já preenchido se guardado.
    if (cfg.accessCode) {
      $('#codeField').hidden = false;
      $('#codeInput').value = store.get('accessCode', '');
      $('#codeInput').required = true;
    }
    if (cfg.sfu) {
      $('#featTransport').innerHTML = '<b>Servidor SFU</b><span>um envio, vários espectadores</span>';
      loadLiveKit().catch(() => {}); // adianta o download
    }
  })
  .catch(() => {});

/* ================= utilidades ================= */

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 70%)`;
}

const noiseOn = () => $('#nsToggle').checked;

// A supressão do navegador fica desligada: quem tira o ruído é o RNNoise (abaixo).
// O cancelamento de eco continua, para quem usa caixa de som em vez de fone.
function micConstraints() {
  const deviceId = $('#micSelect').value;
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      noiseSuppression: false,
      echoCancellation: true,
      autoGainControl: true,
    },
  };
}

/* ================= supressão de ruído (RNNoise) ================= */
// O filtro de ruído do navegador quase não faz diferença em muitos microfones.
// O RNNoise é um supressor por IA, de código aberto, que roda aqui mesmo
// (AudioWorklet + WebAssembly), sem custo e sem mandar o áudio para lugar nenhum.
// O microfone passa por um AudioContext a 48 kHz (a taxa do RNNoise). Ligar ou
// desligar a supressão só troca a ligação dos nós: a faixa enviada é sempre a
// mesma, então não precisa renegociar (P2P) nem republicar (LiveKit).

let noiseLib = null;
function loadNoiseSuppressor() {
  noiseLib ??= (async () => {
    const lib = await import('/vendor/noise/index.js');
    const wasmBinary = await lib.loadRnnoise({ url: '/vendor/noise/rnnoise.wasm', simdUrl: '/vendor/noise/rnnoise_simd.wasm' });
    return { lib, wasmBinary };
  })().catch((err) => {
    noiseLib = null;
    throw err;
  });
  return noiseLib;
}

// Abre o microfone já com o filtro no caminho. Retorna { stream, ... } (stream = o que é enviado).
async function openMic() {
  const raw = await navigator.mediaDevices.getUserMedia(micConstraints());
  // 'balanced' dá um pouco mais de folga ao processamento de áudio que o padrão
  // ('interactive'): com o PC ocupado (jogo + transmissão) o áudio não engasga.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'balanced' });
  ctx.resume().catch(() => {});
  const mono = (node) => {
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    return node;
  };
  const source = ctx.createMediaStreamSource(raw);
  // Corta-graves em 80 Hz: tranco na mesa, zumbido e "pop" do microfone, sem mexer na voz.
  const highpass = mono(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 80, Q: 0.7 }));
  // Compressor suave no fim: segura os picos e deixa o volume da voz mais estável.
  const compressor = mono(new DynamicsCompressorNode(ctx, { threshold: -24, knee: 12, ratio: 3, attack: 0.003, release: 0.25 }));
  const dest = mono(ctx.createMediaStreamDestination());
  source.connect(highpass);
  compressor.connect(dest);
  const mic = { raw, ctx, source: highpass, dest: compressor, denoiser: null, gate: null, stream: dest.stream };
  try {
    const { lib, wasmBinary } = await loadNoiseSuppressor();
    await ctx.audioWorklet.addModule('/vendor/noise/rnnoiseWorklet.js');
    mic.denoiser = new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    mic.denoiser.channelCount = 1;
    mic.denoiser.channelCountMode = 'explicit';
  } catch (err) {
    console.warn('supressão por IA indisponível; usando a do navegador', err);
  }
  try {
    await ctx.audioWorklet.addModule('/gate-worklet.js');
    mic.gate = new AudioWorkletNode(ctx, 'nosso-servidor-noise-gate', {
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    mic.gate.port.onmessage = (e) => showMicLevel(e.data);
  } catch (err) {
    console.warn('portão de ruído indisponível', err);
  }
  routeMic(mic);
  return mic;
}

// microfone → corta-graves → (RNNoise, se a supressão estiver ligada) → portão de ruído
// → compressor → envio. Com a supressão desligada o portão fica sempre aberto: só mede o nível.
function routeMic(mic) {
  if (!mic) return;
  mic.source.disconnect();
  mic.denoiser?.disconnect();
  mic.gate?.disconnect();
  let node = mic.source;
  if (mic.denoiser && noiseOn()) {
    node.connect(mic.denoiser);
    node = mic.denoiser;
  }
  if (mic.gate) {
    node.connect(mic.gate);
    node = mic.gate;
  }
  node.connect(mic.dest);
  applyGate(mic);
  // Sem o RNNoise (navegador sem AudioWorklet/WebAssembly), cai na supressão do navegador.
  if (!mic.denoiser) mic.raw.getAudioTracks()[0]?.applyConstraints({ ...micConstraints().audio, noiseSuppression: noiseOn() }).catch(() => {});
}

function closeMic(mic) {
  if (!mic) return;
  mic.raw.getTracks().forEach((t) => t.stop());
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.denoiser?.destroy();
  mic.gate?.port.close();
  mic.ctx.close().catch(() => {});
}

function setNoise(on) {
  $('#nsToggle').checked = on;
  store.set('ns', on);
  routeMic(testMic);
  routeMic(state.micChain);
  updateNoiseBtn();
}

function updateNoiseBtn() {
  const on = noiseOn();
  $('#nsBtn').setAttribute('aria-pressed', String(on));
  $('#nsBtn span').textContent = on ? 'Ruído: filtrado' : 'Ruído: sem filtro';
  // A sensibilidade só vale com a supressão ligada.
  document.querySelectorAll('.sens').forEach((el) => el.classList.toggle('disabled', !on));
  document.querySelectorAll('.sens-range').forEach((r) => { r.disabled = !on; });
}

/* ---------- sensibilidade do microfone (portão de ruído) ---------- */
// Em dBFS: abaixo disso o microfone fica mudo. -40 deixa a voz perto do microfone passar
// e corta a maior parte do teclado, do mouse e da voz de longe; cada um ajusta no medidor.
const GATE_MIN_DB = -80;
const GATE_MAX_DB = -10;
const gateDb = () => store.get('gate', -40);
// Automática: o portão acompanha o ruído de fundo e o volume da voz e escolhe o limite.
const gateAuto = () => store.get('gateAuto', true);

function applyGate(mic) {
  const gate = mic?.gate;
  if (!gate) return;
  gate.parameters.get('auto').value = noiseOn() && gateAuto() ? 1 : 0;
  gate.parameters.get('threshold').value = noiseOn() ? gateDb() : -120;
}

const dbToPct = (db) => Math.max(0, Math.min(100, ((db - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)) * 100));

function showMicLevel({ db, open, thresholdDb, auto }) {
  document.querySelectorAll('.sens').forEach((el) => {
    el.querySelector('.sens-level').style.width = `${dbToPct(db)}%`;
    el.classList.toggle('open', open && noiseOn());
  });
  // No automático, a marca anda sozinha para mostrar o limite que está em uso.
  if (auto) document.querySelectorAll('.sens-range').forEach((r) => { r.value = Math.round(thresholdDb); });
}

// apply = false só na carga da página (ainda não há microfone aberto).
function setGateAuto(on, apply = true) {
  store.set('gateAuto', on);
  document.querySelectorAll('.sens-auto-toggle').forEach((c) => { c.checked = on; });
  document.querySelectorAll('.sens').forEach((el) => el.classList.toggle('auto', on));
  if (!on) document.querySelectorAll('.sens-range').forEach((r) => { r.value = gateDb(); });
  if (!apply) return;
  applyGate(testMic);
  applyGate(state.micChain);
}

document.querySelectorAll('.sens-range').forEach((range) => {
  range.min = GATE_MIN_DB;
  range.max = GATE_MAX_DB;
  range.value = gateDb();
  // Arrastar a marca é escolher na mão: desliga o automático.
  range.oninput = () => {
    store.set('gate', Number(range.value));
    document.querySelectorAll('.sens-range').forEach((r) => { if (r !== range) r.value = range.value; });
    if (gateAuto()) setGateAuto(false);
    applyGate(testMic);
    applyGate(state.micChain);
  };
});
document.querySelectorAll('.sens-auto-toggle').forEach((c) => { c.onchange = () => setGateAuto(c.checked); });
setGateAuto(gateAuto(), false);
updateNoiseBtn();

// Painel de sensibilidade na sala: abre pelo botão ao lado de "Ruído" e fecha ao clicar fora.
$('#micCfgBtn').onclick = (e) => {
  e.stopPropagation();
  const panel = $('#micPanel');
  panel.hidden = !panel.hidden;
  $('#micCfgBtn').setAttribute('aria-expanded', String(!panel.hidden));
};
$('#micPanel').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => {
  if ($('#micPanel').hidden) return;
  $('#micPanel').hidden = true;
  $('#micCfgBtn').setAttribute('aria-expanded', 'false');
});

/* ================= medidor de áudio ================= */

function audioCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

function watchLevel(key, stream, cb) {
  unwatchLevel(key);
  if (!stream || !stream.getAudioTracks().length) return;
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  state.meters.set(key, { src, analyser, buf: new Uint8Array(analyser.fftSize), cb });
}

function unwatchLevel(key) {
  const m = state.meters.get(key);
  if (!m) return;
  m.src.disconnect();
  state.meters.delete(key);
}

(function meterLoop() {
  for (const m of state.meters.values()) {
    m.analyser.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) { const x = (v - 128) / 128; sum += x * x; }
    m.cb(Math.sqrt(sum / m.buf.length));
  }
  requestAnimationFrame(meterLoop);
})();

function setSpeaking(id, on) {
  if (state.speaking.get(id) === on) return;
  state.speaking.set(id, on);
  state.tiles.get(id)?.el.classList.toggle('speaking', on);
  document.querySelector(`#peopleList li[data-id="${CSS.escape(id)}"]`)?.classList.toggle('speaking', on);
}

/* ================= lobby ================= */

const params = new URLSearchParams(location.search);
$('#nameInput').value = store.get('name', '');
$('#roomInput').value = params.get('sala') || store.get('lastRoom', '');
$('#nsToggle').checked = store.get('ns', true);

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = $('#micSelect');
    const current = sel.value || store.get('mic', '');
    sel.innerHTML = '<option value="">Padrão do sistema</option>';
    devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => sel.add(new Option(d.label || `Microfone ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  } catch { /* sem permissão ainda */ }
}
listMics();

// O teste usa o mesmo caminho do microfone na sala: com "Ouvir minha voz" dá para
// comparar com e sem a supressão.
let testMic = null;
const loopAudio = new Audio();

async function startMicTest() {
  try {
    testMic = await openMic();
  } catch {
    showJoinError('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
    return;
  }
  await listMics();
  loopAudio.srcObject = $('#loopToggle').checked ? testMic.stream : null;
  loopAudio.play().catch(() => {});
  $('#micTestBtn').textContent = 'Parar teste';
}

function stopMicTest() {
  if (!testMic) return;
  closeMic(testMic);
  testMic = null;
  loopAudio.srcObject = null;
  showMicLevel({ db: -120, open: false });
  $('#micTestBtn').textContent = 'Testar microfone';
}

$('#micTestBtn').onclick = () => (testMic ? stopMicTest() : startMicTest());
$('#loopToggle').onchange = (e) => { loopAudio.srcObject = e.target.checked && testMic ? testMic.stream : null; loopAudio.play().catch(() => {}); };
$('#micSelect').onchange = () => { store.set('mic', $('#micSelect').value); if (testMic) { stopMicTest(); startMicTest(); } };
$('#nsToggle').onchange = () => setNoise($('#nsToggle').checked);
loadNoiseSuppressor().catch(() => {}); // adianta o download do modelo

function showJoinError(text) {
  const el = $('#joinError');
  el.textContent = text;
  el.hidden = !text;
}

/* ---------- favoritas ---------- */

const favs = () => store.get('favs', []);
const isFav = (name) => favs().some((f) => f.toLowerCase() === name.trim().toLowerCase());

function updateFavBtn() {
  const name = $('#roomInput').value.trim();
  const on = Boolean(name) && isFav(name);
  $('#favBtn').textContent = on ? '★' : '☆';
  $('#favBtn').classList.toggle('on', on);
}

$('#favBtn').onclick = () => {
  const name = $('#roomInput').value.trim();
  if (!name) { toast('Digite o nome da sala primeiro.'); return; }
  const list = favs();
  store.set('favs', isFav(name) ? list.filter((f) => f.toLowerCase() !== name.toLowerCase()) : [...list, name]);
  updateFavBtn();
  refreshFavs();
};
$('#roomInput').oninput = updateFavBtn;

async function refreshFavs() {
  const list = favs();
  $('#favCount').textContent = list.length;
  $('#favEmpty').hidden = list.length > 0;
  let status = [];
  if (list.length) {
    try {
      const qs = list.map((n) => `n=${encodeURIComponent(n)}`).join('&');
      const res = await fetch(`/api/rooms?${qs}`, { headers: { 'x-access-code': store.get('accessCode', '') } });
      if (res.ok) status = await res.json();
    } catch { /* offline */ }
  }
  const ul = $('#favList');
  ul.innerHTML = '';
  list.forEach((name, i) => {
    const s = status[i] || { online: 0, live: false, locked: false };
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'fav-name';
    nm.textContent = (s.locked ? '🔒 ' : '') + name;
    const st = document.createElement('span');
    st.className = `fav-status${s.live ? ' live' : ''}`;
    st.textContent = s.live ? `● AO VIVO · ${s.online}` : s.online ? `${s.online} online` : 'vazia';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'fav-remove';
    rm.title = 'Remover';
    rm.textContent = '×';
    rm.onclick = (e) => {
      e.stopPropagation();
      store.set('favs', favs().filter((f) => f !== name));
      updateFavBtn();
      refreshFavs();
    };
    li.append(nm, st, rm);
    li.onclick = () => { $('#roomInput').value = name; updateFavBtn(); $('#nameInput').focus(); };
    ul.append(li);
  });
}

updateFavBtn();
refreshFavs();
setInterval(() => { if (!$('#lobby').hidden) refreshFavs(); }, 5000);

/* ---------- entrar ---------- */

$('#joinForm').onsubmit = async (e) => {
  e.preventDefault();
  const room = $('#roomInput').value.trim();
  const name = $('#nameInput').value.trim();
  const password = $('#passInput').value;
  if (!room || !name) return;
  store.set('name', name);
  store.set('lastRoom', room);
  showJoinError('');
  stopMicTest();
  audioCtx(); // destrava o áudio com o gesto do usuário

  const btn = $('#joinBtn');
  btn.disabled = true;

  // Entra no mudo, sem nem abrir o microfone (o pessoal costuma usar o Discord).
  // O botão Microfone pede o acesso na primeira vez que for ligado.
  const accessCode = $('#codeInput').value;
  socket.timeout(8000).emit('join', { room, name, password, accessCode, micStreamId: null, muted: true }, (err, res) => {
    btn.disabled = false;
    if (err || !res?.ok) {
      showJoinError(err ? 'Servidor não respondeu. Tente de novo.' : res.error);
      if (res?.needCode) {
        $('#codeField').hidden = false;
        $('#codeInput').focus();
      }
      return;
    }
    if (accessCode) store.set('accessCode', accessCode);
    enterRoom(res, name);
  });
};

/* ================= sala ================= */

const qualitySelect = $('#qualitySelect');
for (const [key, q] of Object.entries(QUALITY)) qualitySelect.add(new Option(q.label, key));
qualitySelect.value = QUALITY[store.get('quality')] ? store.get('quality') : 'game1080';

function enterRoom(res, myName) {
  state.myId = res.id;
  state.myName = myName;
  state.roomName = res.room;
  $('#lobby').hidden = true;
  $('#room').hidden = false;
  $('#roomName').textContent = res.room;
  $('#lockIcon').hidden = !res.locked;
  history.replaceState(null, '', `?sala=${encodeURIComponent(res.room)}`);
  document.title = `${res.room} · Nosso Servidor`;

  // Definido antes de adicionar os pares: decide se a mídia vai pelo SFU ou P2P.
  // Sozinho na sala não conecta ao LiveKit (cada minuto lá conta no plano):
  // conecta quando chega a segunda pessoa (ver addPeer).
  state.sfuCfg = res.livekit || null;
  if (state.sfuCfg && res.peers.length) startSfu(state.sfuCfg);

  createTile(state.myId, `${myName} (você)`, true);
  if (state.mic) watchLevel(state.myId, state.mic, (lvl) => setSpeaking(state.myId, micOn() && lvl > SPEAK_THRESHOLD));
  res.peers.forEach((p) => addPeer(p, true));
  updateMicBtn();
  updateNoiseBtn();
  updateShareBtn();
  renderPeople();
  sysMsg(`Você entrou em "${res.room}".`);
}

function leaveRoom(reason) {
  if (!state.myId) return;
  socket.emit('leave');
  const sfu = state.sfu;
  state.sfu = null;
  state.sfuCfg = null;
  clearTimeout(state.sfuAloneTimer);
  sfu?.room?.disconnect();
  for (const peer of state.peers.values()) closePeer(peer);
  state.peers.clear();
  state.screen?.getTracks().forEach((t) => t.stop());
  closeMic(state.micChain);
  state.screen = null;
  state.mic = null;
  state.micChain = null;
  for (const key of [...state.meters.keys()]) unwatchLevel(key);
  state.speaking.clear();
  state.tiles.clear();
  state.focusId = null;
  $('#stage').innerHTML = '';
  $('#stage').classList.remove('has-focus');
  $('#chatLog').innerHTML = '';
  $('#peopleList').innerHTML = '';
  state.myId = null;
  $('#room').hidden = true;
  $('#lobby').hidden = false;
  document.title = 'Nosso Servidor — transmita sua tela para os amigos';
  refreshFavs();
  if (reason) toast(reason);
}

$('#leaveBtn').onclick = () => leaveRoom();

socket.on('disconnect', () => {
  if (state.myId) leaveRoom('Conexão com o servidor perdida.');
});

$('#copyLinkBtn').onclick = async () => {
  const url = `${location.origin}/?sala=${encodeURIComponent(state.roomName)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link de convite copiado!');
  } catch {
    prompt('Copie o link:', url);
  }
};

/* ---------- tiles ---------- */

function createTile(id, name, isSelf) {
  const el = $('#tileTpl').content.firstElementChild.cloneNode(true);
  const video = el.querySelector('video');
  el.classList.toggle('self', isSelf);
  el.querySelector('.avatar span').textContent = initial(name);
  el.querySelector('.avatar span').style.color = colorFor(id);
  el.querySelector('.tile-name').textContent = name;
  el.querySelector('.vol input').oninput = (e) => { video.volume = Number(e.target.value); };
  el.querySelector('.vol').onclick = (e) => e.stopPropagation();
  el.querySelector('.fs').onclick = (e) => { e.stopPropagation(); toggleFullscreen(el); };
  const statsEl = el.querySelector('.stats');
  el.querySelector('.st').onclick = (e) => {
    e.stopPropagation();
    statsEl.hidden = !statsEl.hidden;
    statsEl.textContent = 'Carregando…';
  };
  el.onclick = () => {
    if (video.muted && !isSelf) { video.muted = false; return; }
    setFocus(state.focusId === id ? null : id);
  };
  el.ondblclick = () => toggleFullscreen(el);
  // Em tela cheia, o nome e os controles somem com o mouse parado e voltam ao mexer.
  let idleTimer;
  const wake = () => {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    if (document.fullscreenElement === el) idleTimer = setTimeout(() => el.classList.add('idle'), FULLSCREEN_IDLE_MS);
  };
  el.addEventListener('mousemove', wake);
  $('#stage').append(el);
  state.tiles.set(id, { el, video, statsEl, wake });
  updateCount();
}

function removeTile(id) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  tile.video.srcObject = null;
  tile.el.remove();
  state.tiles.delete(id);
  if (state.focusId === id) setFocus(null);
  updateCount();
}

function setTileVideo(id, stream, isSelf) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  const { el, video } = tile;
  if (stream) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.muted = isSelf;
      video.play().catch(() => {
        // Autoplay com som bloqueado: toca mudo e pede um clique.
        video.muted = true;
        video.play().catch(() => {});
        toast('Clique na transmissão para ativar o som.');
      });
    }
    el.classList.add('has-video');
    if (!state.focusId && !isSelf) setFocus(id);
  } else {
    video.srcObject = null;
    el.classList.remove('has-video');
    if (state.focusId === id) setFocus(null);
  }
}

function setFocus(id) {
  if (state.focusId) state.tiles.get(state.focusId)?.el.classList.remove('focused');
  state.focusId = id && state.tiles.has(id) ? id : null;
  if (state.focusId) state.tiles.get(state.focusId).el.classList.add('focused');
  $('#stage').classList.toggle('has-focus', Boolean(state.focusId));
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

const FULLSCREEN_IDLE_MS = 2000;

// Entrou ou saiu da tela cheia (inclusive pelo Esc): recomeça a contagem ou mostra tudo de novo.
document.addEventListener('fullscreenchange', () => {
  for (const tile of state.tiles.values()) tile.wake();
});

function updateCount() {
  const n = state.tiles.size;
  $('#peerCount').textContent = `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;
}

/* ---------- participantes ---------- */

function renderPeople() {
  const ul = $('#peopleList');
  ul.innerHTML = '';
  const me = { id: state.myId, name: `${state.myName} (você)`, muted: !micOn(), sharing: Boolean(state.screen), self: true };
  [me, ...state.peers.values()].forEach((p) => {
    const li = document.createElement('li');
    li.dataset.id = p.id;
    li.classList.toggle('speaking', Boolean(state.speaking.get(p.id)));
    const av = document.createElement('span');
    av.className = 'av';
    av.textContent = initial(p.name);
    av.style.color = colorFor(p.id);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    const tags = document.createElement('span');
    tags.className = 'tags';
    if (p.sharing) tags.insertAdjacentHTML('beforeend', '<span class="tag-live">AO VIVO</span>');
    if (p.muted || (!p.self && !p.micStreamId)) tags.insertAdjacentHTML('beforeend', '<span title="Microfone desligado">🔇</span>');
    li.append(av, nm, tags);
    if (!p.self) {
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = 0; vol.max = 1; vol.step = 0.05;
      vol.value = p.voiceVolume;
      vol.title = 'Volume da voz';
      vol.oninput = () => { p.voiceVolume = Number(vol.value); p.voiceAudio.volume = p.voiceVolume; };
      li.append(vol);
    }
    ul.append(li);
  });
  state.tiles.get(state.myId)?.el.querySelector('.tile-name').classList.toggle('muted', !micOn());
  for (const p of state.peers.values()) {
    state.tiles.get(p.id)?.el.querySelector('.tile-name').classList.toggle('muted', p.muted || !p.micStreamId);
  }
}

/* ---------- WebRTC (perfect negotiation, malha P2P) ---------- */

// Força Opus estéreo e bitrate maior: o som do jogo chega em estéreo.
function preferStereo(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, fmtp) =>
    (fmtp.includes('stereo=1') ? line : `a=fmtp:${pt} ${fmtp};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`));
}

// Enquanto transmito, faz o Chrome já começar perto do bitrate alvo em vez de
// subir aos poucos a partir de ~300 kbps (que começava em 480×270).
function tuneVideoBitrate(sdp) {
  if (!state.screen || !state.quality) return sdp;
  const params = `x-google-start-bitrate=${Math.round(state.quality.bitrate * 0.6 / 1000)}`;
  const lines = sdp.split('\r\n');
  const pts = new Set();
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    const m = inVideo && line.match(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//);
    if (m) pts.add(m[1]);
  }
  const hasFmtp = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m || !pts.has(m[1])) return line;
    hasFmtp.add(m[1]);
    return m[2].includes('x-google-start-bitrate') ? line : `${line};${params}`;
  });
  // VP8 normalmente não tem linha fmtp: cria uma logo após o rtpmap.
  return out.flatMap((line) => {
    const m = line.match(/^a=rtpmap:(\d+) /);
    return m && pts.has(m[1]) && !hasFmtp.has(m[1]) ? [line, `a=fmtp:${m[1]} ${params}`] : [line];
  }).join('\r\n');
}

function preferCodec(transceiver) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs;
  const mime = CODECS[codecSelect.value]?.mime;
  if (!caps || !mime || !transceiver.setCodecPreferences) return;
  const wanted = caps.filter((c) => c.mimeType === mime);
  if (!wanted.length) return;
  // H.264: perfis com packetization-mode=1 primeiro (os que o hardware usa).
  wanted.sort((a, b) => Number(/packetization-mode=1/.test(b.sdpFmtpLine || '')) - Number(/packetization-mode=1/.test(a.sdpFmtpLine || '')));
  try {
    transceiver.setCodecPreferences([...wanted, ...caps.filter((c) => c.mimeType !== mime)]);
  } catch (err) {
    console.warn('codec', err);
  }
}

// initiator: true para quem acabou de entrar (conecta com quem já estava na sala).
function addPeer(info, initiator = false) {
  if (state.peers.has(info.id)) return;
  const peer = {
    id: info.id,
    name: info.name,
    sharing: Boolean(info.sharing),
    muted: Boolean(info.muted),
    screenStreamId: info.screenStreamId || null,
    micStreamId: info.micStreamId || null,
    pc: null,
    polite: state.myId > info.id,
    makingOffer: false,
    ignoreOffer: false,
    signalChain: Promise.resolve(),
    pendingCandidates: [],
    awaitingFirstOffer: false,
    streams: new Map(),
    screenSenders: [],
    voiceAudio: new Audio(),
    voiceVolume: 1,
    sfuMic: null,       // MediaStream da voz recebida pelo SFU
    sfuScreen: null,    // MediaStream da tela (vídeo + áudio) recebida pelo SFU
    sfuScreenTrack: null,
  };
  peer.voiceAudio.autoplay = true;
  state.peers.set(peer.id, peer);
  createTile(peer.id, peer.name, false);
  renderPeople();

  if (state.sfuCfg) {
    clearTimeout(state.sfuAloneTimer);
    if (!state.sfu) startSfu(state.sfuCfg);
    sfuSyncPeer(peer);
  } else {
    connectP2P(peer, initiator);
  }
}

// Ficou sozinho numa sala do LiveKit: sai de lá depois de um minuto (se ninguém voltar).
const SFU_ALONE_MS = 60_000;
function sfuMaybeAlone() {
  if (!state.sfu || state.peers.size) return;
  clearTimeout(state.sfuAloneTimer);
  state.sfuAloneTimer = setTimeout(() => {
    if (!state.sfu || state.peers.size) return;
    const sfu = state.sfu;
    state.sfu = null; // antes do disconnect: não é queda de conexão, não sai da sala
    sfu.room?.disconnect(false); // false: não para o microfone nem a tela (seguem em uso)
  }, SFU_ALONE_MS);
}

function connectP2P(peer, initiator) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  peer.pc = pc;

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: peer.id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error('negociação', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peer.id, data: { candidate } });
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce();
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0];
    if (!stream) return;
    peer.streams.set(stream.id, stream);
    stream.onremovetrack = () => updatePeerMedia(peer);
    track.onunmute = () => updatePeerMedia(peer);
    updatePeerMedia(peer);
  };

  // Só um lado abre a negociação: quem acabou de entrar. Se os dois mandassem oferta
  // juntos, o lado "polite" faria rollback, e o Chrome às vezes deixa a coleta de ICE
  // parada depois disso (conexão presa em "new" e o espectador sem vídeo).
  if (initiator) {
    pc.createDataChannel('na-tela'); // garante a oferta mesmo sem microfone nem tela
    addLocalMedia(peer);
  } else {
    peer.awaitingFirstOffer = true; // manda as faixas depois de responder a primeira oferta
  }
}

function addLocalMedia(peer) {
  state.mic?.getTracks().forEach((t) => peer.pc.addTrack(t, state.mic));
  if (state.screen) addScreenTo(peer);
}

// Pares que já podem receber faixas novas (os outros recebem tudo no addLocalMedia).
const readyP2PPeers = () => [...state.peers.values()].filter((p) => p.pc && !p.awaitingFirstOffer);

function closePeer(peer) {
  peer.pc?.close();
  peer.voiceAudio.srcObject = null;
  unwatchLevel(peer.id);
  state.speaking.delete(peer.id);
  removeTile(peer.id);
}

function updatePeerMedia(peer) {
  const mic = state.sfu ? peer.sfuMic : peer.micStreamId && peer.streams.get(peer.micStreamId);
  if (mic && peer.voiceAudio.srcObject !== mic) {
    peer.voiceAudio.srcObject = mic;
    peer.voiceAudio.volume = peer.voiceVolume;
    peer.voiceAudio.play().catch(() => {});
    watchLevel(peer.id, mic, (lvl) => setSpeaking(peer.id, !peer.muted && lvl > SPEAK_THRESHOLD));
  }
  const screen = peer.sharing && (state.sfu ? peer.sfuScreen : peer.screenStreamId && peer.streams.get(peer.screenStreamId));
  const hasVideo = screen && screen.getVideoTracks().some((t) => t.readyState === 'live');
  setTileVideo(peer.id, hasVideo ? screen : null, false);
}

socket.on('signal', ({ from, data }) => {
  const peer = state.peers.get(from);
  if (!peer?.pc) return;
  // Uma mensagem por vez, na ordem de chegada: sem isso um candidato podia ser
  // aplicado no meio de um setRemoteDescription ainda em andamento.
  peer.signalChain = peer.signalChain
    .then(() => handleSignal(peer, data))
    .catch((err) => console.error('sinalização', err));
});

async function handleSignal(peer, data) {
  const { pc } = peer;
  if (pc.signalingState === 'closed') return;
  if (data.description) {
    const desc = { type: data.description.type, sdp: tuneVideoBitrate(preferStereo(data.description.sdp)) };
    const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(desc);
    await flushCandidates(peer);
    if (desc.type === 'offer') {
      await pc.setLocalDescription();
      socket.emit('signal', { to: peer.id, data: { description: pc.localDescription } });
      if (peer.awaitingFirstOffer) {
        peer.awaitingFirstOffer = false;
        addLocalMedia(peer); // dispara uma renegociação, agora sem colisão
      }
    }
  } else if (data.candidate) {
    // Na colisão de ofertas ao entrar, os candidatos do outro lado chegam antes de
    // haver descrição remota. Antes eles falhavam e se perdiam (a conexão ficava em
    // ICE "new" e o espectador sem vídeo); agora esperam o próximo setRemoteDescription.
    if (!pc.remoteDescription || peer.ignoreOffer) {
      peer.pendingCandidates.push(data.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) throw err;
    }
  }
}

async function flushCandidates(peer) {
  for (const candidate of peer.pendingCandidates.splice(0)) {
    await peer.pc.addIceCandidate(candidate).catch(() => {});
  }
}

socket.on('peer-joined', (info) => {
  if (!state.myId) return;
  addPeer(info);
  sysMsg(`${info.name} entrou.`);
});

socket.on('peer-left', ({ id }) => {
  const peer = state.peers.get(id);
  if (!peer) return;
  closePeer(peer);
  state.peers.delete(id);
  renderPeople();
  sysMsg(`${peer.name} saiu.`);
  sfuMaybeAlone();
});

socket.on('notice', (text) => toast(text));
socket.on('connect_error', (err) => {
  if (!$('#lobby').hidden) showJoinError(err.message || 'Sem conexão com o servidor.');
});
socket.on('connect', () => { if ($('#joinError').textContent.startsWith('Muitas') || $('#joinError').textContent.startsWith('Servidor cheio')) showJoinError(''); });

socket.on('peer-state', ({ id, ...patch }) => {
  const peer = state.peers.get(id);
  if (!peer) return;
  const wasSharing = peer.sharing;
  Object.assign(peer, patch);
  updatePeerMedia(peer);
  renderPeople();
  if (peer.sharing && !wasSharing) sysMsg(`${peer.name} começou a transmitir.`);
  if (!peer.sharing && wasSharing) sysMsg(`${peer.name} parou de transmitir.`);
});

/* ---------- SFU (LiveKit) ---------- */
// Com o SFU, cada pessoa envia um único fluxo ao servidor, que repassa para os outros.
// A tela vai em simulcast (várias resoluções); o servidor escolhe a camada que cabe
// na conexão de cada espectador e pausa as que ninguém está usando (dynacast).

let lkLoading = null;
function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  lkLoading ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = '/vendor/livekit-client.js';
    el.onload = () => resolve(window.LivekitClient);
    el.onerror = () => { lkLoading = null; reject(new Error('livekit-client não carregou')); };
    document.head.append(el);
  });
  return lkLoading;
}

// O livekit-client monta o SDP por conta própria, então o "começar nítido" do P2P
// (x-google-start-bitrate na resposta remota) é aplicado aqui por fora. No LiveKit só a
// conexão de envio recebe respostas ("answer"); a de recebimento recebe ofertas.
// Sem isso o Chrome começava a ~400 kbps: 720p só aos ~25 s e 1080p aos ~40 s.
function patchSfuStartBitrate() {
  const proto = RTCPeerConnection.prototype;
  if (proto.naTelaPatched) return;
  const original = proto.setRemoteDescription;
  proto.setRemoteDescription = function setRemoteDescription(desc, ...rest) {
    if (state.sfu && desc?.type === 'answer' && desc.sdp) desc = { type: desc.type, sdp: tuneVideoBitrate(desc.sdp) };
    return original.call(this, desc, ...rest);
  };
  proto.naTelaPatched = true;
}

function startSfu({ url, token }) {
  patchSfuStartBitrate();
  const sfu = { LK: null, room: null, connected: false, micPub: null, screenPubs: [], ready: null };
  state.sfu = sfu;
  sfu.ready = (async () => {
    const LK = await loadLiveKit();
    if (state.sfu !== sfu) return;
    const room = new LK.Room({ adaptiveStream: false, dynacast: true, stopLocalTrackOnUnpublish: false });
    const sync = (_track, _pub, participant) => {
      const peer = state.peers.get(participant.identity);
      if (peer) sfuSyncPeer(peer);
    };
    room
      .on(LK.RoomEvent.TrackSubscribed, sync)
      .on(LK.RoomEvent.TrackUnsubscribed, sync)
      .on(LK.RoomEvent.Reconnecting, () => toast('Reconectando ao servidor de vídeo…'))
      .on(LK.RoomEvent.Reconnected, () => toast('Reconectado.'))
      .on(LK.RoomEvent.Disconnected, () => {
        // Falha no connect inicial é tratada no catch abaixo.
        if (state.sfu === sfu && sfu.connected) leaveRoom('Conexão com o servidor de vídeo perdida.');
      });
    sfu.LK = LK;
    sfu.room = room; // antes do connect, para o leaveRoom conseguir cancelar
    await room.connect(url, token);
    if (state.sfu !== sfu) return;
    sfu.connected = true;
    for (const peer of state.peers.values()) sfuSyncPeer(peer);
  })();
  sfu.ready.catch((err) => {
    if (state.sfu !== sfu) return;
    console.error('livekit', err);
    leaveRoom('Não foi possível conectar ao servidor de vídeo.');
  });
  if (state.mic) sfuPublishMic();
  // Começou a transmitir sozinho e agora chegou alguém: publica a tela também.
  if (state.screen) sfuPublishScreen().catch((err) => console.error('publicar tela', err));
}

// Monta os MediaStreams de um par a partir das faixas que o SFU entregou.
function sfuSyncPeer(peer) {
  const sfu = state.sfu;
  const participant = sfu?.room?.remoteParticipants.get(peer.id);
  let mic = null;
  let video = null;
  const screenTracks = [];
  for (const pub of participant?.trackPublications.values() ?? []) {
    const t = pub.track;
    if (!t || !pub.isSubscribed) continue;
    if (pub.source === sfu.LK.Track.Source.Microphone) mic = t.mediaStreamTrack;
    else if (pub.source === sfu.LK.Track.Source.ScreenShare) { video = t; screenTracks.push(t.mediaStreamTrack); }
    else if (pub.source === sfu.LK.Track.Source.ScreenShareAudio) screenTracks.push(t.mediaStreamTrack);
  }
  if (peer.sfuMic?.getAudioTracks()[0] !== mic) peer.sfuMic = mic ? new MediaStream([mic]) : null;
  // Stream novo sempre que as faixas mudam: o <video> recomeça direito.
  const current = peer.sfuScreen?.getTracks() ?? [];
  const changed = current.length !== screenTracks.length || screenTracks.some((t) => !current.includes(t));
  if (changed) peer.sfuScreen = screenTracks.length ? new MediaStream(screenTracks) : null;
  peer.sfuScreenTrack = video;
  updatePeerMedia(peer);
}

async function sfuPublishMic() {
  const sfu = state.sfu;
  const track = state.mic?.getAudioTracks()[0];
  if (!sfu || !track) return;
  try {
    await sfu.ready;
    if (state.sfu !== sfu || state.mic?.getAudioTracks()[0] !== track || sfu.micPub) return;
    sfu.micPub = await sfu.room.localParticipant.publishTrack(track, {
      source: sfu.LK.Track.Source.Microphone,
      // O livekit-client liga o DTX por padrão: o Opus para de enviar quando acha que é
      // silêncio. Com a supressão de ruído o fundo fica mudo e ele cortava começo e fim
      // das palavras (a voz "picotava"). O RED continua: cobre pacotes perdidos.
      dtx: false,
      red: true,
      audioPreset: { maxBitrate: 64_000 },
    });
  } catch (err) {
    if (state.sfu !== sfu) return; // saiu da sala ou a conexão falhou (já avisado)
    console.error('publicar microfone', err);
    toast('Falha ao enviar o microfone.');
  }
}

// Camadas abaixo da principal (a principal é a própria qualidade escolhida).
function sfuLayers(LK, q) {
  const low = new LK.VideoPreset(640, 360, 600_000, Math.min(q.fps, 30));
  if (q.height < 1080) return [low];
  return [low, new LK.VideoPreset(1280, 720, Math.round(q.bitrate * 0.4), q.fps)];
}

async function sfuPublishScreen() {
  const sfu = state.sfu;
  const stream = state.screen;
  if (!sfu || !stream) return;
  await sfu.ready;
  if (state.sfu !== sfu || state.screen !== stream) return;
  const { LK } = sfu;
  const q = state.quality;
  const lp = sfu.room.localParticipant;
  const pubs = [];
  sfu.screenPubs = pubs;
  const video = stream.getVideoTracks()[0];
  if (video) {
    pubs.push(await lp.publishTrack(video, {
      source: LK.Track.Source.ScreenShare,
      videoCodec: codecSelect.value,
      simulcast: true,
      screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high' },
      screenShareSimulcastLayers: sfuLayers(LK, q),
      degradationPreference: q.degradation,
    }));
  }
  for (const track of stream.getAudioTracks()) {
    pubs.push(await lp.publishTrack(track, {
      source: LK.Track.Source.ScreenShareAudio,
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: { maxBitrate: 192_000 },
    }));
  }
  // Parou de transmitir (ou trocou a qualidade) enquanto publicava.
  if (state.screen !== stream || sfu.screenPubs !== pubs) await unpublishAll(sfu, pubs);
}

async function sfuUnpublishScreen() {
  const sfu = state.sfu;
  if (!sfu?.room) return;
  const pubs = sfu.screenPubs;
  sfu.screenPubs = [];
  await unpublishAll(sfu, pubs);
}

function unpublishAll(sfu, pubs) {
  return Promise.all(pubs.map((p) => p.track && sfu.room.localParticipant.unpublishTrack(p.track, false).catch(() => {})));
}

/* ---------- microfone ---------- */

const micOn = () => Boolean(state.mic?.getAudioTracks()[0]?.enabled);

async function toggleMic() {
  if (!state.mic) {
    try {
      state.micChain = await openMic();
    } catch {
      toast('Microfone indisponível. Verifique a permissão do navegador.');
      return;
    }
    if (!state.myId) { closeMic(state.micChain); state.micChain = null; return; } // saiu enquanto abria
    state.mic = state.micChain.stream;
    // Avisa o id do stream antes de mandar as faixas, para os outros reconhecerem.
    socket.emit('state', { micStreamId: state.mic.id, muted: false });
    if (state.sfu) sfuPublishMic();
    else for (const peer of readyP2PPeers()) state.mic.getTracks().forEach((t) => peer.pc.addTrack(t, state.mic));
    watchLevel(state.myId, state.mic, (lvl) => setSpeaking(state.myId, micOn() && lvl > SPEAK_THRESHOLD));
  } else {
    const track = state.mic.getAudioTracks()[0];
    const lkTrack = state.sfu?.micPub?.track;
    // Pelo SFU, o mute avisa o servidor (para de encaminhar); na malha só zera o áudio.
    if (lkTrack) await (track.enabled ? lkTrack.mute() : lkTrack.unmute());
    else track.enabled = !track.enabled;
    socket.emit('state', { muted: !track.enabled });
  }
  updateMicBtn();
  renderPeople();
}

function updateMicBtn() {
  const on = micOn();
  $('#micBtn').classList.toggle('off', !on);
  $('#micBtn span').textContent = on ? 'Microfone' : 'Mudo';
}

$('#micBtn').onclick = toggleMic;
$('#nsBtn').onclick = () => {
  setNoise(!noiseOn());
  toast(noiseOn() ? 'Supressão de ruído ligada.' : 'Supressão de ruído desligada.');
};

document.addEventListener('keydown', (e) => {
  if ($('#room').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key.toLowerCase() === 'm') toggleMic();
});

/* ---------- compartilhar tela ---------- */

function addScreenTo(peer) {
  const stream = state.screen;
  const q = state.quality;
  peer.screenSenders = stream.getTracks().map((track) => {
    if (track.kind === 'video') {
      const transceiver = peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{ maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high', networkPriority: 'high' }],
      });
      preferCodec(transceiver);
      applySenderParams(transceiver.sender, q);
      return transceiver.sender;
    }
    return peer.pc.addTrack(track, stream);
  });
}

async function startShare() {
  const q = QUALITY[qualitySelect.value];
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Não foi possível capturar a tela.');
    return;
  }
  if (!state.myId) { stream.getTracks().forEach((t) => t.stop()); return; }

  const video = stream.getVideoTracks()[0];
  video.contentHint = q.hint;
  video.onended = stopShare;
  stream.getAudioTracks().forEach((t) => { t.contentHint = 'music'; });

  state.screen = stream;
  state.quality = q;
  socket.emit('state', { sharing: true, screenStreamId: stream.id });
  if (state.sfu) sfuPublishScreen().catch((err) => { console.error('publicar tela', err); toast('Falha ao transmitir pelo servidor.'); stopShare(); });
  else for (const peer of readyP2PPeers()) addScreenTo(peer);
  setTileVideo(state.myId, stream, true);
  updateShareBtn();
  renderPeople();
  if (!stream.getAudioTracks().length) toast('Transmitindo sem áudio. Para enviar o som, marque "Compartilhar áudio" ao escolher a tela/aba.');
}

function stopShare() {
  if (!state.screen) return;
  if (state.sfu) sfuUnpublishScreen();
  state.screen.getTracks().forEach((t) => t.stop());
  for (const peer of state.peers.values()) {
    peer.screenSenders.forEach((sender) => { try { peer.pc.removeTrack(sender); } catch { /* conexão fechada */ } });
    peer.screenSenders = [];
  }
  state.screen = null;
  socket.emit('state', { sharing: false, screenStreamId: null });
  setTileVideo(state.myId, null, true);
  updateShareBtn();
  renderPeople();
}

function updateShareBtn() {
  const on = Boolean(state.screen);
  $('#shareBtn').classList.toggle('sharing', on);
  $('#shareBtn span').textContent = on ? 'Parar transmissão' : 'Transmitir tela';
}

$('#shareBtn').onclick = () => (state.screen ? stopShare() : startShare());

// Troca de qualidade durante a transmissão, sem reiniciar.
qualitySelect.onchange = async () => {
  store.set('quality', qualitySelect.value);
  if (!state.screen) return;
  const q = QUALITY[qualitySelect.value];
  state.quality = q;
  const video = state.screen.getVideoTracks()[0];
  video.contentHint = q.hint;
  await video.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
  if (state.sfu) {
    // As camadas do simulcast dependem da qualidade: republica (a imagem pisca por um instante).
    await sfuUnpublishScreen();
    await sfuPublishScreen().catch((err) => console.error('republicar tela', err));
  }
  for (const peer of state.peers.values()) {
    for (const sender of peer.screenSenders) {
      if (sender.track?.kind === 'video') await applySenderParams(sender, q);
    }
  }
  toast(`Qualidade: ${q.label}`);
};

async function applySenderParams(sender, q) {
  const p = sender.getParameters();
  if (!p.encodings?.length) return;
  p.encodings[0].maxBitrate = q.bitrate;
  p.encodings[0].maxFramerate = q.fps;
  p.degradationPreference = q.degradation;
  await sender.setParameters(p).catch(() => {
    // Navegadores sem degradationPreference: aplica só o resto.
    delete p.degradationPreference;
    return sender.setParameters(p).catch(() => {});
  });
}

const codecSelect = $('#codecSelect');
for (const [key, c] of Object.entries(CODECS)) {
  const supported = RTCRtpSender.getCapabilities?.('video')?.codecs.some((x) => x.mimeType === c.mime);
  if (supported !== false) codecSelect.add(new Option(c.label, key));
}
codecSelect.value = CODECS[store.get('codec')] ? store.get('codec') : 'h264';
if (!codecSelect.value) codecSelect.selectedIndex = 0;
codecSelect.onchange = async () => {
  store.set('codec', codecSelect.value);
  if (!state.screen) return;
  if (state.sfu) {
    await sfuUnpublishScreen();
    await sfuPublishScreen().catch((err) => console.error('republicar tela', err));
    toast(`Codec: ${CODECS[codecSelect.value].label}`);
  } else {
    toast('O codec novo vale a partir da próxima transmissão.');
  }
};

/* ---------- estatísticas ---------- */

const statsPrev = new Map();

function kbpsSince(key, bytes, ts) {
  const prev = statsPrev.get(key);
  statsPrev.set(key, { bytes, ts });
  // Bytes menores que antes: o fluxo foi trocado (republicou a tela); recomeça a conta.
  return prev && ts > prev.ts && bytes >= prev.bytes ? ((bytes - prev.bytes) * 8) / (ts - prev.ts) : 0;
}

const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);
const LIMIT = { none: 'nenhum', cpu: 'CPU', bandwidth: 'rede', other: 'outro' };

async function inboundStats(peer) {
  const track = state.sfu ? peer.sfuScreenTrack?.mediaStreamTrack : peer.streams.get(peer.screenStreamId)?.getVideoTracks()[0];
  if (!track) return ['Aguardando vídeo…'];
  const st = state.sfu ? await peer.sfuScreenTrack.getRTCStatsReport() : await peer.pc.getStats();
  if (!st) return ['Aguardando vídeo…'];
  let video;
  let pair;
  st.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video' && s.trackIdentifier === track.id) video = s;
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  if (!video) return ['Aguardando vídeo…'];
  const codec = st.get(video.codecId)?.mimeType?.split('/')[1] || '?';
  const kbps = kbpsSince(`in:${peer.id}:${video.id}`, video.bytesReceived, video.timestamp);
  const total = (video.packetsLost || 0) + (video.packetsReceived || 0);
  const loss = total ? ((video.packetsLost || 0) / total) * 100 : 0;
  const relay = pair && st.get(pair.localCandidateId)?.candidateType === 'relay';
  return [
    `${video.frameWidth || 0}×${video.frameHeight || 0} @ ${Math.round(video.framesPerSecond || 0)} fps`,
    `${codec} · ${fmtRate(kbps)}`,
    `perda ${loss.toFixed(1)}% · travadas ${video.freezeCount || 0}`,
    `ping ${pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : '?'} ms${relay ? ' · via TURN' : ''}`,
  ];
}

async function outboundStats() {
  if (state.sfu) return sfuOutboundStats();
  const lines = [];
  let upload = 0;
  for (const peer of state.peers.values()) {
    const sender = peer.screenSenders.find((s) => s.track?.kind === 'video');
    if (!sender) continue;
    const st = await sender.getStats();
    st.forEach((s) => {
      if (s.type !== 'outbound-rtp') return;
      const kbps = kbpsSince(`out:${peer.id}`, s.bytesSent, s.timestamp);
      upload += kbps;
      const codec = st.get(s.codecId)?.mimeType?.split('/')[1] || '?';
      const hw = s.powerEfficientEncoder === true ? ' GPU' : s.powerEfficientEncoder === false ? ' CPU' : '';
      lines.push(`${peer.name}: ${s.frameWidth || 0}×${s.frameHeight || 0} @ ${Math.round(s.framesPerSecond || 0)} · ${fmtRate(kbps)} · ${codec}${hw} · limite: ${LIMIT[s.qualityLimitationReason] || '?'}`);
    });
  }
  if (!lines.length) return ['Ninguém assistindo ainda.'];
  return [`Upload total: ${fmtRate(upload)} (${lines.length} ${lines.length === 1 ? 'espectador' : 'espectadores'})`, ...lines];
}

const LAYER = { f: 'alta', h: 'média', q: 'baixa' };

async function sfuOutboundStats() {
  const pub = state.sfu.screenPubs.find((p) => p.kind === 'video');
  const st = await pub?.track?.getRTCStatsReport();
  if (!st) return ['Preparando transmissão…'];
  const layers = [];
  st.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') layers.push(s); });
  layers.sort((a, b) => (b.frameHeight || 0) - (a.frameHeight || 0));
  let upload = 0;
  const lines = layers.map((s) => {
    const name = LAYER[s.rid] || s.rid || 'única';
    const kbps = kbpsSince(`out:${s.id}`, s.bytesSent, s.timestamp);
    if (s.active === false) return `${name}: pausada (ninguém precisa dela)`;
    upload += kbps;
    const codec = st.get(s.codecId)?.mimeType?.split('/')[1] || '?';
    const hw = s.powerEfficientEncoder === true ? ' GPU' : s.powerEfficientEncoder === false ? ' CPU' : '';
    return `${name}: ${s.frameWidth || 0}×${s.frameHeight || 0} @ ${Math.round(s.framesPerSecond || 0)} · ${fmtRate(kbps)} · ${codec}${hw} · limite: ${LIMIT[s.qualityLimitationReason] || '?'}`;
  });
  const n = state.peers.size;
  return [`Upload para o servidor: ${fmtRate(upload)} (${n} ${n === 1 ? 'espectador' : 'espectadores'}, envio único)`, ...lines];
}

setInterval(async () => {
  for (const [id, tile] of state.tiles) {
    if (!tile.statsEl || tile.statsEl.hidden) continue;
    try {
      const lines = id === state.myId ? await outboundStats() : await inboundStats(state.peers.get(id));
      tile.statsEl.textContent = lines.join('\n');
    } catch {
      tile.statsEl.textContent = 'Sem estatísticas.';
    }
  }
}, 1000);

/* ---------- chat ---------- */

const isMobile = () => matchMedia('(max-width: 860px)').matches;
const chatVisible = () => (isMobile() ? $('#room').classList.contains('side-open') : !$('#room').classList.contains('side-hidden'));

$('#sideBtn').onclick = () => {
  $('#room').classList.toggle(isMobile() ? 'side-open' : 'side-hidden');
  if (chatVisible()) { $('#unread').hidden = true; $('#chatInput').focus(); }
};

$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('#chatInput').value = '';
};

function appendLog(el) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

socket.on('chat', ({ id, name, text }) => {
  const div = document.createElement('div');
  div.className = 'msg';
  const b = document.createElement('b');
  b.textContent = id === state.myId ? 'Você' : name;
  b.style.color = colorFor(id);
  const span = document.createElement('span');
  span.textContent = text;
  div.append(b, span);
  appendLog(div);
  if (!chatVisible() && id !== state.myId) $('#unread').hidden = false;
});

function sysMsg(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  appendLog(div);
}
