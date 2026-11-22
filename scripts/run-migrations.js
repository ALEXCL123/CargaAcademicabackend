import db from '../src/config/db.js';
import { migrate } from './migrate.js';

try {
  await migrate();
  console.log('Migraciones verificadas.');
} catch (error) {
  console.error(error.original?.code ? `PostgreSQL rechazó la migración (${error.original.code}).` : error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}

