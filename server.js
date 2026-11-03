// AeroStrike - game server (no extra packages needed, just Node.js)
// Run it with start.bat, or: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 200;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

// ---------- storage: Upstash Redis when configured (website), otherwise files next to this script (your PC) ----------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const KV_URL = process.env.UPSTASH_REDIS_REST_URL, KV_TOK = process.env.UPSTASH_REDIS_REST_TOKEN, KV = !!(KV_URL && KV_TOK);
async function kv(cmd) { const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOK }, body: JSON.stringify(cmd) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; }
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
let ACC = {}; if (!KV) { try { ACC = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) || {}; } catch (e) { ACC = {}; } }
const TOK = new Map(), accT = {};
function accSave(key) {
  if (KV) { clearTimeout(accT[key]); accT[key] = setTimeout(() => { kv(['SET', 'acc:' + key, JSON.stringify(ACC[key])]).catch(e => console.log('! could not save account ' + key + ': ' + e.message)); }, 300); return; }
  clearTimeout(accT._f); accT._f = setTimeout(() => { try { fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify(ACC)); fs.renameSync(ACC_FILE + '.tmp', ACC_FILE); } catch (e) { console.log('! could not save accounts: ' + e.message); } }, 300);
}
async function accGet(key) { if (ACC[key]) return ACC[key]; if (!KV) return null; const v = await kv(['GET', 'acc:' + key]); if (!v) return null; try { ACC[key] = JSON.parse(v); } catch (e) { return null; } return ACC[key]; }
async function tokSet(tok, key) { TOK.set(tok, key); if (KV) await kv(['SET', 'tok:' + tok, key, 'EX', 60 * 60 * 24 * 60]); }
async function tokGet(tok) { if (!tok) return null; if (TOK.has(tok)) return TOK.get(tok); if (KV) { const k = await kv(['GET', 'tok:' + tok]); if (k) { TOK.set(tok, k); return k; } return null; } return Object.keys(ACC).find(k => ACC[k].tok && ACC[k].tok === tok) || null; }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function jres(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); }
const RL = new Map();
function limited(req, n) { const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), t = now(); let e = RL.get(ip); if (!e || t - e.t > 60000) { e = { t, n: 0 }; RL.set(ip, e); } e.n++; if (RL.size > 5000) RL.clear(); return e.n > n; }
function api(req, res, route) {
  let body = ''; req.on('data', d => { body += d; if (body.length > 300000) { req.destroy(); } });
  req.on('end', async () => {
    try {
      let m = {}; try { m = JSON.parse(body || '{}'); } catch (e) { return jres(res, 400, { err: 'bad request' }); }
      if ((route === 'register' || route === 'login') && limited(req, 12)) return jres(res, 429, { err: 'Too many tries - wait a minute' });
      const u = String(m.user || '').trim().toLowerCase(), key = u.replace(/[^a-z0-9_]/g, '');
      if (route === 'register') {
        if (key.length < 3 || key.length > 16 || key !== u) return jres(res, 400, { err: 'Username must be 3-16 letters, numbers or _' });
        if (String(m.pass || '').length < 4) return jres(res, 400, { err: 'Password must be at least 4 characters' });
        if (await accGet(key)) return jres(res, 409, { err: 'That username is taken' });
        const salt = crypto.randomBytes(12).toString('hex'); ACC[key] = { salt, hash: hashPw(m.pass, salt), data: null, t: 0, made: Date.now() }; accSave(key);
        const tok = crypto.randomBytes(18).toString('hex'); await tokSet(tok, key); console.log('+ new account: ' + key); return jres(res, 200, { ok: 1, token: tok, user: key, data: null });
      }
      if (route === 'login') {
        const A = await accGet(key); if (!A || hashPw(m.pass || '', A.salt) !== A.hash) return jres(res, 401, { err: 'Wrong username or password' });
        const tok = crypto.randomBytes(18).toString('hex'); await tokSet(tok, key); if (!KV) { A.tok = tok; accSave(key); } return jres(res, 200, { ok: 1, token: tok, user: key, data: A.data, t: A.t });
      }
      const who = await tokGet(String(m.token || ''));
      const A = who ? await accGet(who) : null;
      if (!who || !A) return jres(res, 401, { err: 'Please log in again' });
      if (route === 'load') return jres(res, 200, { ok: 1, user: who, data: A.data, t: A.t });
      if (route === 'save') { if (typeof m.data !== 'string' || m.data.length > 250000) return jres(res, 400, { err: 'bad save' }); A.data = m.data; A.t = Date.now(); accSave(who); return jres(res, 200, { ok: 1, t: A.t }); }
      jres(res, 404, { err: 'unknown' });
    } catch (e) { console.log('! account error: ' + e.message); jres(res, 500, { err: 'Server storage error - try again' }); }
  });
}

