import KB from './llm.json';
import { createBot, fill } from './llm.js';

const BOT = createBot(KB);

const NAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Mobile Legends account identity. The IGN is stored in the roblox_* columns (display + wheel name) and the
// "UserID-ServerID" pair is stored in the tiktok_* columns, so the existing tables and duplicate logic keep working.
const cleanIgn = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const validIgn = (s) => {
  const t = cleanIgn(s);
  return t.length >= 3 && t.length <= 24 && !/[\u0000-\u001f<>]/.test(t);
};
const parseAccount = (body) => {
  const ign = cleanIgn(body.ign !== undefined ? body.ign : body.roblox);
  const uid = String(body.userId || '').trim();
  const sid = String(body.serverId || '').trim();
  const handle = String(body.tiktok || '').trim().replace(/^@/, '');
  if (!validIgn(ign)) return { error: 'Enter your Mobile Legends IGN (3-24 characters).' };
  if (!/^\d{5,12}$/.test(uid)) return { error: 'Your User ID should be 5-12 digits (numbers only).' };
  if (!/^\d{3,6}$/.test(sid)) return { error: 'Your Server ID should be 3-6 digits (numbers only).' };
  if (!/^[a-zA-Z0-9_.]{2,24}$/.test(handle)) return { error: 'Enter your TikTok username (letters, numbers, dots and underscores).' };
  return { roblox: ign, rl: ign.toLowerCase(), uid, sid, mlKey: `${uid}-${sid}`, tiktok: handle, tl: handle.toLowerCase() };
};

// ---- Player registry (universal across giveaways) ----
const TRACK_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L look-alikes
const makeTrackingId = () => {
  const b = crypto.getRandomValues(new Uint8Array(5));
  let t = '';
  for (const x of b) t += TRACK_CHARS[x % TRACK_CHARS.length];
  return `SW-${t}`;
};
const findPlayerByMl = (env, uid, sid) =>
  env.DB.prepare('SELECT * FROM players WHERE ml_user_id = ?1 AND ml_server_id = ?2 LIMIT 1').bind(uid, sid).first();
const handleTaken = (env, tl, uid, sid) =>
  env.DB.prepare('SELECT tracking_id FROM players WHERE tiktok_lower = ?1 AND NOT (ml_user_id = ?2 AND ml_server_id = ?3) LIMIT 1')
    .bind(tl, uid, sid).first();
