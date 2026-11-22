import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const hashPassword = async (password) => {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
};

export const verifyPassword = async (password, stored) => {
  const [algorithm, salt, encoded] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(encoded)) return false;
  return timingSafeEqual(await derive(password, salt, 64), Buffer.from(encoded, 'hex'));
};

