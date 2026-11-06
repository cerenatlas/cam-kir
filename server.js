const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
let Conn = null;
try { Conn = require('tiktok-live-connector').WebcastPushConnection; } catch { console.warn('tiktok-live-connector yüklü değil: "npm install" çalıştır.'); }

const PORT = +process.env.PORT || 3000, PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('ADMIN_PASSWORD tanımlı değil. .env dosyasına yaz.'); process.exit(1); }

// ---------- Kalıcı veri ----------
const FILE = path.join(__dirname, 'data.json');
const DEF = {
  config: {
    username: '', maxHp: 3000, running: true, fallbackMultiplier: 1,
    effects: { shake: true, particles: true, flash: true },
    gifts: { rose: 10, heart: 50, tiktok: 100, crown: 300, 'gift box': 1000 }
  },
  scores: {}, hp: 3000, breaks: 0
};
let db = structuredClone(DEF);
try {
  const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db = { ...db, ...s, config: { ...DEF.config, ...s.config, effects: { ...DEF.config.effects, ...(s.config || {}).effects } } };
} catch {}
if (process.env.TIKTOK_USERNAME && !db.config.username) db.config.username = process.env.TIKTOK_USERNAME;
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { const t = FILE + '.tmp'; fs.writeFile(t, JSON.stringify(db), e => { if (!e) fs.rename(t, FILE, () => {}); }); }, 400);
}

// ---------- Yayın (WebSocket) ----------
const app = express(), server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const bc = o => { const m = JSON.stringify(o); wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(m)); };
const top = (n = 10) => Object.entries(db.scores).map(([id, s]) => ({ id, ...s })).sort((a, b) => b.points - a.points).slice(0, n);
const pub = () => ({ type: 'state', hp: db.hp, maxHp: db.config.maxHp, running: db.config.running, effects: db.config.effects, top: top() });
wss.on('connection', ws => ws.send(JSON.stringify(pub())));

// ---------- Oyun mantığı ----------
const pf = (name, dia) => {
  const v = db.config.gifts[(name || '').toLowerCase()];
  return v != null ? v : Math.round((dia || 1) * db.config.fallbackMultiplier);
};
function handle(g) {
  if (!db.config.running) return;
  const points = pf(g.giftName, g.diamonds) * g.count;
  if (!(points > 0)) return;
  const s = db.scores[g.id] || (db.scores[g.id] = { name: g.name, avatar: g.avatar || '', points: 0 });
  s.name = g.name || s.name; if (g.avatar) s.avatar = g.avatar;
  s.points += points;
  db.hp -= points;
  const broke = db.hp <= 0;
  bc({
    type: 'hit', name: s.name, avatar: s.avatar, giftName: g.giftName, giftImg: g.giftImg || '',
    count: g.count, points, power: Math.min(1, points / 1000), hp: Math.max(0, db.hp), maxHp: db.config.maxHp,
    broke, winner: broke ? { name: s.name, avatar: s.avatar } : null
  });
  if (broke) { db.breaks++; db.hp = db.config.maxHp; }
  bc({ type: 'top', top: top() });
  save();
}

// ---------- TikTok bağlantısı ----------
const streaks = new Map(), seen = new Set();
setInterval(() => { const n = Date.now(); for (const [k, v] of streaks) if (n - v.t > 120000) streaks.delete(k); }, 30000);

function onGift(d) {
  if (d.msgId) { if (seen.has(d.msgId)) return; seen.add(d.msgId); if (seen.size > 5000) seen.delete(seen.values().next().value); }
  let count;
  if (d.giftType === 1) {                       // seri (streak) hediyesi
    const key = `${d.userId}:${d.giftId}:${d.groupId || 'g'}`;
    const prev = streaks.get(key) || { n: 0 };
    count = (d.repeatCount || 1) - prev.n;      // sadece yeni eklenen kısım puanlanır
    if (d.repeatEnd) streaks.delete(key); else streaks.set(key, { n: Math.max(prev.n, d.repeatCount || 1), t: Date.now() });
    if (count <= 0) return;                     // seri bitiş mesajı = çift puan yok
  } else count = d.repeatCount || 1;
  handle({
    id: String(d.uniqueId || d.userId), name: d.nickname || d.uniqueId, avatar: d.profilePictureUrl,
    giftName: d.giftName, giftImg: d.giftPictureUrl, diamonds: d.diamondCount, count
  });
}