const createPlayer = async (env, a, source, now) => {
  const known = await findPlayerByMl(env, a.uid, a.sid);
  if (known) return { player: known, created: false };
  for (let i = 0; i < 6; i++) {
    const tid = makeTrackingId();
    try {
      await env.DB.prepare(
        `INSERT INTO players (tracking_id, tracking_lower, ml_user_id, ml_server_id, ign, tiktok_username, tiktok_lower, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(tid, tid.toLowerCase(), a.uid, a.sid, a.roblox, a.tiktok, a.tl, source, now).run();
      return { player: await findPlayerByMl(env, a.uid, a.sid), created: true };
    } catch (err) {
      if (!String(err && err.message).includes('UNIQUE')) throw err;
      const again = await findPlayerByMl(env, a.uid, a.sid);
      if (again) return { player: again, created: false };
    }
  }
  throw new Error('Could not generate a unique tracking ID.');
};
const playerBanned = (env, p) =>
  env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2, ?3, ?4) LIMIT 1')
    .bind(p.ign.toLowerCase(), p.tracking_lower, p.tiktok_lower, `${p.ml_user_id}-${p.ml_server_id}`).first();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ALERT_TTL_MS = 120000;
const MAX_BODY = 20000;
const MAX_SHOT_CHARS = 450000;
const MAX_APPLY_BODY = 520000;
const MAX_PENDING_APPS = 300;
const SPIN_LOCK_MS = 15000;
const LIST_TTL_MS = 3000;
let listCache = { at: 0, body: '' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

const jsonText = (text, status = 200) =>
  new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const DEFAULT_STREAMER = { name: 'Hastelicous', username: 'mshuxley25' };

const streamerFrom = (config) => ({
  name: cleanLine(config.streamer_name, 40) || DEFAULT_STREAMER.name,
  username: String(config.streamer_username || '').replace(/^@/, '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30) || DEFAULT_STREAMER.username
});

// Fuzzy "does the OCR text contain this static label" check. Only letters/digits are compared,
// so OCR noise like "@", "_" or stray symbols never breaks a match.
const fuzzyHas = (text, target, maxDist) => {
  const hay = norm(text);
  const t = norm(target);
  if (!t) return false;
  if (hay.includes(t)) return true;
  if (maxDist < 1 || t.length < 7) return false;
  for (let i = 0; i < hay.length; i++) {
    for (let d = -maxDist; d <= maxDist; d++) {
      const len = t.length + d;
      if (len > 0 && i + len <= hay.length && lev(hay.substr(i, len), t) <= maxDist) return true;
    }
  }
  return false;
};

const isFollowingToken = (tok) =>
  tok.length >= 7 && tok.length <= 11 && (tok.startsWith('followin') || lev(tok, 'following') <= 2);
const isMessageToken = (tok) => tok.length >= 6 && tok.length <= 8 && lev(tok, 'message') <= 1;

// The grey stat labels (Following / Followers / Likes) are low contrast and often missed by OCR, so they are
// not relied on. The reliable signal is the button row: when you follow someone it reads "Message  Following".
// When you do not follow, that button says "Follow" instead. Mutual follows show "Friends".
const followState = (text) => {
  const tokens = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const count = tokens.filter(isFollowingToken).length;
  const friends = tokens.some((t) => t === 'friends' || (t.length >= 6 && lev(t, 'friends') <= 1));
  let button = false;
  tokens.forEach((t, i) => {
    if (!isMessageToken(t)) return;
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) if (isFollowingToken(tokens[j])) button = true;
  });
  return { count, friends, button, following: button || count >= 2 || (count >= 1 && friends) };
};

// Returns null when the screenshot text passes, otherwise { code, error }.
const checkFollowText = (text, streamer) => {
  if (!fuzzyHas(text, streamer.name, 1)) {
    return { code: 'streamer', error: `We could not find the streamer name "${streamer.name}" in the screenshot.` };
  }
  if (!fuzzyHas(text, streamer.username, streamer.username.length >= 10 ? 2 : 1)) {
    return { code: 'streamer', error: `We could not find the username @${streamer.username} in the screenshot.` };
  }
  const f = followState(text);
  if (!f.following) {
    return {
      code: 'follow',
      error: f.count >= 1
        ? 'The screenshot shows a Follow button, not Following. Follow the streamer on TikTok first, then take a new screenshot.'
        : 'We could not find the word "Following" in the screenshot. Make sure the whole profile header is visible.'
    };
  }
  return null;
};

const setConfig = (env, key, value) =>
  env.DB.prepare(
    'INSERT INTO system_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value);

const bumpSpin = (env) =>
  env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('spin_id', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
  );

const readConfig = async (env) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM system_config').all();
  const config = {};
  for (const row of results) config[row.key] = row.value;
  return config;
};

const isAdmin = async (request, env, url) => {
  if (!env.STREAMER_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : request.headers.get('X-Admin-Token') || url.searchParams.get('token') || '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(env.STREAMER_TOKEN))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};


const randomHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const cleanOcr = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.:+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

const cleanLine = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const deviceHashFor = async (request) => {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  return (await sha256Hex(`${ip}|${ua}`)).slice(0, 32);
};

const readBody = async (request, max) => {
  const raw = await request.text();
  if (raw.length > max) return { error: json({ ok: false, error: 'Payload too large.' }, 413) };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: json({ ok: false, error: 'Invalid JSON.' }, 400) };
  }
};

const findOpenGiveaway = (env, now) =>
  env.DB.prepare(
    "SELECT id, expires_at FROM giveaways WHERE status = 'open' AND expires_at > ?1 ORDER BY id DESC LIMIT 1"
  ).bind(now).first();

const activeGiveaway = (env) =>
  env.DB.prepare("SELECT id, status, opened_at, expires_at FROM giveaways WHERE status NOT IN ('ended', 'saved') ORDER BY id DESC LIMIT 1").first();

const expireGiveaways = async (env, now) => {
  const r = await env.DB.prepare(
    "UPDATE giveaways SET status = 'closed', token_hash = '' WHERE status = 'open' AND expires_at <= ?1"
  ).bind(now).run();
  if (r.meta.changes > 0) await setConfig(env, 'registration_gate', 'closed').run();
};

const currentOut = async (env) => {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('out_list', 'wheel_command', 'last_landed')"
  ).all();
  const c = {};
  for (const r of results) c[r.key] = r.value;
  let out = [];
  try {
    out = JSON.parse(c.out_list || '[]');
  } catch {
    out = [];
  }
  out = Array.isArray(out) ? out.filter((n) => typeof n === 'string') : [];
  if (c.wheel_command === 'spin_elim' && c.last_landed && !out.some((n) => n.toLowerCase() === c.last_landed.toLowerCase())) {
    out.push(c.last_landed);
  }
  return out;
};

const pickAlive = (env, gid, out) =>
  env.DB.prepare(
    `SELECT roblox_username, roblox_lower, tiktok_lower FROM qualified_entries
     WHERE giveaway_id = ?1 AND status = 'alive' AND roblox_lower NOT IN (SELECT lower(value) FROM json_each(?2))
     ORDER BY RANDOM() LIMIT 1`
  ).bind(gid, JSON.stringify(out)).first();

const claimSpin = async (env, now) => {
  const [, claim] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO system_config (key, value) VALUES ('last_spin_at', '0')"),
    env.DB.prepare("UPDATE system_config SET value = ?1 WHERE key = 'last_spin_at' AND CAST(value AS INTEGER) <= ?2").bind(
      String(now), now - SPIN_LOCK_MS
    )
  ]);
  return claim.meta.changes === 1;
};

const purgeEndedStatements = (env) => [
  env.DB.prepare("DELETE FROM manual_applications WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM qualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM disqualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status = 'ended')"),
  env.DB.prepare("DELETE FROM giveaways WHERE status = 'ended'")
];

const matchesToken = async (request, secret) => {
  if (!secret) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(secret))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};

const STREAM_ACTIONS = new Set([
  'verify', 'spin_winner', 'spin_elim', 'reset_wheel', 'open_giveaway', 'close_registration', 'end_giveaway'
]);

const isOwner = async (request, env) => {
  if (!env.OWNER_TOKEN_2) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(env.OWNER_TOKEN_2))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
};

async function gatekeep(env, config, body, now) {
  if (config.registration_gate !== 'open') {
    return { error: json({ ok: false, code: 'closed', error: 'No giveaway is open for registration right now.' }, 403) };
  }
  const giveaway = await findOpenGiveaway(env, now);
  if (!giveaway) {
    return { error: json({ ok: false, code: 'closed', error: 'Registration is closed right now.' }, 403) };
  }
  const acct = parseAccount(body);
  if (acct.error) return { error: json({ ok: false, code: 'account', error: acct.error }, 400) };
  const banned = await env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2, ?3) LIMIT 1')
    .bind(acct.rl, acct.tl, acct.mlKey).first();
  if (banned) {
    return { error: json({ ok: false, code: 'banned', error: 'This account is permanently banned from the wheel.' }, 403) };
  }
  return { giveaway, ...acct };
}

// Enter a registered player into a giveaway. Mobile Legends names are not unique, so a clash with a
// different player's name gets a short ID suffix (e.g. "Alex #K4Q9") to keep the wheel unambiguous.
const enrollPlayer = async (env, gid, p, source, device, now) => {
  const clash = await env.DB.prepare(
    'SELECT 1 AS hit FROM qualified_entries WHERE giveaway_id = ?1 AND roblox_lower = ?2 AND tiktok_lower != ?3 LIMIT 1'
  ).bind(gid, p.ign.toLowerCase(), p.tracking_lower).first();
  const name = clash ? `${p.ign} #${p.tracking_id.slice(-4)}` : p.ign;
  return insertEntry(env, gid, name, name.toLowerCase(), p.tiktok_username, p.tracking_lower, 0, device || '', source, now);
};

const insertEntry = async (env, gid, roblox, rl, tiktok, tl, level, device, source, now) => {
  try {
    const r = await env.DB.prepare(
      `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
       SELECT ?8, ?1, ?2, ?3, ?4, ?5, ?6, 'alive', ?9, ?7
       WHERE NOT EXISTS (SELECT 1 FROM qualified_entries WHERE giveaway_id = ?8 AND (roblox_lower = ?2 OR tiktok_lower = ?4))
         AND NOT EXISTS (SELECT 1 FROM disqualified_entries WHERE giveaway_id = ?8 AND (roblox_lower = ?2 OR tiktok_lower = ?4))`
    ).bind(roblox, rl, tiktok, tl, level, device, now, gid, source).run();
    return r.meta.changes === 1;
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return false;
    throw err;
  }
};

async function handleSubmit(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const { body, error } = await readBody(request, MAX_BODY);
  if (error) return error;
  const now = Date.now();

  const gate = await gatekeep(env, config, body, now);
  if (gate.error) return gate.error;
  const { giveaway, roblox, tl, uid, sid } = gate;
  if (body.terms !== true) {
    return json({ ok: false, code: 'terms', error: 'You must accept the Terms and Conditions to enter.' }, 400);
  }

  const known = await findPlayerByMl(env, uid, sid);
  if (known) return json({ ok: false, code: 'registered', error: 'You are already registered. Use the Enter tab.' }, 409);
  if (await handleTaken(env, tl, uid, sid)) {
    return json({ ok: false, code: 'tiktok_taken', error: 'That TikTok username is already linked to another Mobile Legends account. Ask the host for help.' }, 409);
  }

  const failed = checkFollowText(cleanOcr(body.ocrText), streamerFrom(config));
  if (failed) return json({ ok: false, code: failed.code, error: failed.error }, 422);

  const device = await deviceHashFor(request);
  const made = await createPlayer(env, gate, 'scan', now);
  if (!made.created) return json({ ok: false, code: 'registered', error: 'You are already registered. Use the Enter tab.' }, 409);
  await enrollPlayer(env, giveaway.id, made.player, 'ocr', device, now);
  return json({ ok: true, message: `You're registered and entered, ${roblox}.` });
}

// ---- Returning players: "Enter" (login) ----
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const loginLockedMinutes = async (env, device, now) => {
  const row = await env.DB.prepare('SELECT fails, window_start FROM login_attempts WHERE device_hash = ?1').bind(device).first();
  if (!row || now - row.window_start > LOGIN_WINDOW_MS) return 0;
  return row.fails >= LOGIN_MAX_FAILS ? Math.max(1, Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 60000)) : 0;
};
const loginFailed = (env, device, now) =>
  env.DB.prepare(
    `INSERT INTO login_attempts (device_hash, fails, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(device_hash) DO UPDATE SET
       fails = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`
  ).bind(device, now, LOGIN_WINDOW_MS).run();
const loginOk = (env, device) => env.DB.prepare('DELETE FROM login_attempts WHERE device_hash = ?1').bind(device).run();

// Way "name": display name + Mobile Legends User ID (Server ID only if two accounts share that User ID).
// Way "ids": User ID + Server ID + TikTok username (for players who forgot their display name).
async function verifyPlayer(env, body) {
  const uid = String(body.userId || '').trim();
  if (!/^\d{5,12}$/.test(uid)) return { bad: 'Enter your Mobile Legends User ID (5-12 digits).' };
  if (body.way === 'ids') {
    const sid = String(body.serverId || '').trim();
    const handle = String(body.tiktok || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^\d{3,6}$/.test(sid)) return { bad: 'Enter your Server ID (3-6 digits).' };
    if (!/^[a-z0-9_.]{2,24}$/.test(handle)) return { bad: 'Enter your TikTok username.' };
    const p = await env.DB.prepare('SELECT * FROM players WHERE ml_user_id = ?1 AND ml_server_id = ?2 AND tiktok_lower = ?3 LIMIT 1')
      .bind(uid, sid, handle).first();
    return p ? { player: p } : { notfound: true };
  }
  const name = cleanIgn(body.ign).toLowerCase();
  if (name.length < 3) return { bad: 'Enter your display name.' };
  const sid = String(body.serverId || '').trim();
  const rows = (await env.DB.prepare('SELECT * FROM players WHERE ml_user_id = ?1').bind(uid).all()).results
    .filter((p) => cleanIgn(p.ign).toLowerCase() === name && (!sid || p.ml_server_id === sid));
  if (rows.length === 1) return { player: rows[0] };
  if (rows.length > 1) return { needServer: true };
  return { notfound: true };
}

const renameState = async (env, pid, kind = 'name') => {
  const r = await env.DB.prepare('SELECT status, new_name, reject_reason FROM name_requests WHERE player_id = ?1 AND kind = ?2 ORDER BY id DESC LIMIT 1').bind(pid, kind).first();
  return r ? { status: r.status, new_name: r.new_name, reason: r.reject_reason || '' } : null;
};

// Shared by /api/enter and /api/rename-request: rate limit, verify, return the player.
async function authenticate(request, env, body, now) {
  const device = await deviceHashFor(request);
  const locked = await loginLockedMinutes(env, device, now);
  if (locked) {
    return { error: json({ ok: false, code: 'locked', error: `Too many wrong tries. Try again in about ${locked} minute${locked === 1 ? '' : 's'}.` }, 429) };
  }
  const v = await verifyPlayer(env, body);
  if (v.bad) return { error: json({ ok: false, code: 'account', error: v.bad }, 400) };
  if (v.needServer) {
    return { error: json({ ok: false, code: 'need_server', error: 'More than one account matches. Please add your Server ID.' }, 409) };
  }
  if (v.notfound) {
    await loginFailed(env, device, now);
    return { error: json({ ok: false, code: 'notfound', error: "We couldn't match those details. Check them, or try the other way in." }, 404) };
  }
  await loginOk(env, device);
  return { player: v.player, device };
}

async function handleEnter(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const { body, error } = await readBody(request, 3000);
  if (error) return error;
  const now = Date.now();
  if (config.self_enter === 'off') {
    return json({ ok: false, code: 'selfoff', error: 'The host is adding players manually for this giveaway.' }, 403);
  }
  if (config.registration_gate !== 'open') return json({ ok: false, code: 'closed', error: 'No giveaway is open right now.' }, 403);
  const giveaway = await findOpenGiveaway(env, now);
  if (!giveaway) return json({ ok: false, code: 'closed', error: 'Registration is closed right now.' }, 403);

  const auth = await authenticate(request, env, body, now);
  if (auth.error) return auth.error;
  const p = auth.player;
  if (await playerBanned(env, p)) {
    return json({ ok: false, code: 'banned', error: 'This account is permanently banned from the wheel.' }, 403);
  }
  const dq = await env.DB.prepare('SELECT 1 AS hit FROM disqualified_entries WHERE giveaway_id = ?1 AND tiktok_lower = ?2 LIMIT 1')
    .bind(giveaway.id, p.tracking_lower).first();
  if (dq) return json({ ok: false, code: 'disqualified', error: 'This account was disqualified from this giveaway.' }, 403);
  const added = await enrollPlayer(env, giveaway.id, p, 'self', auth.device, now);
  return json({ ok: true, ign: p.ign, already: !added, rename: await renameState(env, p.id), tiktok: await renameState(env, p.id, 'tiktok') });
}

async function handleRenameRequest(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const { body, error } = await readBody(request, 3000);
  if (error) return error;
  const now = Date.now();
  const auth = await authenticate(request, env, body, now);
  if (auth.error) return auth.error;
  const p = auth.player;
  // kind "name" changes the display name on the wheel; kind "tiktok" changes the registered TikTok @username.
  // Either way the host must approve it, and everything is validated here, never trusted from the browser.
  const kind = body.kind === 'tiktok' ? 'tiktok' : 'name';
  const raw = body.value !== undefined ? body.value : body.newName;
  let next;
  if (kind === 'tiktok') {
    next = String(raw || '').trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_.]{2,24}$/.test(next)) {
      return json({ ok: false, code: 'account', error: 'Enter your TikTok @username (letters, numbers, dots and underscores).' }, 400);
    }
    if (next.toLowerCase() === p.tiktok_lower) return json({ ok: false, code: 'same', error: 'That is already your TikTok @username.' }, 400);
    if (await handleTaken(env, next.toLowerCase(), p.ml_user_id, p.ml_server_id)) {
      return json({ ok: false, code: 'tiktok_taken', error: 'That TikTok @username is already linked to another Mobile Legends account.' }, 409);
    }
  } else {
    next = cleanIgn(raw);
    if (!validIgn(next)) return json({ ok: false, code: 'account', error: 'Enter a display name of 3-24 characters.' }, 400);
    if (next === p.ign) return json({ ok: false, code: 'same', error: 'That is already your display name.' }, 400);
  }
  const oldValue = kind === 'tiktok' ? p.tiktok_username : p.ign;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM name_requests WHERE player_id = ?1 AND kind = ?2 AND status = 'pending'").bind(p.id, kind),
    env.DB.prepare("INSERT INTO name_requests (player_id, kind, old_name, new_name, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)").bind(p.id, kind, oldValue, next, now)
  ]);
  return json({ ok: true, kind, rename: { status: 'pending', new_name: next, reason: '' } });
}