// ---------- shared bot memory (one roster for everybody, grows forever) ----------
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
let ROSTER = null, rosLoaded = false; if (!KV) { try { ROSTER = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); } catch (e) { ROSTER = null; } rosLoaded = true; }
function rosterMerge(a, b) {
  if (!a || !Array.isArray(a.b)) return b; if (!b || !Array.isArray(b.b)) return a;
  const M = new Map(); for (const e of a.b) if (e && e.n) M.set(e.n, e);
  for (const e of b.b) { if (!e || !e.n) continue; const o = M.get(e.n); if (!o || (e.m || 0) > (o.m || 0) || ((e.m || 0) === (o.m || 0) && (e.xp || 0) > (o.xp || 0))) M.set(e.n, e); }
  return { b: [...M.values()].slice(0, 64), t: Date.now() };
}
let rosT = null; function rosterSave() { clearTimeout(rosT); rosT = setTimeout(() => { if (KV) { kv(['SET', 'roster', JSON.stringify(ROSTER)]).catch(e => console.log('! could not save bot memory: ' + e.message)); return; } try { fs.writeFileSync(ROSTER_FILE + '.tmp', JSON.stringify(ROSTER)); fs.renameSync(ROSTER_FILE + '.tmp', ROSTER_FILE); } catch (e) { console.log('! could not save bot memory: ' + e.message); } }, 300); }
function rosterApi(req, res) {
  let body = ''; req.on('data', d => { body += d; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => { try { let m = {}; try { m = JSON.parse(body || '{}'); } catch (e) { return jres(res, 400, { err: 'bad request' }); }
    if (!rosLoaded && KV) { try { const v = await kv(['GET', 'roster']); ROSTER = v ? JSON.parse(v) : null; } catch (e) { } rosLoaded = true; }
    let inc = null; try { inc = typeof m.roster === 'string' ? JSON.parse(m.roster) : null; } catch (e) { inc = null; }
    if (inc && Array.isArray(inc.b)) { inc.b = inc.b.filter(e => e && typeof e.n === 'string' && e.n.length < 20); ROSTER = rosterMerge(ROSTER, inc); rosterSave(); }
    jres(res, 200, { ok: 1, roster: ROSTER ? JSON.stringify(ROSTER) : null }); } catch (e) { jres(res, 500, { err: 'storage error' }); } });
}

// ---------- static file server ----------
const srv = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/roster') && req.method === 'POST') { rosterApi(req, res); return; }
  const ap = (req.url || '').match(/^\/api\/(register|login|load|save)$/); if (ap && req.method === 'POST') { api(req, res, ap[1]); return; }
  let f = decodeURIComponent((req.url || '/').split('?')[0]);
  if (f === '/') f = '/index.html';
  const fp = path.join(PUB, path.normalize(f));
  if (!fp.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

// ---------- minimal WebSocket (RFC 6455) ----------
class Conn {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.frag = []; this.dead = false;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); try { this.parse(); } catch (e) { this.kill(); } });
    sock.on('close', () => this.kill()); sock.on('error', () => this.kill());
  }
  kill() { if (this.dead) return; this.dead = true; try { this.s.destroy(); } catch (e) {} if (this.onclose) this.onclose(); }
  parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80; let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      if (len > 65536) { this.kill(); return; }
      let mk = null; if (masked) { if (b.length < o + 4) return; mk = b.slice(o, o + 4); o += 4; }
      if (b.length < o + len) return;
      const p = Buffer.from(b.slice(o, o + len)); if (mk) for (let i = 0; i < p.length; i++) p[i] ^= mk[i & 3];
      this.buf = b.slice(o + len);
      if (op === 8) { this.raw(8, Buffer.alloc(0)); this.kill(); return; }
      if (op === 9) { this.raw(10, p); continue; }
      if (op === 10) continue;
      if (op === 0 || op === 1) { this.frag.push(p); if (fin) { const m = Buffer.concat(this.frag).toString('utf8'); this.frag = []; if (this.onmsg) this.onmsg(m); } }
    }
  }
  raw(op, p) {
    if (this.dead) return; const n = p.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.s.write(Buffer.concat([h, p])); } catch (e) { this.kill(); }
  }
  sendStr(s) { this.raw(1, Buffer.from(s)); }
  send(o) { this.sendStr(JSON.stringify(o)); }
}
srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  onConn(new Conn(sock));
});

