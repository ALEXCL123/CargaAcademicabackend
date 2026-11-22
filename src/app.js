import express from 'express';
import cors from 'cors';
import { getFrontendOrigin } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import academicRoutes from './routes/academic.routes.js';
import { errorHandler, notFound } from './middlewares/error.middleware.js';
import { HttpError } from './utils/HttpError.js';

const app = express();
const frontendOrigin = getFrontendOrigin();

app.disable('x-powered-by');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === frontendOrigin) return callback(null, true);
    return callback(new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origen no permitido.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Filename'],
  credentials: true,
}));
app.use(express.json({ limit: '4mb' }));
app.use('/api/health', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', academicRoutes);
app.use(notFound);
app.use(errorHandler);

export default app;