// ---- Helper bot (rules and answers live in llm.js + llm.json; this only serves them) ----
const BOT_MAX = 40;
const BOT_WINDOW_MS = 10 * 60 * 1000;
const botAllowed = async (env, device, now) => {
  await env.DB.prepare(
    `INSERT INTO bot_usage (device_hash, n, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(device_hash) DO UPDATE SET
       n = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE n + 1 END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`
  ).bind(device, now, BOT_WINDOW_MS).run();
  const row = await env.DB.prepare('SELECT n FROM bot_usage WHERE device_hash = ?1').bind(device).first();
  return !!row && row.n <= BOT_MAX;
};

async function handleBot(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!BOT.enabled) return json({ ok: false, code: 'off', error: 'The helper is turned off right now.' }, 503);
  const { body, error } = await readBody(request, 2000);
  if (error) return error;
  const now = Date.now();
  const config = await readConfig(env);
  const streamer = streamerFrom(config);
  const vars = { ...(KB.vars || {}), streamer_name: streamer.name, streamer_username: streamer.username, status: '' };

  if (body.init === true) {
    return json({ ok: true, name: BOT.name, text: fill(BOT.greeting, vars), suggestions: BOT.quick });
  }

  const device = await deviceHashFor(request);
  if (!(await botAllowed(env, device, now))) {
    return json({ ok: false, code: 'slow', error: 'You are sending messages too fast. Please wait a few minutes.' }, 429);
  }
  const out = BOT.reply(body.message);
  if (!out) return json({ ok: false, code: 'empty', error: 'Type a question first.' }, 400);
  if (out.text.includes('{status}')) {
    const open = config.registration_gate === 'open' && !!(await findOpenGiveaway(env, now));
    vars.status = open ? 'Registration is open right now.' : 'Registration is closed right now.';
  }
  return json({ ok: true, type: out.type, kind: out.kind, text: fill(out.text, vars), suggestions: out.suggestions });
}

async function handlePlayerCheck(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const { body, error } = await readBody(request, 2000);
  if (error) return error;
  const uid = String(body.userId || '').trim();
  const sid = String(body.serverId || '').trim();
  if (!/^\d{5,12}$/.test(uid) || !/^\d{3,6}$/.test(sid)) return json({ ok: false, error: 'Bad request.' }, 400);
  const p = await findPlayerByMl(env, uid, sid);
  return json({ ok: true, registered: !!p });
}

async function handleApply(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const { body, error } = await readBody(request, MAX_APPLY_BODY);
  if (error) return error;
  const now = Date.now();

  const gate = await gatekeep(env, config, body, now);
  if (gate.error) return gate.error;
  const { giveaway, roblox, tiktok, rl, tl } = gate;
  if (body.terms !== true) {
    return json({ ok: false, code: 'terms', error: 'You must accept the Terms and Conditions to enter.' }, 400);
  }

  const shot = String(body.screenshot || '');
  if (shot.length > MAX_SHOT_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot)) {
    return json({ ok: false, error: 'The screenshot is missing or too large.' }, 400);
  }

  const { uid, sid } = gate;
  const known = await findPlayerByMl(env, uid, sid);
  if (known) return json({ ok: false, code: 'registered', error: 'You are already registered. Use the Enter tab.' }, 409);
  if (await handleTaken(env, tl, uid, sid)) {
    return json({ ok: false, code: 'tiktok_taken', error: 'That TikTok username is already linked to another Mobile Legends account. Ask the host for help.' }, 409);
  }
  const waiting = await env.DB.prepare(
    "SELECT 1 AS hit FROM manual_applications WHERE status = 'pending' AND ml_user_id = ?1 AND ml_server_id = ?2 LIMIT 1"
  ).bind(uid, sid).first();
  if (waiting) return json({ ok: false, code: 'pending', error: 'You already have an application waiting for the host.' }, 409);

  const key = randomHex(16);
  const device = await deviceHashFor(request);
  const r = await env.DB.prepare(
    `INSERT INTO manual_applications (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, ml_user_id, ml_server_id, note, reason, ocr_excerpt, device_hash, screenshot, check_key, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?14, ?15, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12
     WHERE (SELECT COUNT(*) FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending') < ?13`
  ).bind(
    giveaway.id, roblox, rl, tiktok, tl,
    cleanLine(body.note, 300), cleanLine(body.reason, 200), cleanOcr(body.ocrText).slice(0, 600),
    device, shot, key, now, MAX_PENDING_APPS, uid, sid
  ).run();
  if (r.meta.changes !== 1) {
    return json({ ok: false, code: 'busy', error: 'Too many manual applications are waiting right now. Please try again in a few minutes.' }, 429);
  }
  return json({ ok: true, id: r.meta.last_row_id, key });
}

