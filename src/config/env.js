import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});

const parsePort = (value, fallback) => {
  const raw = value?.trim() || String(fallback);
  return /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535
    ? Number(raw)
    : null;
};

export const env = {
  port: parsePort(process.env.PORT, 4000),
  frontendUrl: process.env.FRONTEND_URL?.trim() || 'http://localhost:5173',
  db: {
    host: process.env.DB_HOST?.trim() || 'localhost',
    port: parsePort(process.env.DB_PORT, 5432),
    name: process.env.DB_NAME?.trim() || 'carga_academica',
    user: process.env.DB_USER?.trim() || '',
    password: process.env.DB_PASSWORD || '',
  },
};

export const getFrontendOrigin = () => {
  try {
    const url = new URL(env.frontendUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('FRONTEND_URL debe contener una URL HTTP o HTTPS válida.');
  }
};
