import sequelize from '../src/config/db.js';
import { verifyDatabase } from '../src/services/health.service.js';

try {
  await verifyDatabase();
  console.log('Conexión con PostgreSQL verificada mediante authenticate().');
} catch (error) {
  console.error(error.code === 'DB_NOT_CONFIGURED'
    ? 'Conexión pendiente: completa DB_USER y DB_PASSWORD en backend/.env.'
    : 'No se pudo verificar PostgreSQL. Revisa la configuración y la disponibilidad del servidor.');
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