async function handleApplyStatus(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const id = Number(url.searchParams.get('id'));
  const key = String(url.searchParams.get('key') || '');
  if (!Number.isInteger(id) || !/^[a-f0-9]{16,64}$/.test(key)) return json({ ok: false, error: 'Bad request.' }, 400);
  const row = await env.DB.prepare('SELECT status, reject_reason FROM manual_applications WHERE id = ?1 AND check_key = ?2')
    .bind(id, key).first();
  if (!row) return json({ ok: true, status: 'removed', reason: '' });
  return json({ ok: true, status: row.status, reason: row.reject_reason || '' });
}

async function handleRegistration(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const config = await readConfig(env);
  const open = config.registration_gate === 'open' && !!(await findOpenGiveaway(env, Date.now()));
  return json({ ok: true, open, streamer: streamerFrom(config), selfEnter: config.self_enter !== 'off' });
}

async function handlePublicList(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const now = Date.now();
  if (listCache.body && now - listCache.at < LIST_TTL_MS) return jsonText(listCache.body);
  const [entries, alerts, cfg, live] = await env.DB.batch([
    env.DB.prepare(
      "SELECT roblox_username AS name, status FROM qualified_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE status NOT IN ('ended', 'saved')) ORDER BY id ASC"
    ),
    env.DB.prepare('SELECT id, message, created_at FROM live_alerts WHERE created_at > ?1 ORDER BY id DESC LIMIT 5').bind(
      now - ALERT_TTL_MS
    ),
    env.DB.prepare(
      "SELECT key, value FROM system_config WHERE key IN ('wheel_command','force_reset','last_landed','spin_id','registration_gate','out_list')"
    ),
    env.DB.prepare("SELECT status, expires_at FROM giveaways WHERE status NOT IN ('ended', 'saved') ORDER BY id DESC LIMIT 1")
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  const g = live.results[0];
  const registration = !g ? 'none' : g.status === 'open' && g.expires_at > now && c.registration_gate === 'open' ? 'open' : 'closed';
  let outList = [];
  try {
    outList = JSON.parse(c.out_list || '[]');
  } catch {
    outList = [];
  }
  const payload = JSON.stringify({
    ok: true,
    registration,
    out: Array.isArray(outList) ? outList : [],
    entries: entries.results,
    alerts: alerts.results,
    command: c.wheel_command || 'idle',
    spin_id: Number(c.spin_id || 0),
    target: c.last_landed || '',
    force_reset: c.force_reset === 'true',
    gate: c.registration_gate || 'open'
  });
  listCache = { at: now, body: payload };
  return jsonText(payload);
}

async function handleOwnerAction(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!(await isOwner(request, env))) return json({ ok: false, error: 'Unauthorized.' }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (body.action === 'verify') return json({ ok: true });
  if (body.action !== 'metrics') return json({ ok: false, error: 'Unknown action.' }, 400);

  const now = Date.now();
  const g = await env.DB.prepare(
    "SELECT id, status, opened_at, expires_at, ended_at FROM giveaways WHERE status != 'saved' ORDER BY id DESC LIMIT 1"
  ).first();
  const gid = g ? g.id : 0;
  const [totals, timeline, apps, disq, shared, levels, counts, cfg, alerts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'alive'), 0) AS alive,
              COALESCE(SUM(status = 'winner'), 0) AS winners,
              COALESCE(SUM(source = 'ocr'), 0) AS ocr,
              COALESCE(SUM(source = 'manual'), 0) AS manual,
              COALESCE(SUM(source = 'manual-approved'), 0) AS approved,
              COALESCE(ROUND(AVG(CASE WHEN level > 0 THEN level END), 1), 0) AS avg_level,
              COALESCE(MAX(level), 0) AS max_level
       FROM qualified_entries WHERE giveaway_id = ?1`
    ).bind(gid),
    env.DB.prepare(
      'SELECT (created_at / 300000) * 300000 AS t, COUNT(*) AS n FROM qualified_entries WHERE giveaway_id = ?1 GROUP BY t ORDER BY t ASC LIMIT 400'
    ).bind(gid),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM manual_applications WHERE giveaway_id = ?1 GROUP BY status').bind(gid),
    env.DB.prepare('SELECT reason, COUNT(*) AS n FROM disqualified_entries WHERE giveaway_id = ?1 GROUP BY reason ORDER BY n DESC').bind(gid),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT device_hash FROM qualified_entries WHERE giveaway_id = ?1 AND device_hash != '' GROUP BY device_hash HAVING COUNT(*) > 1)"
    ).bind(gid),
    env.DB.prepare(
      `SELECT CASE WHEN level >= 50 THEN '50+' WHEN level >= 20 THEN '20-49' WHEN level >= 10 THEN '10-19' WHEN level >= 5 THEN '5-9' ELSE 'unscanned' END AS band,
              COUNT(*) AS n
       FROM qualified_entries WHERE giveaway_id = ?1 GROUP BY band`
    ).bind(gid),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM qualified_entries) AS qualified,
              (SELECT COUNT(*) FROM disqualified_entries) AS disqualified,
              (SELECT COUNT(*) FROM manual_applications) AS applications,
              (SELECT COUNT(*) FROM giveaways) AS giveaways,
              (SELECT COUNT(*) FROM giveaways WHERE status = 'saved') AS saved,
              (SELECT COUNT(*) FROM live_alerts) AS alerts,
              (SELECT COUNT(*) FROM permanent_blacklist) AS bans,
              (SELECT COALESCE(SUM(LENGTH(screenshot)), 0) FROM manual_applications) AS screenshot_bytes`
    ),
    env.DB.prepare("SELECT key, value FROM system_config WHERE key IN ('wheel_command','spin_id','last_landed','registration_gate')"),
    env.DB.prepare('SELECT message, created_at FROM live_alerts ORDER BY id DESC LIMIT 5')
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  const appStatus = {};
  for (const row of apps.results) appStatus[row.status] = row.n;
  let effective = g ? g.status : 'none';
  if (g && g.status === 'open' && g.expires_at <= now) effective = 'expired';
  return json({
    ok: true,
    now,
    giveaway: g ? { ...g, effective } : null,
    entries: totals.results[0],
    timeline: timeline.results,
    applications: appStatus,
    disqualified: disq.results,
    shared_devices: shared.results[0] ? shared.results[0].n : 0,
    levels: levels.results,
    storage: counts.results[0],
    wheel: {
      command: c.wheel_command || 'idle',
      spins: Number(c.spin_id || 0),
      last_landed: c.last_landed || '',
      gate: c.registration_gate || 'open'
    },
    alerts: alerts.results
  });
}

async function handleStreamAction(request, env, url) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const allowed = (await matchesToken(request, env.STREAM_TOKEN)) || (await matchesToken(request, env.STREAMER_TOKEN));
  if (!allowed) return json({ ok: false, error: 'Unauthorized.' }, 401);
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }
  if (!STREAM_ACTIONS.has(body.action)) {
    return json({ ok: false, error: 'That action is only available in the admin panel.' }, 403);
  }
  if (body.action === 'verify') return json({ ok: true });
  return handleAdminAction(request, env, url, true);
}

