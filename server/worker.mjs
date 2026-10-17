import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomToken, tokenHash, verifyPassword, seatInput, studentInput, isSchoolEmail, verifySchoolIdentity } from './security.mjs';
// Only public signing keys are cached; no request or user state is shared.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const FRONTEND = 'https://tcsshcsc.github.io';
const allowedOrigin = request => [new URL(request.url).origin, FRONTEND].includes(request.headers.get('origin'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const messages = {
  ROUND_CHANGED: '點名場次已更新，請重新整理後再操作。',
  SEAT_BLOCKED: '這個座位已停用，請選擇其他座位。',
  ALREADY_CHECKED_IN: '你已完成本次點名，不能重複選位。',
  SEAT_TAKEN: '這個座位已有人，請重新整理座位圖。',
  STUDENT_TAKEN: '這個班級座號已完成點名，請洽管理員。',
};
const cookieValue = (request, name) => request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
function cookie(request, name, value, age) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function bodyJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw fail('請使用 JSON 格式。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw fail('缺少資料。');
  const chunks = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 12000) { await reader.cancel(); throw fail('資料過大。', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const body = JSON.parse(new TextDecoder().decode(bytes)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); return body; }
  catch { throw fail('資料格式錯誤。'); }
}
async function session(request, env, role) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /,'') || cookieValue(request, `attendance_${role}`);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw fail(role === 'admin' ? '請先登入管理員。' : '請先登入 Google 帳號。', 401);
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires_at>?').bind(await tokenHash(token), role, Date.now()).first();
  if (!row) throw fail('登入已過期，請重新登入。', 401);
  if (role === 'student' && !isSchoolEmail(row.email)) throw fail('僅限 @stu.tcssh.tc.edu.tw 的中二中學生帳號報到。', 403);
  return row;
}
async function newSession(request, env, role, userId = null, email = null) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions(token_hash,role,user_id,email,expires_at) VALUES(?,?,?,?,?)').bind(await tokenHash(token), role, userId, email, Date.now() + 8 * 3600000).run();
  return {token, cookie:cookie(request, `attendance_${role}`, token, 8 * 3600)};
}
async function limitLogin(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const bucket = Math.floor(Date.now() / 900000);
  const key = await tokenHash(`${ip}:${bucket}`);
  const row = await env.DB.prepare('INSERT INTO login_limits(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key, (bucket + 1) * 900000).first();
  if (row.attempts > 20) throw fail('登入嘗試過多，請 15 分鐘後再試。', 429);
}
export async function snapshot(db) {
  const result = await db.batch([
    db.prepare('SELECT r.* FROM rounds r JOIN settings s ON s.current_round=r.id WHERE s.id=1'),
    db.prepare('SELECT * FROM seats ORDER BY room,seat'),
    db.prepare('SELECT c.* FROM checkins c JOIN settings s ON s.current_round=c.round_id WHERE s.id=1 ORDER BY c.room,c.seat'),
  ]);
  return { round: result[0].results[0], seats: result[1].results.map(s => ({ ...s, blocked: !!s.blocked })), checkins: result[2].results };
}
export async function route(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (!path.startsWith('/api/')) {
    if (!['GET','HEAD'].includes(method)) return new Response('Method not allowed', { status: 405 });
    const query = new URLSearchParams();
    if (path.startsWith('/admin')) query.set('admin','1');
    if (path.endsWith('/b')) query.set('room','B');
    return Response.redirect(FRONTEND+'/tcsshcsc-/'+(path.endsWith('.html') && path !== '/index.html' ? path.slice(1) : '?'+query),302);
  }
  if (method === 'OPTIONS') {
    if (!allowedOrigin(request)) throw fail('不允許的來源。',403);
    return new Response(null,{status:204});
  }
  if (!['GET', 'POST'].includes(method)) throw fail('不支援此操作。', 405);
  if (method === 'POST' && (!allowedOrigin(request) || request.headers.get('x-requested-with') !== 'attendance')) throw fail('請由本網站操作。', 403);
  if (path === '/api/config' && method === 'GET') return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', configured: !!env.DB });
  if (!env.DB) throw fail('資料庫尚未設定完成，現在無法點名。', 503);
  if (path === '/api/auth/nonce' && method === 'GET') {
    const nonce = randomToken();
    await env.DB.prepare('INSERT INTO login_nonces(nonce_hash,expires_at) VALUES(?,?)').bind(await tokenHash(nonce),Date.now()+600000).run();
    return json({ nonce }, 200, { 'Set-Cookie': cookie(request, 'attendance_nonce', nonce, 600) });
  }
  if (path === '/api/auth/google' && method === 'POST') {
    await limitLogin(request, env);
    if (!env.GOOGLE_CLIENT_ID) throw fail('Google 登入尚未完成設定。', 503);
    const body = await bodyJson(request);
    const nonce = body.nonce || cookieValue(request, 'attendance_nonce');
    if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) throw fail('登入驗證已過期，請重新整理。', 401);
    let payload;
    try { ({ payload } = await jwtVerify(body.credential, googleKeys, { audience: env.GOOGLE_CLIENT_ID, issuer: ['https://accounts.google.com','accounts.google.com'], algorithms: ['RS256'], maxTokenAge: '10m' })); }
    catch { throw fail('Google 驗證失敗，請重新登入。', 401); }
    if (payload.nonce !== nonce || !payload.sub || !payload.email || payload.email_verified !== true) throw fail('Google 帳號驗證失敗。', 401);
    if (!verifySchoolIdentity(payload)) throw fail('此帳號不是中二中學生帳號，請改用 @stu.tcssh.tc.edu.tw 的 Google 帳號登入。', 403);
    const consumed = await env.DB.prepare('DELETE FROM login_nonces WHERE nonce_hash=? AND expires_at>? RETURNING nonce_hash').bind(await tokenHash(nonce),Date.now()).first();
    if (!consumed) throw fail('登入驗證已過期，請重新整理。',401);
    const issued = await newSession(request, env, 'student', payload.sub, payload.email);
    const headers = new Headers();
    headers.append('Set-Cookie', issued.cookie);
    headers.append('Set-Cookie', cookie(request, 'attendance_nonce', '', 0));
    return json({ success: true, email: payload.email, token:issued.token }, 200, headers);
  }
  if (path === '/api/admin/login' && method === 'POST') {
    await limitLogin(request, env);
    const body = await bodyJson(request);
    const valid = await verifyPassword(body.password, env.ADMIN_PASSWORD_HASH);
    if (body.username !== env.ADMIN_USERNAME || !valid) throw fail('帳號或密碼錯誤。', 401);
    const issued = await newSession(request, env, 'admin');
    return json({ success: true, token:issued.token }, 200, { 'Set-Cookie':issued.cookie });
  }
  if (path === '/api/state' && method === 'GET') {
    const state = await snapshot(env.DB);
    return json({ round: state.round, seats: state.seats.map(s => ({ ...s, occupied: state.checkins.some(c => c.room === s.room && c.seat === s.seat) })) });
  }
  if (path === '/api/me' && method === 'GET') {
    const user = await session(request, env, 'student');
    const mine = await env.DB.prepare('SELECT c.* FROM checkins c JOIN settings s ON s.current_round=c.round_id WHERE s.id=1 AND c.user_id=?').bind(user.user_id).first();
    return json({ email: user.email, checkin: mine });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const user = await session(request, env, 'student');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash).run();
    return json({ success: true }, 200, { 'Set-Cookie': cookie(request, 'attendance_student', '', 0) });
  }
  if (path === '/api/checkin' && method === 'POST') {
    const user = await session(request, env, 'student');
    const body = studentInput(await bodyJson(request));
    await env.DB.prepare('INSERT INTO checkins(round_id,user_id,email,room,seat,class_name,student_number) VALUES(?,?,?,?,?,?,?)').bind(body.roundId,user.user_id,user.email,body.room,body.seat,body.className,body.studentNumber).run();
    return json({ success: true });
  }
  if (path.startsWith('/api/admin/')) {
    const user = await session(request, env, 'admin');
    if (path === '/api/admin/state' && method === 'GET') return json(await snapshot(env.DB));
    if (path === '/api/admin/logout' && method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash).run();
      return json({ success: true }, 200, { 'Set-Cookie': cookie(request, 'attendance_admin', '', 0) });
    }
    if (path === '/api/admin/seat' && method === 'POST') {
      const body = await bodyJson(request); seatInput(body);
      if (typeof body.blocked !== 'boolean') throw fail('座位設定不正確。');
      await env.DB.prepare('UPDATE seats SET blocked=? WHERE room=? AND seat=?').bind(body.blocked ? 1 : 0, body.room, body.seat).run();
      return json({ success: true });
    }
    if (path === '/api/admin/cancel' && method === 'POST') {
      const body = await bodyJson(request); seatInput(body);
      if (!Number.isSafeInteger(body.checkinId) || body.checkinId < 1 || !Number.isSafeInteger(body.roundId) || body.roundId < 1) throw fail('劃位資料不正確。');
      const result = await env.DB.prepare('DELETE FROM checkins WHERE id=? AND room=? AND seat=? AND round_id=? AND round_id=(SELECT current_round FROM settings WHERE id=1)').bind(body.checkinId,body.room,body.seat,body.roundId).run();
      if (!result.meta.changes) throw fail('劃位已變更，請更新資料後再操作。',409);
      return json({success:true});
    }
    if (path === '/api/admin/round' && method === 'POST') {
      const { roundId } = await bodyJson(request);
      if (!Number.isSafeInteger(roundId) || roundId < 1) throw fail('場次不正確。');
      const result = await env.DB.batch([
        env.DB.prepare('INSERT INTO rounds(id) SELECT ? WHERE (SELECT current_round FROM settings WHERE id=1)=?').bind(roundId+1,roundId),
        env.DB.prepare('DELETE FROM checkins WHERE (SELECT current_round FROM settings WHERE id=1)=?').bind(roundId),
        env.DB.prepare('UPDATE settings SET current_round=? WHERE id=1 AND current_round=?').bind(roundId+1,roundId),
        env.DB.prepare('DELETE FROM rounds WHERE id<>(SELECT current_round FROM settings WHERE id=1)'),
      ]);
      if (!result[0].meta.changes) throw fail(messages.ROUND_CHANGED, 409);
      return json({ roundId: roundId+1 });
    }

  }
  throw fail('找不到此功能。', 404);
}
export default {
  async fetch(request, env, ctx) {
    let response;
    try { response = await route(request, env, ctx); }
    catch (error) {
      const known = Object.keys(messages).find(k => String(error.message).includes(k));
      if (!known && !error.status) console.error(JSON.stringify({ event:'request_failed', path:new URL(request.url).pathname, errorType:error.name }));
      response = json({ error: known ? messages[known] : error.status ? error.message : '系統暫時無法使用，請稍後再試。' }, known ? 409 : error.status || 500);
    }
    const secured = new Response(response.body, response);
    if (allowedOrigin(request)) {
      secured.headers.set('Access-Control-Allow-Origin',request.headers.get('origin'));
      secured.headers.set('Vary','Origin');
      secured.headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      secured.headers.set('Access-Control-Allow-Headers','Content-Type, X-Requested-With, Authorization');
    }
    secured.headers.set('X-Content-Type-Options','nosniff');
    secured.headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    secured.headers.set('X-Frame-Options','DENY');
    secured.headers.set('Cross-Origin-Opener-Policy','same-origin-allow-popups');
    secured.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; img-src 'self' data:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    if (new URL(request.url).pathname.startsWith('/api/')) secured.headers.set('Cache-Control','no-store');
    return secured;
  },
  async scheduled(event, env, ctx) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_nonces WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM login_limits WHERE expires_at<?').bind(Date.now()),
    ]);
  },
};
