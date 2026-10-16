import { timingSafeEqual } from 'node:crypto';
export const SCHOOL_DOMAIN = 'stu.tcssh.tc.edu.tw';
export function isSchoolEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@stu\.tcssh\.tc\.edu\.tw$/i.test(email);
}
export function verifySchoolIdentity(payload) {
  return payload.email_verified === true && isSchoolEmail(payload.email) && payload.hd === SCHOOL_DOMAIN;
}
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = async token => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
export async function hashPassword(password) {
  const salt = randomToken();
  return `${salt}:${await derive(password, salt)}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(stored || '')) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(new TextEncoder().encode(await derive(password, salt)), new TextEncoder().encode(hash));
}
export function seatInput(body) {
  if (!['A', 'B'].includes(body.room) || !Number.isInteger(body.seat) || body.seat < 1 || body.seat > 48) throw Object.assign(new Error('請選擇有效的教室與座位。'), { status: 400 });
  return { room: body.room, seat: body.seat };
}
export function studentInput(body) {
  seatInput(body);
  const className = typeof body.className === 'string' ? body.className.trim() : '';
  if (!/^[\p{L}\p{N} -]{1,20}$/u.test(className) || !Number.isInteger(body.studentNumber) || body.studentNumber < 1 || body.studentNumber > 99) throw Object.assign(new Error('請輸入班級（最多 20 字）及座號（1–99）。'), { status: 400 });
  if (!Number.isInteger(body.roundId) || body.roundId < 1) throw Object.assign(new Error('請重新整理點名場次。'), { status: 400 });
  return { ...body, className };
}
