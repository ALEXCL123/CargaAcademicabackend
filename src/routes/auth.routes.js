import { Router } from 'express';
import { login, logout, session } from '../services/auth.service.js';

const router = Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.post('/login', async (req, res) => res.json(await login(req, res)));
router.get('/me', async (req, res) => res.json(await session(req)));
router.post('/logout', async (req, res) => { await logout(req, res); res.sendStatus(204); });

export const requireSession = async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  req.operator = await session(req);
  next();
};

export default router;