let conn = null, status = 'bekliyor', retry = 0, retryT;
function connect() {
  clearTimeout(retryT);
  if (conn) { const o = conn; conn = null; try { o.disconnect(); } catch {} }
  const u = (db.config.username || '').replace(/^@/, '').trim();
  if (!u) { status = 'kullanıcı adı yok'; return; }
  if (!Conn) { status = 'kütüphane yüklü değil'; return; }
  status = 'bağlanıyor'; const c = conn = new Conn(u);
  const again = () => { if (c !== conn) return; clearTimeout(retryT); retryT = setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++)); };
  c.connect().then(() => { if (c === conn) { status = 'bağlı'; retry = 0; } })
    .catch(e => { if (c === conn) { status = 'hata: ' + (e.message || e); again(); } });
  c.on('gift', d => c === conn && onGift(d));
  c.on('disconnected', () => { if (c === conn) { status = 'koptu, yeniden deneniyor'; again(); } });
  c.on('streamEnd', () => { if (c === conn) status = 'yayın bitti'; });
  c.on('error', e => console.warn('TikTok hata:', e && e.message));
}

// ---------- Yönetici güvenliği ----------
const h = s => crypto.createHash('sha256').update(s).digest();
function auth(req, res, next) {
  const raw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
  if (crypto.timingSafeEqual(h(raw.slice(raw.indexOf(':') + 1)), h(PASS))) return next();
  res.set('WWW-Authenticate', 'Basic realm="CAMI KIR admin"').status(401).send('Yetkisiz');
}

app.use(express.json());
app.get('/', (q, r) => r.redirect('/overlay'));
app.get('/overlay', (q, r) => r.sendFile(path.join(__dirname, 'public/overlay.html')));
app.use(['/admin', '/api'], auth);
app.get('/admin', (q, r) => r.sendFile(path.join(__dirname, 'public/admin.html')));

app.get('/api/state', (q, r) => r.json({ config: db.config, hp: db.hp, breaks: db.breaks, status, scores: top(500) }));
app.post('/api/config', (q, r) => {
  const b = q.body || {}, c = db.config;
  if (b.maxHp > 0) { db.hp = Math.max(1, Math.round(db.hp / c.maxHp * b.maxHp)); c.maxHp = +b.maxHp; }
  if (b.fallbackMultiplier >= 0) c.fallbackMultiplier = +b.fallbackMultiplier;
  if (b.effects) for (const k of Object.keys(c.effects)) if (k in b.effects) c.effects[k] = !!b.effects[k];
  if (b.gifts) { c.gifts = {}; for (const [k, v] of Object.entries(b.gifts)) if (+v >= 0 && k.trim()) c.gifts[k.trim().toLowerCase()] = +v; }
  const nu = typeof b.username === 'string' && b.username !== c.username;
  if (nu) c.username = b.username;
  save(); bc(pub()); if (nu) connect();
  r.json({ ok: 1 });
});
app.post('/api/reset-glass', (q, r) => { db.hp = db.config.maxHp; save(); bc({ type: 'reset' }); bc(pub()); r.json({ ok: 1 }); });
app.post('/api/reset-board', (q, r) => { db.scores = {}; save(); bc({ type: 'top', top: [] }); r.json({ ok: 1 }); });
app.post('/api/running', (q, r) => { db.config.running = !!q.body.running; save(); bc(pub()); r.json({ ok: 1 }); });
app.post('/api/connect', (q, r) => { retry = 0; connect(); r.json({ ok: 1 }); });
app.post('/api/test-gift', (q, r) => {
  const b = q.body || {};
  handle({ id: 'test:' + (b.user || 'Test'), name: b.user || 'Test', giftName: b.gift || 'rose', count: Math.max(1, +b.count || 1), diamonds: 1 });
  r.json({ ok: 1 });
});

server.listen(PORT, () => {
  console.log(`Yayın ekranı : http://localhost:${PORT}/overlay`);
  console.log(`Yönetici     : http://localhost:${PORT}/admin  (kullanıcı adı boş, şifre = ADMIN_PASSWORD)`);
  connect();
});
