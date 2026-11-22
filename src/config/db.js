import { Sequelize } from 'sequelize';
import { env } from './env.js';

const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  dialect: 'postgres',
  host: env.db.host,
  port: env.db.port ?? 5432,
  logging: false,
  retry: { max: 0 },
  pool: { max: 5, min: 0, acquire: 5000, idle: 10000 },
  dialectOptions: {
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  },
  define: {
    schema: 'public',
    freezeTableName: true,
    timestamps: false,
  },
});

export default sequelize;