async function handleAdminAction(request, env, url, authed = false) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!authed && !(await isAdmin(request, env, url))) return json({ ok: false, error: 'Unauthorized.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }
  const now = Date.now();
  const noGiveaway = () => json({ ok: false, error: 'There is no active giveaway. Open one first.' }, 409);

  switch (body.action) {
    case 'verify':
      return json({ ok: true });

    case 'get_state': {
      await expireGiveaways(env, now);
      const latest = await env.DB.prepare(
        "SELECT id, status, opened_at, expires_at, ended_at FROM giveaways WHERE status != 'saved' ORDER BY id DESC LIMIT 1"
      ).first();
      const gid = latest ? latest.id : 0;
      const cfgSelf = ((await env.DB.prepare("SELECT value FROM system_config WHERE key = 'self_enter'").first()) || {}).value || 'on';
      const [mq, md, ma, mal, wheelCfg, savedFp, nrFp] = await env.DB.batch([
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM qualified_entries'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM disqualified_entries'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM manual_applications'),
        env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM live_alerts'),
        env.DB.prepare(
          "SELECT key, value FROM system_config WHERE key IN ('spin_id','wheel_command','last_landed','force_reset') ORDER BY key"
        ),
        env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM giveaways WHERE status = 'saved'"),
        env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m, COALESCE(SUM(status = 'pending'), 0) AS p FROM name_requests")
      ]);
      const fp = [
        gid, latest ? latest.status : 'none', mq.results[0].m, md.results[0].m, ma.results[0].m, mal.results[0].m,
        wheelCfg.results.map((r) => r.value).join('~'),
        `${savedFp.results[0].n}:${savedFp.results[0].m}`,
        `${nrFp.results[0].m}:${nrFp.results[0].p}`,
        cfgSelf
      ].join('.');
      if (!body.force && body.fp && body.fp === fp) {
        return json({ ok: true, unchanged: true, fp, giveaway: latest || null, now });
      }
      const cfgAll = await readConfig(env);
      const nrRows = (await env.DB.prepare(
        `SELECT r.id, r.kind, r.old_name, r.new_name, r.created_at, p.tracking_id, p.ml_user_id, p.ml_server_id
         FROM name_requests r JOIN players p ON p.id = r.player_id WHERE r.status = 'pending' ORDER BY r.id ASC LIMIT 100`
      ).all()).results;
      const taken = new Set((await env.DB.prepare('SELECT roblox_lower FROM qualified_entries WHERE giveaway_id = ?1').bind(gid).all()).results.map((x) => x.roblox_lower));
      const nameRequests = [];
      for (const r of nrRows) {
        const clash = r.kind === 'tiktok'
          ? !!(await handleTaken(env, r.new_name.toLowerCase(), r.ml_user_id, r.ml_server_id))
          : taken.has(r.new_name.toLowerCase());
        nameRequests.push({ id: r.id, kind: r.kind, old_name: r.old_name, new_name: r.new_name, created_at: r.created_at, tracking_id: r.tracking_id, clash });
      }
      const [q, d, b, a, apps, savedList] = await env.DB.batch([
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, tiktok_lower, level, status, source, device_hash, created_at FROM qualified_entries WHERE giveaway_id = ?1 ORDER BY id ASC'
        ).bind(gid),
        env.DB.prepare(
          'SELECT id, roblox_username, tiktok_username, tiktok_lower, reason, disqualified_at FROM disqualified_entries WHERE giveaway_id = ?1 ORDER BY id DESC LIMIT 500'
        ).bind(gid),
        env.DB.prepare('SELECT id, username, reason, banned_at FROM permanent_blacklist ORDER BY id DESC LIMIT 500'),
        env.DB.prepare('SELECT id, message, created_at FROM live_alerts ORDER BY id DESC LIMIT 20'),
        env.DB.prepare(
          `SELECT a.id, a.roblox_username, a.tiktok_username, a.ml_user_id, a.ml_server_id, a.note, a.reason, a.ocr_excerpt, a.device_hash, a.created_at,
                  EXISTS (SELECT 1 FROM qualified_entries q WHERE q.giveaway_id = a.giveaway_id AND (q.roblox_lower = a.roblox_lower OR q.tiktok_lower = a.tiktok_lower)) AS dup
           FROM manual_applications a WHERE a.giveaway_id = ?1 AND a.status = 'pending' ORDER BY a.id ASC LIMIT 300`
        ).bind(gid),
        env.DB.prepare(
          `SELECT g.id, g.opened_at, g.ended_at,
                  (SELECT COUNT(*) FROM qualified_entries q WHERE q.giveaway_id = g.id) AS entries,
                  (SELECT COUNT(*) FROM disqualified_entries x WHERE x.giveaway_id = g.id) AS disqualified,
                  (SELECT COUNT(*) FROM manual_applications m WHERE m.giveaway_id = g.id AND m.status = 'pending') AS pending
           FROM giveaways g WHERE g.status = 'saved' ORDER BY g.id DESC LIMIT 20`
        )
      ]);
      return json({
        ok: true,
        fp,
        giveaway: latest || null,
        qualified: q.results,
        disqualified: d.results,
        blacklist: b.results,
        alerts: a.results,
        applications: apps.results,
        saved: savedList.results,
        config: cfgAll,
        name_requests: nameRequests,
        streamer: streamerFrom(cfgAll),
        now
      });
    }

    case 'open_giveaway': {
      if (await activeGiveaway(env)) {
        return json({ ok: false, error: 'A giveaway is already active. End it before opening a new one.' }, 409);
      }
      const expires = now + TOKEN_TTL_MS;
      await env.DB.batch([
        ...purgeEndedStatements(env),
        env.DB.prepare("INSERT INTO giveaways (token_hash, status, opened_at, expires_at) VALUES ('', 'open', ?1, ?2)").bind(
          now, expires
        ),
        setConfig(env, 'registration_gate', 'open'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true, expires_at: expires });
    }

    case 'close_registration': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      await env.DB.batch([
        env.DB.prepare("UPDATE giveaways SET status = 'closed', token_hash = '' WHERE id = ?1 AND status = 'open'").bind(g.id),
        setConfig(env, 'registration_gate', 'closed')
      ]);
      return json({ ok: true });
    }

    case 'end_giveaway': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      await env.DB.batch([
        env.DB.prepare("UPDATE giveaways SET status = 'ended', token_hash = '', ended_at = ?2 WHERE id = ?1").bind(g.id, now),
        env.DB.prepare(
          "UPDATE manual_applications SET status = 'rejected', reject_reason = 'The giveaway ended.', screenshot = '', decided_at = ?2 WHERE giveaway_id = ?1 AND status = 'pending'"
        ).bind(g.id, now),
        setConfig(env, 'registration_gate', 'closed'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true });
    }

    case 'save_and_new': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const [won, cfgRows] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM qualified_entries WHERE giveaway_id = ?1 AND status = 'winner'").bind(g.id),
        env.DB.prepare("SELECT key, value FROM system_config WHERE key IN ('wheel_command', 'out_list')")
      ]);
      const cfgMap = {};
      for (const r of cfgRows.results) cfgMap[r.key] = r.value;
      let outCount = 0;
      try {
        outCount = JSON.parse(cfgMap.out_list || '[]').length;
      } catch {
        outCount = 0;
      }
      if (won.results[0].n > 0 || outCount > 0 || ['spin_winner', 'spin_elim'].includes(cfgMap.wheel_command)) {
        return json({ ok: false, code: 'spun', error: 'The wheel has already been spun for this giveaway. End it instead, or reset the wheel first.' }, 409);
      }
      const carry = body.carry === true;
      const expires = now + TOKEN_TTL_MS;
      const NEW = '(SELECT MAX(id) FROM giveaways)';
      const stmts = [
        ...purgeEndedStatements(env),
        env.DB.prepare("UPDATE giveaways SET status = 'saved', token_hash = '', ended_at = ?2 WHERE id = ?1").bind(g.id, now),
        env.DB.prepare("INSERT INTO giveaways (token_hash, status, opened_at, expires_at) VALUES ('', 'open', ?1, ?2)").bind(now, expires)
      ];
      const copyAt = stmts.length;
      if (carry) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
             SELECT ${NEW}, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, 'alive', source, created_at
             FROM qualified_entries WHERE giveaway_id = ?1`
          ).bind(g.id),
          env.DB.prepare(
            `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
             SELECT ${NEW}, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at
             FROM disqualified_entries WHERE giveaway_id = ?1`
          ).bind(g.id),
          env.DB.prepare(`UPDATE manual_applications SET giveaway_id = ${NEW} WHERE giveaway_id = ?1 AND status = 'pending'`).bind(g.id)
        );
      }
      stmts.push(
        setConfig(env, 'registration_gate', 'open'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      );
      const results = await env.DB.batch(stmts);
      return json({
        ok: true,
        expires_at: expires,
        carried: carry
          ? {
              entries: results[copyAt].meta.changes,
              disqualified: results[copyAt + 1].meta.changes,
              applications: results[copyAt + 2].meta.changes
            }
          : null
      });
    }

    case 'migrate_in': {
      const target = await activeGiveaway(env);
      if (!target) return noGiveaway();
      const sid = Number(body.id);
      if (!Number.isInteger(sid)) return json({ ok: false, error: 'Invalid session.' }, 400);
      const src = await env.DB.prepare("SELECT id FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid).first();
      if (!src) return json({ ok: false, error: 'That saved session no longer exists.' }, 404);
      const [dq, ent] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
           SELECT ?1, s.roblox_username, s.roblox_lower, s.tiktok_username, s.tiktok_lower, s.reason, s.device_hash, s.disqualified_at
           FROM disqualified_entries s
           WHERE s.giveaway_id = ?2
             AND NOT EXISTS (SELECT 1 FROM disqualified_entries x WHERE x.giveaway_id = ?1 AND (x.roblox_lower = s.roblox_lower OR x.tiktok_lower = s.tiktok_lower))
             AND NOT EXISTS (SELECT 1 FROM qualified_entries t WHERE t.giveaway_id = ?1 AND (t.roblox_lower = s.roblox_lower OR t.tiktok_lower = s.tiktok_lower))`
        ).bind(target.id, sid),
        env.DB.prepare(
          `INSERT INTO qualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, level, device_hash, status, source, created_at)
           SELECT ?1, s.roblox_username, s.roblox_lower, s.tiktok_username, s.tiktok_lower, s.level, s.device_hash, 'alive', s.source, s.created_at
           FROM qualified_entries s
           WHERE s.giveaway_id = ?2
             AND NOT EXISTS (SELECT 1 FROM qualified_entries t WHERE t.giveaway_id = ?1 AND (t.roblox_lower = s.roblox_lower OR t.tiktok_lower = s.tiktok_lower))
             AND NOT EXISTS (SELECT 1 FROM disqualified_entries x WHERE x.giveaway_id = ?1 AND (x.roblox_lower = s.roblox_lower OR x.tiktok_lower = s.tiktok_lower))
             AND s.roblox_lower NOT IN (SELECT username_lower FROM permanent_blacklist)
             AND s.tiktok_lower NOT IN (SELECT username_lower FROM permanent_blacklist)`
        ).bind(target.id, sid)
      ]);
      return json({ ok: true, entries: ent.meta.changes, disqualified: dq.meta.changes });
    }

    case 'delete_saved': {
      const sid = Number(body.id);
      if (!Number.isInteger(sid)) return json({ ok: false, error: 'Invalid session.' }, 400);
      const src = await env.DB.prepare("SELECT id FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid).first();
      if (!src) return json({ ok: false, error: 'That saved session no longer exists.' }, 404);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM manual_applications WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare('DELETE FROM qualified_entries WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare('DELETE FROM disqualified_entries WHERE giveaway_id = ?1').bind(sid),
        env.DB.prepare("DELETE FROM giveaways WHERE id = ?1 AND status = 'saved'").bind(sid)
      ]);
      return json({ ok: true });
    }

    case 'purge_ended':
      await env.DB.batch(purgeEndedStatements(env));
      return json({ ok: true });

    case 'spin_winner': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const out = await currentOut(env);
      const pick = await pickAlive(env, g.id, out);
      if (!pick) return json({ ok: false, error: 'No survivors left to crown.' }, 409);
      if (!(await claimSpin(env, now))) return json({ ok: false, error: 'A spin is already in progress. Wait a few seconds.' }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'winner' WHERE giveaway_id = ?1 AND roblox_lower = ?2").bind(
          g.id, pick.roblox_lower
        ),
        setConfig(env, 'out_list', JSON.stringify(out)),
        setConfig(env, 'wheel_command', 'spin_winner'),
        setConfig(env, 'last_landed', pick.roblox_username),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true, winner: pick.roblox_username, tracking_id: String(pick.tiktok_lower || '').toUpperCase() });
    }

    case 'spin_elim': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const out = await currentOut(env);
      const pick = await pickAlive(env, g.id, out);
      if (!pick) return json({ ok: false, error: 'Nobody is left to knock out.' }, 409);
      if (!(await claimSpin(env, now))) return json({ ok: false, error: 'A spin is already in progress. Wait a few seconds.' }, 409);
      await env.DB.batch([
        setConfig(env, 'out_list', JSON.stringify(out)),
        setConfig(env, 'wheel_command', 'spin_elim'),
        setConfig(env, 'last_landed', pick.roblox_username),
        setConfig(env, 'force_reset', 'false'),
        bumpSpin(env)
      ]);
      return json({ ok: true, target: pick.roblox_username, tracking_id: String(pick.tiktok_lower || '').toUpperCase() });
    }

    case 'reset_wheel':
      await env.DB.batch([
        env.DB.prepare("UPDATE qualified_entries SET status = 'alive'"),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true });

    case 'perm_ban': {
      const username = String(body.username || '').trim();
      if (!validIgn(username)) return json({ ok: false, error: 'Invalid name.' }, 400);
      const lower = cleanIgn(username).toLowerCase();
      const reason = cleanLine(body.reason || 'admin ban', 200);
      const pl = await env.DB.prepare('SELECT * FROM players WHERE tracking_lower = ?1 OR tiktok_lower = ?1 LIMIT 1').bind(lower).first();
      const ban = (name) =>
        env.DB.prepare('INSERT OR IGNORE INTO permanent_blacklist (username, username_lower, reason, banned_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(name, name.toLowerCase(), reason, now);
      const stmts = [ban(username)];
      if (pl) {
        // Banning a registered player blocks their tracking ID, TikTok name and Mobile Legends account together.
        stmts.push(ban(pl.tracking_id), ban(pl.tiktok_username), ban(`${pl.ml_user_id}-${pl.ml_server_id}`));
        stmts.push(env.DB.prepare('DELETE FROM qualified_entries WHERE tiktok_lower = ?1').bind(pl.tracking_lower));
        stmts.push(env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND ml_user_id = ?1 AND ml_server_id = ?2").bind(pl.ml_user_id, pl.ml_server_id));
      }
      stmts.push(
        env.DB.prepare('DELETE FROM qualified_entries WHERE roblox_lower = ?1 OR tiktok_lower = ?1').bind(lower),
        env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND (roblox_lower = ?1 OR tiktok_lower = ?1)").bind(lower)
      );
      await env.DB.batch(stmts);
      return json({ ok: true });
    }

    case 'disqualify': {
      const allowed = ['multiple entries', 'fake screenshot', 'other'];
      const reasonKey = allowed.includes(body.reason) ? body.reason : 'other';
      const reason = `manual: ${reasonKey}`;
      let existing = null;
      let gid = 0;
      let ru;
      let rl;
      if (body.id !== undefined && body.id !== null && body.id !== '' && Number.isInteger(Number(body.id))) {
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE id = ?1').bind(Number(body.id)).first();
        if (!existing) return json({ ok: false, error: 'That entry no longer exists.' }, 404);
        gid = existing.giveaway_id;
        ru = existing.roblox_username;
        rl = existing.roblox_lower;
      } else {
        const g = await activeGiveaway(env);
        if (!g) return noGiveaway();
        gid = g.id;
        ru = cleanIgn(body.roblox);
        if (!validIgn(ru)) return json({ ok: false, error: 'Enter a valid IGN.' }, 400);
        rl = ru.toLowerCase();
        existing = await env.DB.prepare('SELECT * FROM qualified_entries WHERE giveaway_id = ?1 AND roblox_lower = ?2').bind(gid, rl).first();
      }
      const tu = existing ? existing.tiktok_username : '(unknown)';
      const tl = existing ? existing.tiktok_lower : '(unknown)';
      const device = existing ? existing.device_hash || '' : '';
      const statements = [
        env.DB.prepare(
          `INSERT INTO disqualified_entries (giveaway_id, roblox_username, roblox_lower, tiktok_username, tiktok_lower, reason, device_hash, disqualified_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(gid, ru, rl, tu, tl, reason, device, now),
        env.DB.prepare("DELETE FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending' AND (roblox_lower = ?2 OR tiktok_lower = ?3)").bind(gid, rl, tl),
        env.DB.prepare('INSERT INTO live_alerts (message, created_at) VALUES (?1, ?2)').bind(`🚨 DISQUALIFIED: ${ru} (${reasonKey})`, now)
      ];
      if (existing) statements.push(env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(existing.id));
      await env.DB.batch(statements);
      return json({ ok: true });
    }

    case 'manual_add': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const acct = parseAccount(body);
      if (acct.error) return json({ ok: false, error: acct.error }, 400);
      const clash = await handleTaken(env, acct.tl, acct.uid, acct.sid);
      if (clash) return json({ ok: false, error: `That TikTok username belongs to another player (${clash.tracking_id}).` }, 409);
      const { player } = await createPlayer(env, acct, 'host', now);
      await env.DB.prepare('DELETE FROM disqualified_entries WHERE giveaway_id = ?1 AND tiktok_lower = ?2').bind(g.id, player.tracking_lower).run();
      if (!(await enrollPlayer(env, g.id, player, 'manual', '', now))) {
        return json({ ok: false, error: 'That player is already on the wheel.' }, 409);
      }
      return json({ ok: true, tracking_id: player.tracking_id });
    }

    case 'set_self_enter': {
      await setConfig(env, 'self_enter', body.on === false ? 'off' : 'on').run();
      return json({ ok: true });
    }

    case 'name_approve': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid request.' }, 400);
      const r = await env.DB.prepare("SELECT * FROM name_requests WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!r) return json({ ok: false, error: 'That request is no longer pending.' }, 404);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(r.player_id).first();
      if (!p) return json({ ok: false, error: 'That player no longer exists.' }, 404);
      if (r.kind === 'tiktok') {
        const taken = await handleTaken(env, r.new_name.toLowerCase(), p.ml_user_id, p.ml_server_id);
        if (taken) return json({ ok: false, error: `That @username now belongs to another player (${taken.tracking_id}).` }, 409);
        await env.DB.batch([
          env.DB.prepare('UPDATE players SET tiktok_username = ?2, tiktok_lower = ?3 WHERE id = ?1').bind(p.id, r.new_name, r.new_name.toLowerCase()),
          env.DB.prepare('UPDATE qualified_entries SET tiktok_username = ?2 WHERE tiktok_lower = ?1').bind(p.tracking_lower, r.new_name),
          env.DB.prepare("UPDATE name_requests SET status = 'approved', decided_at = ?2 WHERE id = ?1").bind(id, now)
        ]);
        return json({ ok: true });
      }
      const next = r.new_name;
      const stmts = [
        env.DB.prepare('UPDATE players SET ign = ?2 WHERE id = ?1').bind(p.id, next),
        env.DB.prepare("UPDATE name_requests SET status = 'approved', decided_at = ?2 WHERE id = ?1").bind(id, now)
      ];
      const live = (await env.DB.prepare(
        "SELECT id, giveaway_id FROM qualified_entries WHERE tiktok_lower = ?1 AND giveaway_id IN (SELECT id FROM giveaways WHERE status NOT IN ('ended', 'saved'))"
      ).bind(p.tracking_lower).all()).results;
      for (const e of live) {
        const clash = await env.DB.prepare(
          'SELECT 1 AS hit FROM qualified_entries WHERE giveaway_id = ?1 AND roblox_lower = ?2 AND tiktok_lower != ?3 LIMIT 1'
        ).bind(e.giveaway_id, next.toLowerCase(), p.tracking_lower).first();
        const shown = clash ? `${next} #${p.tracking_id.slice(-4)}` : next;
        stmts.push(env.DB.prepare('UPDATE qualified_entries SET roblox_username = ?2, roblox_lower = ?3 WHERE id = ?1').bind(e.id, shown, shown.toLowerCase()));
      }
      await env.DB.batch(stmts);
      return json({ ok: true });
    }

    case 'name_reject': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid request.' }, 400);
      const r = await env.DB.prepare("SELECT id FROM name_requests WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!r) return json({ ok: false, error: 'That request is no longer pending.' }, 404);
      await env.DB.prepare("UPDATE name_requests SET status = 'rejected', reject_reason = ?2, decided_at = ?3 WHERE id = ?1")
        .bind(id, cleanLine(body.reason, 150), now).run();
      return json({ ok: true });
    }

    case 'search_players': {
      const g = await activeGiveaway(env);
      const gid = g ? g.id : 0;
      const uid = String(body.userId || '').replace(/\D/g, '');
      const sid = String(body.serverId || '').replace(/\D/g, '');
      const q = String(body.q || '').trim().toLowerCase().replace(/[%_\\]/g, '').slice(0, 40);
      let where = '1 = 1';
      const args = [];
      if (uid && sid) { where = 'p.ml_user_id = ?2 AND p.ml_server_id = ?3'; args.push(uid, sid); }
      else if (uid) { where = 'p.ml_user_id = ?2'; args.push(uid); }
      else if (q) { where = "(p.tracking_lower LIKE ?2 OR lower(p.ign) LIKE ?2 OR p.tiktok_lower LIKE ?2 OR p.ml_user_id LIKE ?2)"; args.push(`%${q}%`); }
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.tracking_id, p.ml_user_id, p.ml_server_id, p.ign, p.tiktok_username, p.source, p.created_at,
                EXISTS (SELECT 1 FROM qualified_entries e WHERE e.giveaway_id = ?1 AND e.tiktok_lower = p.tracking_lower) AS enrolled,
                EXISTS (SELECT 1 FROM qualified_entries e WHERE e.giveaway_id = ?1 AND e.tiktok_lower = p.tracking_lower AND e.status = 'winner') AS won
         FROM players p WHERE ${where} ORDER BY p.id DESC LIMIT 30`
      ).bind(gid, ...args).all();
      return json({ ok: true, players: results, giveaway: !!g });
    }

    case 'enroll_player': {
      const g = await activeGiveaway(env);
      if (!g) return noGiveaway();
      const pid = Number(body.id);
      if (!Number.isInteger(pid)) return json({ ok: false, error: 'Invalid player.' }, 400);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(pid).first();
      if (!p) return json({ ok: false, error: 'That player no longer exists.' }, 404);
      if (await playerBanned(env, p)) return json({ ok: false, error: 'This player is permanently banned.' }, 409);
      const dq = await env.DB.prepare('SELECT 1 AS hit FROM disqualified_entries WHERE giveaway_id = ?1 AND tiktok_lower = ?2 LIMIT 1').bind(g.id, p.tracking_lower).first();
      if (dq) return json({ ok: false, error: 'This player was disqualified from this giveaway.' }, 409);
      if (!(await enrollPlayer(env, g.id, p, 'registered', '', now))) {
        return json({ ok: false, error: 'That player is already on the wheel.' }, 409);
      }
      return json({ ok: true, ign: p.ign, tracking_id: p.tracking_id });
    }

    case 'update_player': {
      const pid = Number(body.id);
      if (!Number.isInteger(pid)) return json({ ok: false, error: 'Invalid player.' }, 400);
      const ign = cleanIgn(body.ign);
      const handle = String(body.tiktok || '').trim().replace(/^@/, '');
      if (!validIgn(ign)) return json({ ok: false, error: 'Enter a valid IGN (3-24 characters).' }, 400);
      if (!/^[a-zA-Z0-9_.]{2,24}$/.test(handle)) return json({ ok: false, error: 'Enter a valid TikTok username.' }, 400);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(pid).first();
      if (!p) return json({ ok: false, error: 'That player no longer exists.' }, 404);
      const taken = await handleTaken(env, handle.toLowerCase(), p.ml_user_id, p.ml_server_id);
      if (taken) return json({ ok: false, error: `That TikTok username belongs to another player (${taken.tracking_id}).` }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE name_requests SET status = 'rejected', reject_reason = 'The host changed your name directly.', decided_at = ?2 WHERE player_id = ?1 AND status = 'pending'").bind(pid, now),
        env.DB.prepare('UPDATE players SET ign = ?2, tiktok_username = ?3, tiktok_lower = ?4 WHERE id = ?1').bind(pid, ign, handle, handle.toLowerCase()),
        env.DB.prepare(
          "UPDATE qualified_entries SET roblox_username = ?2, roblox_lower = ?3, tiktok_username = ?4 WHERE tiktok_lower = ?1 AND giveaway_id IN (SELECT id FROM giveaways WHERE status NOT IN ('ended', 'saved'))"
        ).bind(p.tracking_lower, ign, ign.toLowerCase(), handle)
      ]);
      return json({ ok: true });
    }

    case 'delete_player': {
      const pid = Number(body.id);
      if (!Number.isInteger(pid)) return json({ ok: false, error: 'Invalid player.' }, 400);
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(pid).first();
      if (!p) return json({ ok: false, error: 'That player no longer exists.' }, 404);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM qualified_entries WHERE tiktok_lower = ?1').bind(p.tracking_lower),
        env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND ml_user_id = ?1 AND ml_server_id = ?2").bind(p.ml_user_id, p.ml_server_id),
        env.DB.prepare('DELETE FROM name_requests WHERE player_id = ?1').bind(pid),
        env.DB.prepare('DELETE FROM players WHERE id = ?1').bind(pid)
      ]);
      return json({ ok: true });
    }

    case 'remove_entry': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      await env.DB.prepare('DELETE FROM qualified_entries WHERE id = ?1').bind(id).run();
      return json({ ok: true });
    }

    case 'get_screenshot': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const row = await env.DB.prepare("SELECT screenshot FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!row) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      return json({ ok: true, screenshot: row.screenshot });
    }

    case 'app_accept': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const app = await env.DB.prepare("SELECT * FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!app) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      if (!app.ml_user_id || !app.ml_server_id) return json({ ok: false, error: 'This older application has no Mobile Legends ID. Reject it and ask them to re-apply.' }, 409);
      const mlKey = `${app.ml_user_id}-${app.ml_server_id}`;
      const banned = await env.DB.prepare('SELECT 1 AS hit FROM permanent_blacklist WHERE username_lower IN (?1, ?2, ?3) LIMIT 1')
        .bind(app.roblox_lower, app.tiktok_lower, mlKey).first();
      if (banned) return json({ ok: false, error: 'This player is permanently banned.' }, 409);
      const clash = await handleTaken(env, app.tiktok_lower, app.ml_user_id, app.ml_server_id);
      if (clash) return json({ ok: false, error: `That TikTok username already belongs to another player (${clash.tracking_id}).` }, 409);
      const { player } = await createPlayer(env, {
        uid: app.ml_user_id, sid: app.ml_server_id, roblox: app.roblox_username, tiktok: app.tiktok_username, tl: app.tiktok_lower
      }, 'manual-review', now);
      const dq = await env.DB.prepare('SELECT 1 AS hit FROM disqualified_entries WHERE giveaway_id = ?1 AND tiktok_lower = ?2 LIMIT 1').bind(app.giveaway_id, player.tracking_lower).first();
      if (dq) return json({ ok: false, error: 'This player was disqualified from this giveaway.' }, 409);
      const added = await enrollPlayer(env, app.giveaway_id, player, 'manual-approved', app.device_hash, now);
      if (!added) return json({ ok: false, error: 'Duplicate: that player is already on the wheel.' }, 409);
      await env.DB.batch([
        env.DB.prepare("UPDATE manual_applications SET status = 'accepted', screenshot = '', decided_at = ?2 WHERE id = ?1").bind(id, now),
        env.DB.prepare(
          "DELETE FROM manual_applications WHERE giveaway_id = ?1 AND status = 'pending' AND (ml_user_id = ?2 AND ml_server_id = ?3)"
        ).bind(app.giveaway_id, app.ml_user_id, app.ml_server_id)
      ]);
      return json({ ok: true, tracking_id: player.tracking_id });
    }

    case 'app_reject': {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ ok: false, error: 'Invalid id.' }, 400);
      const app = await env.DB.prepare("SELECT giveaway_id, roblox_lower, tiktok_lower FROM manual_applications WHERE id = ?1 AND status = 'pending'").bind(id).first();
      if (!app) return json({ ok: false, error: 'That application is no longer pending.' }, 404);
      await env.DB.prepare(
        "UPDATE manual_applications SET status = 'rejected', reject_reason = ?2, screenshot = '', decided_at = ?3 WHERE giveaway_id = ?1 AND status = 'pending' AND (roblox_lower = ?4 OR tiktok_lower = ?5)"
      ).bind(app.giveaway_id, cleanLine(body.reason, 150), now, app.roblox_lower, app.tiktok_lower).run();
      return json({ ok: true });
    }

    case 'app_remove_username': {
      const username = String(body.username || '').trim();
      if (!validIgn(username)) return json({ ok: false, error: 'Invalid name.' }, 400);
      const lower = cleanIgn(username).toLowerCase();
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND (roblox_lower = ?1 OR tiktok_lower = ?1)").bind(lower).run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'app_remove_device': {
      const device = String(body.device_hash || '');
      if (!/^[a-f0-9]{8,64}$/.test(device)) return json({ ok: false, error: 'Invalid device tag.' }, 400);
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending' AND device_hash = ?1").bind(device).run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'app_clear_all': {
      const r = await env.DB.prepare("DELETE FROM manual_applications WHERE status = 'pending'").run();
      return json({ ok: true, removed: r.meta.changes });
    }

    case 'set_streamer': {
      const name = cleanLine(body.name, 40);
      const username = String(body.username || '').trim().replace(/^@/, '');
      if (name.length < 3) return json({ ok: false, error: 'Enter the streamer display name (3+ characters).' }, 400);
      if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) {
        return json({ ok: false, error: 'The TikTok username can only use letters, numbers, dots and underscores.' }, 400);
      }
      await env.DB.batch([setConfig(env, 'streamer_name', name), setConfig(env, 'streamer_username', username)]);
      return json({ ok: true });
    }

    case 'clear_alerts':
      await env.DB.prepare('DELETE FROM live_alerts').run();
      return json({ ok: true });

    case 'wipe_d1':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM qualified_entries'),
        env.DB.prepare('DELETE FROM disqualified_entries'),
        env.DB.prepare('DELETE FROM manual_applications'),
        env.DB.prepare('DELETE FROM giveaways'),
        env.DB.prepare('DELETE FROM live_alerts'),
        setConfig(env, 'registration_gate', 'closed'),
        setConfig(env, 'wheel_command', 'idle'),
        setConfig(env, 'last_landed', ''),
        setConfig(env, 'force_reset', 'true'),
        setConfig(env, 'spin_id', '0'),
        setConfig(env, 'last_spin_at', '0'),
        setConfig(env, 'out_list', '[]')
      ]);
      return json({ ok: true });

    default:
      return json({ ok: false, error: 'Unknown action.' }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/submit') return await handleSubmit(request, env);
      if (url.pathname === '/api/registration') return await handleRegistration(request, env);
      if (url.pathname === '/api/apply') return await handleApply(request, env);
      if (url.pathname === '/api/player-check') return await handlePlayerCheck(request, env);
      if (url.pathname === '/api/enter') return await handleEnter(request, env);
      if (url.pathname === '/api/bot') return await handleBot(request, env);
      if (url.pathname === '/api/rename-request') return await handleRenameRequest(request, env);
      if (url.pathname === '/api/apply-status') return await handleApplyStatus(request, env, url);
      if (url.pathname === '/api/public-list') return await handlePublicList(request, env);
      if (url.pathname === '/api/stream-action') {
        try {
          const res = await handleStreamAction(request, env, url);
          if (res.status === 200) listCache.at = 0;
          return res;
        } catch (err) {
          console.error('Stream action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: 'Something went wrong. Try again, or use the admin panel.' }, 500);
        }
      }
      if (url.pathname === '/api/owner-action') {
        try {
          return await handleOwnerAction(request, env);
        } catch (err) {
          console.error('Owner action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: `Database error: ${String((err && err.message) || err).slice(0, 220)}` }, 500);
        }
      }
      if (url.pathname === '/api/admin-action') {
        try {
          const res = await handleAdminAction(request, env, url);
          if (res.status === 200) listCache.at = 0;
          return res;
        } catch (err) {
          console.error('Admin action error:', err && err.stack ? err.stack : err);
          return json({ ok: false, error: `Database error: ${String((err && err.message) || err).slice(0, 220)}` }, 500);
        }
      }
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found.' }, 404);
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'Server error.' }, 500);
    }
  }
};