// ---------- shared game constants ----------
let nid = 1;
// half-size of each map (used to reject out-of-map positions)
const MAP_S = [58,56,56,62,60,54,58,62,54,60,51,40,38];
const LAB_MAPS = [11,12];
const BOT_NAMES = ['Vex','Rook','Nova','Jinx','Echo','Kade','Mira','Zed','Onyx','Pike','Sable','Tarn','Lumi','Rift','Coda','Halo'];
const now = () => Date.now();
const MODES = ['ffa','tdm','dom','elim','gg','fz','bt','tgg','tfz','tbt','svs','ctf','lab','arena'];
const TEAMM = m => ['tdm','dom','elim','tgg','tfz','tbt','svs','ctf','lab'].includes(m);
const KILLTS = m => ['tdm','svs','tgg','tfz'].includes(m);
const ELM = m => m === 'elim' || m === 'lab';
const ARENA_POOL = ['gg','fz','bt','svs','ctf','lab'];
const GG_LEN = 10, BT_LIMIT = 8;
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
// ---------- game rooms (each room runs its own match) ----------
const ROOMS = new Map();
function makeRoom(rid, o) {
  o = o || {};
  const P = new Map(); let host = 0, match = null, autoT = null;
  const cfg = { map: -1, mode: o.mode || 'tdm', limit: 25, bots: -1 };
  const pub = !!o.pub;
let arenaRound = 0, arenaLast = null, arenaT = null;
const MM = () => match ? match.mode : cfg.mode;
function humans() { return [...P.values()].filter(q => !q.bot).length; }
function bc(o, except) { const s = JSON.stringify(o); for (const p of P.values()) if (p !== except && p.c) p.c.sendStr(s); }
function plist() { return [...P.values()].map(p => ({ id: p.id, name: p.name, team: p.team, k: p.k, d: p.d, skin: p.skin, gskin: p.gskin, inm: p.inm, bot: !!p.bot, owner: p.owner || 0 })); }
function lobby() { bc({ t: 'lobby', host, cfg, room: rid, pub, mm: match ? match.mode : null, inMatch: !!match, players: plist() }); }
function teamCount(t) { let n = 0; for (const p of P.values()) if (p.team === t) n++; return n; }
function startFor(p) { p.inm = true; p.alive = false; p.hp = 100; p.st = null; p.stT = 0; p.portals = [null, null]; if (p.c) p.c.send({ t: 'start', cfg: Object.assign({}, cfg, { map: match ? match.map : Math.max(0, cfg.map), mode: MM(), arena: match ? match.arena : 0 }), age: match ? (Date.now() - match.t0) / 1000 : 0, players: plist(), ts: match ? match.ts : [0, 0], bots: [...P.values()].filter(b => b.bot).map(b => ({ id: b.id, name: b.name, team: b.team, skin: b.skin, owner: b.owner })) }); }
function removeBots(owner) { for (const b of [...P.values()]) if (b.bot && (owner === undefined || b.owner === owner)) { P.delete(b.id); bc({ t: 'left', id: b.id }); } }
function attacker(p, from) { if (from === undefined || from === null) return p; const b = P.get(from); return (b && b.bot && b.owner === p.id) ? b : null; }
function near(a, b, r) { return a && b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < r; }
function portalJump(a, b) { for (const q of P.values()) { const pp = q.portals; if (!pp || !pp[0] || !pp[1]) continue; for (let i = 0; i < 2; i++) if (near(a, pp[i], 5) && near(b, pp[1 - i], 5)) return true; } return false; }
let endMatch = function (winner, team) {
  if (!match) return; bc({ t: 'end', winner, team, mode: match.mode, players: plist(), ts: match.ts }); match = null; removeBots();
  for (const p of P.values()) { p.inm = false; p.alive = false; } lobby();
  if (cfg.mode === 'arena') { clearTimeout(arenaT); arenaT = setTimeout(() => { if (!match && cfg.mode === 'arena' && humans() > 0) { const h = P.get(host) || [...P.values()].find(q => !q.bot); if (h) startMatch(h); } }, 15000); }
  else arenaRound = 0;
};
function pickMap(mode) {
  if (mode === 'lab') return LAB_MAPS[(Math.random() * LAB_MAPS.length) | 0];
  if (cfg.map >= 0 && !LAB_MAPS.includes(cfg.map) && cfg.mode !== 'arena') return cfg.map;
  const non = MAP_S.map((_, i) => i).filter(i => !LAB_MAPS.includes(i)); return non[(Math.random() * non.length) | 0];
}
function startMatch(p) {
  let mode = cfg.mode;
  if (mode === 'arena') { let k, tr = 0; do { k = ARENA_POOL[(Math.random() * ARENA_POOL.length) | 0]; } while (k === arenaLast && tr++ < 20); arenaLast = k; arenaRound++; mode = k; }
  match = { mode, arena: cfg.mode === 'arena' ? arenaRound : 0, ts: [0, 0], map: pickMap(mode), t0: Date.now(), bomb: { h: 0, t: 0, wait: 8, cd: 0 }, el: { st: 'play', t: 0 } }; removeBots();
  const team = TEAMM(mode), hum = humans(), want = cfg.bots < 0 ? Math.max(0, (team ? (mode === 'lab' ? 6 : 10) : 8) - hum) : cfg.bots;
  for (let i = 0; i < Math.min(14, want); i++) { const b = { id: nid++, c: null, bot: true, owner: p.id, name: BOT_NAMES[i % BOT_NAMES.length], skin: (Math.random() * 9) | 0, gskin: 0, team: teamCount(0) <= teamCount(1) ? 0 : 1, hp: 100, alive: false, k: 0, d: 0, st: null, lastDmg: 0, dmgWin: [], healT: 0, inm: true, joined: true }; P.set(b.id, b); }
  for (const q of P.values()) { q.k = 0; q.d = 0; q.elDead = false; } for (const q of P.values()) startFor(q); lobby();
  console.log('> match started: ' + mode + (match.arena ? ' (arena round ' + match.arena + ')' : '') + ' on map ' + match.map);
}
function elimCheck() {
  if (!match || !ELM(match.mode) || match.el.st !== 'play') return;
  const al = [0, 0]; for (const q of P.values()) if (q.inm && q.alive) al[q.team ? 1 : 0]++;
  if (al[0] && al[1]) return; const w = al[0] ? 0 : 1; match.ts[w]++; match.el.st = 'gap'; bc({ t: 'round', w, ts: match.ts });
  if (match.ts[w] >= (match.mode === 'lab' ? 3 : 4)) { setTimeout(() => endMatch(0, w), 2500); return; }
  setTimeout(() => { if (!match || !ELM(match.mode)) return; match.el.st = 'play'; for (const q of P.values()) if (q.inm) { q.alive = true; q.hp = 100; q.fresh = true; q.elDead = false; } bc({ t: 'rstart' }); }, 4000);
}

function handle(p, m) {
  const t = m.t;
  if (!p.joined) return;
  if (t === 'cfg' && p.id === host && !match) {
    if (Number.isInteger(m.map) && m.map >= -1 && m.map < 64) cfg.map = m.map;
    if (MODES.includes(m.mode)) cfg.mode = m.mode;
    if (Number.isInteger(m.limit) && m.limit >= 1 && m.limit <= 300) cfg.limit = m.limit;
    if ([-1, 0, 2, 4, 6, 8, 10, 14].includes(m.bots)) cfg.bots = m.bots;
    lobby(); return;
  }
  if (t === 'team' && !match) { p.team = 1 - p.team; lobby(); return; }
  if (t === 'start' && p.id === host && !match) {
    clearTimeout(arenaT); arenaRound = 0; startMatch(p); return;
  }
  if (t === 'rejoin' && match && !p.inm) { startFor(p); lobby(); return; }
  if (t === 'out') { p.inm = false; p.alive = false; if (match && ![...P.values()].some(q => q.inm && !q.bot)) { match = null; removeBots(); for (const q of P.values()) { q.inm = false; q.alive = false; } } lobby(); return; }
  if (!match || !p.inm) return;
  if (t === 'st' && m.s && typeof m.s === 'object') {
    const s = m.s, ns = { x: num(s.x, 0), y: num(s.y, 0), z: num(s.z, 0) }, tn = now(), lim = (MAP_S[match.map] || 60) + 8;
    if (Math.abs(ns.x) > lim || Math.abs(ns.z) > lim || ns.y < -40 || ns.y > 160) { if (p.st) p.c.send({ t: 'fix', x: p.st.x, y: p.st.y, z: p.st.z }); return; }
    if (p.st && p.stT && !p.fresh) {
      const dt = Math.max(.03, (tn - p.stT) / 1000), dh = Math.hypot(ns.x - p.st.x, ns.z - p.st.z), up = ns.y - p.st.y;
      if ((dh > 50 * dt + 2 || up > 42 * dt + 2) && !portalJump(p.st, ns)) { p.viol = (p.viol || 0) + 1; p.c.send({ t: 'fix', x: p.st.x, y: p.st.y, z: p.st.z }); if (p.viol % 20 === 1) console.log('! blocked impossible movement from ' + p.name); return; }
    }
    p.fresh = false; p.stT = tn;
    p.st = { x: num(s.x, 0), y: num(s.y, 0), z: num(s.z, 0), yw: num(s.yw, 0), pt: num(s.pt, 0), vx: num(s.vx, 0), vz: num(s.vz, 0), g: s.g ? 1 : 0, sl: s.sl ? 1 : 0, cr: s.cr ? 1 : 0, wr: num(s.wr, 0), w: Math.max(0, Math.min(7, s.w | 0)), sh: s.sh ? 1 : 0, pz: s.pz ? 1 : 0, ck: s.ck ? 1 : 0 };
    return;
  }
  if (t === 'resp') { const A = attacker(p, m.from); if (ELM(match.mode) && (!A || A.elDead || match.el.st !== 'play')) return; if (A && !A.alive) { A.alive = true; A.hp = 100; A.lastDmg = 0; A.fresh = true; } return; }
  if (t === 'bst' && Array.isArray(m.ps)) { for (const q of m.ps.slice(0, 16)) { const b = P.get(q && q.id); if (!b || !b.bot || b.owner !== p.id || !q.s) continue; const s = q.s; b.st = { x: num(s.x, 0), y: num(s.y, 0), z: num(s.z, 0), yw: num(s.yw, 0), pt: 0, vx: num(s.vx, 0), vz: 0, g: s.g ? 1 : 0, sl: s.sl ? 1 : 0, cr: 0, wr: 0, w: Math.max(0, Math.min(7, s.w | 0)), sh: 0, pz: 0, ck: 0 }; } return; }
  if (t === 'eff') {
    const tg = P.get(m.to), A = attacker(p, m.from); if (!tg || !tg.alive || !A || !A.alive || !['slow', 'stun', 'pull'].includes(m.k)) return;
    const d = Math.min(5, num(m.d, 0)); if (d <= 0) return; if (TEAMM(MM()) && tg.team === A.team && tg !== A) return;
    const o = { t: 'eff', to: tg.id, k: m.k, d, x: num(m.x, 0), z: num(m.z, 0) }; const cc = tg.c || (P.get(tg.owner) || {}).c; if (cc) cc.send(o); return;
  }
  if (t === 'heal') { const n = num(m.n, 0); if (p.alive && n > 0 && n <= 60 && now() - p.healT > 7000) { p.healT = now(); p.hp = Math.min(100, p.hp + n); } return; }
  if (t === 'hit') {
    const tg = P.get(m.to), dmg = num(m.dmg, 0), A = attacker(p, m.from);
    if (!A || !tg || !tg.alive || !tg.inm || dmg <= 0 || dmg > 260) return;
    if (MM() === 'bt' || MM() === 'tbt') { const B = match.bomb; if (A.id === B.h && tg !== A && A.alive && now() - B.cd > 1000 && !(MM() === 'tbt' && tg.team === A.team)) { B.h = tg.id; B.cd = now(); bc({ t: 'bomb', h: B.h, tl: B.t }); } return; }
    if (tg !== A) {
      if (!A.alive) return;
      if (TEAMM(MM()) && tg.team === A.team) return;
      if (A.st && tg.st && Math.hypot(A.st.x - tg.st.x, A.st.y - tg.st.y, A.st.z - tg.st.z) > 220) return;
      const tn = now(); A.dmgWin = A.dmgWin.filter(x => tn - x.t < 1000); const sum = A.dmgWin.reduce((a, x) => a + x.d, 0);
      if (sum + dmg > 700) return; A.dmgWin.push({ t: tn, d: dmg });
    }
    let d = dmg; if (tg.st && tg.st.pz) d = 0; else if (tg.st && tg.st.sh) d *= .3; if (d <= 0) return;
    tg.hp -= d; tg.lastDmg = now();
    bc({ t: 'dmg', to: tg.id, hp: Math.max(0, Math.round(tg.hp)), by: A.id, head: !!m.head });
    if (tg.hp <= 0) {
      tg.alive = false; tg.d++;
      const md = MM(); if (ELM(md)) tg.elDead = true; if (tg !== A) { A.k++; if (KILLTS(md)) match.ts[A.team]++; }
      bc({ t: 'kill', k: A.id, v: tg.id, head: !!m.head, w: m.w | 0, players: plist(), ts: match.ts });
      if ((md === 'ffa' || md === 'fz') && A.k >= cfg.limit) endMatch(A.id, -1);
      else if (md === 'gg' && A.k >= GG_LEN) endMatch(A.id, -1);
      else if (md === 'tgg' && match.ts[A.team] >= GG_LEN * 2) endMatch(0, A.team);
      else if (KILLTS(md) && md !== 'tgg' && match.ts[A.team] >= cfg.limit) endMatch(0, A.team);
      else if (ELM(md)) elimCheck();
    }
    return;
  }
  if (t === 'portal' && p.alive && Array.isArray(m.p)) { p.portals[m.i ? 1 : 0] = { x: num(m.p[0], 0), y: num(m.p[1], 0), z: num(m.p[2], 0) }; }
  if (t === 'ms' && p.id === host) { m.id = p.id; bc(m, p); return; }
  if (t === 'msc' && p.id === host && (MM() === 'dom' || MM() === 'ctf')) { const tm = m.team ? 1 : 0, n = Math.max(0, Math.min(10, num(m.n, 1))); match.ts[tm] += n; bc({ t: 'ts', ts: match.ts, cap: MM() === 'ctf' ? tm : undefined }); const lim = MM() === 'ctf' ? 3 : 150; if (match.ts[tm] >= lim) endMatch(0, tm); return; }
  if ((t === 'shot' || t === 'fx' || t === 'portal') && (p.alive || t === 'shot' || t === 'fx')) { m.id = p.id; bc(m, p); return; }
}

function bombTick() {
  const B = match.bomb, al = [...P.values()].filter(q => q.inm && q.alive);
  if (!B.h) { B.wait -= .05; if (B.wait <= 0 && al.length >= 2) { B.h = al[(Math.random() * al.length) | 0].id; B.t = 20; B.cd = now(); bc({ t: 'bomb', h: B.h, tl: B.t }); } return; }
  const H = P.get(B.h); if (!H || !H.inm || !H.alive) { B.h = 0; B.wait = 2; bc({ t: 'bomb', h: 0 }); return; }
  B.t -= .05; if (B.t > 0) return;
  H.alive = false; H.d++; const team = match.mode === 'tbt'; if (team) match.ts[H.team ? 0 : 1]++; else for (const q of al) if (q !== H) q.k++;
  bc({ t: 'bomb', h: 0, boom: H.id }); bc({ t: 'kill', k: H.id, v: H.id, bomb: 1, players: plist(), ts: match.ts });
  B.h = 0; B.wait = 3;
  if (team) { if (match.ts[0] >= 5) endMatch(0, 0); else if (match.ts[1] >= 5) endMatch(0, 1); return; }
  const top = [...P.values()].filter(q => q.inm).sort((a, b) => b.k - a.k)[0];
  if (top && top.k >= BT_LIMIT) endMatch(top.id, -1);
}
function tickSnap() {
  if (!match) return; const tn = now(), ps = [];
  const bm = MM() === 'bt' || MM() === 'tbt'; if (bm) { bombTick(); if (!match) return; }
  for (const p of P.values()) {
    if (!p.inm) continue;
    if (bm) p.hp = 100; else if (p.alive && p.hp < 100 && tn - p.lastDmg > 5000) p.hp = Math.min(100, p.hp + 15 * .05);
    ps.push({ id: p.id, s: p.st, hp: Math.round(p.hp), al: p.alive ? 1 : 0, tm: p.team });
  }
  bc({ t: 'snap', ps });
}


  function cap() { return TEAMM(cfg.mode) || cfg.mode === 'arena' ? (cfg.mode === 'lab' ? 6 : 10) : 8; }
  function autoStart(delay) { if (!pub) return; clearTimeout(autoT); autoT = setTimeout(() => { autoT = null; if (match || humans() === 0) return; const h = P.get(host) || [...P.values()].find(q => !q.bot); if (h) startMatch(h); }, delay); bc({ t: 'soon', in: Math.round(delay / 1000) }); }
  function join(p, m) {
    p.joined = true; p.room = api; p.name = String(m.name || 'Player').replace(/[<>&"]/g, '').slice(0, 14) || 'Player';
    p.skin = Math.max(0, Math.min(40, m.skin | 0)); p.gskin = Math.max(0, Math.min(20, m.gskin | 0));
    p.team = teamCount(0) <= teamCount(1) ? 0 : 1; P.set(p.id, p); if (!host) host = p.id;
    p.c.send({ t: 'welcome', id: p.id, room: rid, pub }); lobby(); console.log('+ ' + p.name + ' joined room ' + rid + ' (' + humans() + ' here)');
    if (match) startFor(p); else if (pub && !autoT) autoStart(5000);
  }
  function leave(p) {
    if (!P.has(p.id)) return; P.delete(p.id); bc({ t: 'left', id: p.id });
    removeBots(p.id);
    if (host === p.id) { const h = [...P.values()].find(q => !q.bot); host = h ? h.id : 0; }
    if (match && ![...P.values()].some(q => q.inm && !q.bot)) { match = null; removeBots(); }
    lobby(); console.log('- ' + p.name + ' left room ' + rid);
    if (humans() === 0) destroy();
  }
  const snapIv = setInterval(() => { try { tickSnap(); } catch (e) { console.log('! snapshot error: ' + e.message); } }, 50);
  function destroy() { clearInterval(snapIv); clearTimeout(autoT); clearTimeout(arenaT); ROOMS.delete(rid); }
  const _end = endMatch;
  endMatch = function (w, t) { _end(w, t); if (pub && humans() > 0 && cfg.mode !== 'arena') autoStart(15000); };
  const api = { rid, pub, cfg, join, leave, handle, humans, cap, get match() { return match; } };
  return api;
}
function roomCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0]; } while (ROOMS.has(c)); return c; }
function pickRoom(m) {
  const want = String(m.room || '');
  if (want.startsWith('pub:')) { const mode = MODES.includes(want.slice(4)) ? want.slice(4) : 'tdm';
    let best = null; for (const R of ROOMS.values()) if (R.pub && R.cfg.mode === mode && R.humans() < R.cap() && (!best || (!R.match && best.match))) best = R;
    if (best) return best; const id = 'P' + roomCode(); const R = makeRoom(id, { pub: true, mode }); ROOMS.set(id, R); return R; }
  if (want === 'new') { const id = roomCode(); const R = makeRoom(id); ROOMS.set(id, R); return R; }
  const code = want.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (code && ROOMS.has(code)) return ROOMS.get(code);
  if (code) return null;
  if (!ROOMS.has('MAIN')) ROOMS.set('MAIN', makeRoom('MAIN')); return ROOMS.get('MAIN');
}
let ONLINE = 0;
function onConn(c) {
  const p = { id: nid++, c, name: 'Player', skin: 0, gskin: 0, team: 0, hp: 100, alive: false, k: 0, d: 0, st: null, lastDmg: 0, dmgWin: [], healT: 0, inm: false, joined: false, room: null };
  ONLINE++; if (ONLINE > MAX_PLAYERS) { c.send({ t: 'full' }); setTimeout(() => c.kill(), 200); }
  let n = 0, nt = now();
  c.onmsg = s => { if (s.length > 2000) return; if (now() - nt > 1000) { nt = now(); n = 0; } if (++n > 120) return; let m; try { m = JSON.parse(s); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    try { if (m.t === 'join' && !p.room) { const R = pickRoom(m); if (!R) { c.send({ t: 'noroom' }); return; } if (R.humans() >= 16) { c.send({ t: 'full' }); return; } R.join(p, m); } else if (p.room) p.room.handle(p, m); } catch (e) { console.log('! error handling ' + m.t + ' from ' + p.name + ': ' + e.message); } };
  c.onclose = () => { ONLINE--; if (p.room) p.room.leave(p); };
}
process.on('uncaughtException', e => console.log('! unexpected error (server kept running): ' + (e && e.stack || e)));
srv.listen(PORT, () => {
  console.log('\n  AEROSTRIKE server is running!\n');
  console.log('  Saving accounts to: ' + (KV ? 'Upstash cloud database' : path.join(DATA_DIR, 'accounts.json')));
  console.log('  On this computer open:   http://localhost:' + PORT);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  for (const ip of ips) console.log('  Friends on your Wi-Fi:   http://' + ip + ':' + PORT);
  console.log('\n  Keep this window open while playing. Close it to stop the server.\n');
});
srv.on('error', e => { console.log('Server error: ' + e.message + (e.code === 'EADDRINUSE' ? '\nPort ' + PORT + ' is busy - is the server already running in another window?' : '')); });
