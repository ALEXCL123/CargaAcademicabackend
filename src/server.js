import app from './app.js';
import sequelize from './config/db.js';
import { env } from './config/env.js';
import { verifyDatabase } from './services/health.service.js';

const startServer = async () => {
  if (!env.port) throw new Error('PORT debe ser un número entre 1 y 65535.');

  try {
    await verifyDatabase();
    console.log('PostgreSQL: conexión verificada.');
  } catch (error) {
    console.warn(`PostgreSQL: ${error.code === 'DB_NOT_CONFIGURED' ? 'configuración pendiente' : 'conexión no disponible'}.`);
  }

  const server = app.listen(env.port, () => {
    console.log(`API disponible en http://localhost:${env.port}`);
  });

  server.on('error', () => {
    console.error('No se pudo iniciar la API. Comprueba el puerto configurado.');
    process.exitCode = 1;
    void sequelize.close();
  });

  const shutdown = () => {
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

startServer().catch(() => {
  console.error('No se pudo iniciar la API. Revisa la configuración del backend.');
  process.exitCode = 1;
});
