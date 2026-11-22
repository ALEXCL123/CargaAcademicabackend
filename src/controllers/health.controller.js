import { verifyDatabase } from '../services/health.service.js';

export const getHealth = async (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'api',
    status: 'available',
    message: 'Servidor disponible.',
    timestamp: new Date().toISOString(),
  });
};

export const getDatabaseHealth = async (req, res) => {
  await verifyDatabase();
  res.status(200).json({
    ok: true,
    service: 'database',
    status: 'connected',
    message: 'Conexión con PostgreSQL verificada.',
    timestamp: new Date().toISOString(),
  });
};
