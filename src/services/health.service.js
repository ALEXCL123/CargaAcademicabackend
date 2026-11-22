import sequelize from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/HttpError.js';

// Solo comprueba la conexión. La estructura se administra con el script SQL.
export const verifyDatabase = async (connection = sequelize, config = env.db) => {
  if (!config.user || !config.password) {
    throw new HttpError(
      503,
      'DB_NOT_CONFIGURED',
      'La conexión a PostgreSQL está pendiente de configurar en el backend.',
    );
  }

  if (!config.port) {
    throw new HttpError(503, 'DB_CONFIG_INVALID', 'Revisa la configuración de PostgreSQL en el backend.');
  }

  try {
    await connection.authenticate();
  } catch {
    throw new HttpError(503, 'DB_UNAVAILABLE', 'No se pudo establecer la conexión con PostgreSQL.');
  }
};
