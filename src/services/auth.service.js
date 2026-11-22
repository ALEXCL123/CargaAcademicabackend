import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { atomic, fail, invalid, one, rows } from './database.js';

const cookie = 'carga_sesion';
const lifetime = 8 * 60 * 60 * 1000;
const digest = (token) => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' };
const attempts = new Map();
const attemptLimit = 8;
const attemptWindow = 15 * 60 * 1000;
const absentHash = await hashPassword(randomBytes(32).toString('hex'));

const getToken = (req) => req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(cookie + '='))?.slice(cookie.length + 1);
const checkAttempts = (ip) => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.expiry <= now) attempts.delete(key);
  const entry = attempts.get(ip) || { expiry: now + attemptWindow, count: 0 };
  if (entry.count >= attemptLimit || (!attempts.has(ip) && attempts.size >= 2000)) {
    fail(429, 'LOGIN_LIMIT', 'Demasiados intentos. Vuelve a intentar en unos minutos.');
  }
  entry.count += 1;
  attempts.set(ip, entry);
};

export const initializeOperator = async (username, password, fullName = username) => {
  if (!/^[\p{L}\d_.-]{3,60}$/u.test(username)) invalid('El usuario debe tener de 3 a 60 caracteres válidos.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) invalid('La contraseña debe tener entre 12 y 256 caracteres.');
  if (typeof fullName !== 'string' || !fullName.trim() || [...fullName.trim()].length > 180) {
    invalid('El nombre completo es obligatorio y admite hasta 180 caracteres.');
  }
  const hash = await hashPassword(password);
  return atomic(async (transaction) => {
    const operator = await one(`INSERT INTO public.usuario(id,nombre_completo,nombre_usuario,password_hash)
      VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id`, [fullName.trim(), username, hash], transaction);
    if (!operator) fail(409, 'OPERATOR_EXISTS', 'Ya existe una cuenta de operador.');
    return operator;
  });
};

export const login = async (req, res) => {
  const { usuario, password } = req.body || {};
  if (typeof usuario !== 'string' || !usuario.trim() || usuario.trim().length > 60 ||
      typeof password !== 'string' || !password || password.length > 256) invalid('Escribe el usuario y la contraseña.');
  checkAttempts(req.ip);
  const account = await one('SELECT id,nombre_usuario,password_hash,activo FROM public.usuario WHERE nombre_usuario=$1', [usuario.trim()]);
  const match = await verifyPassword(password, account?.password_hash ?? absentHash);
  if (!match || !account?.activo) fail(401, 'INVALID_LOGIN', 'Usuario o contraseña incorrectos, o cuenta inactiva.');
  const token = randomBytes(32).toString('hex');
  await atomic(async (transaction) => {
    await rows('DELETE FROM public.usuario_sesion WHERE vence<=now()', [], transaction);
    await rows('INSERT INTO public.usuario_sesion(token_hash,usuario_id,vence) VALUES($1,$2,$3)',
      [digest(token), account.id, new Date(Date.now() + lifetime)], transaction);
  });
  attempts.delete(req.ip);
  res.cookie(cookie, token, { ...cookieOptions, maxAge: lifetime });
  return { usuario: account.nombre_usuario };
};

export const session = async (req) => {
  const token = getToken(req);
  if (!/^[a-f0-9]{64}$/.test(token || '')) fail(401, 'LOGIN_REQUIRED', 'Inicia sesión para continuar.');
  const account = await one(`SELECT u.nombre_usuario usuario FROM public.usuario_sesion s
    JOIN public.usuario u ON u.id=s.usuario_id WHERE s.token_hash=$1 AND s.vence>now() AND u.activo`, [digest(token)]);
  if (!account) fail(401, 'LOGIN_REQUIRED', 'La sesión terminó. Inicia sesión para continuar.');
  return account;
};

export const logout = async (req, res) => {
  const token = getToken(req);
  if (/^[a-f0-9]{64}$/.test(token || '')) await rows('DELETE FROM public.usuario_sesion WHERE token_hash=$1', [digest(token)]);
  res.clearCookie(cookie, cookieOptions);
};

