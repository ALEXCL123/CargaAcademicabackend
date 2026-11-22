import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import app from '../src/app.js';
import { getFrontendOrigin } from '../src/config/env.js';
import { verifyDatabase } from '../src/services/health.service.js';
import { errorHandler } from '../src/middlewares/error.middleware.js';

test('la API responde aunque PostgreSQL no esté configurado', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'available');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!Number.isNaN(Date.parse(response.body.timestamp)));
});

test('CORS admite únicamente el origen configurado y solicitudes sin Origin', async () => {
  const origin = getFrontendOrigin();
  const allowed = await request(app).get('/api/health').set('Origin', origin);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  const denied = await request(app).get('/api/health').set('Origin', 'https://origen-no-permitido.example');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const preflight = await request(app).options('/api/health').set('Origin', origin).set('Access-Control-Request-Method', 'GET');
  assert.equal(preflight.status, 204);
});

test('rutas inexistentes y JSON inválido reciben errores públicos', async () => {
  const missing = await request(app).get('/api/inexistente');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
  const invalid = await request(app).post('/api/health').set('Content-Type', 'application/json').send('{');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_JSON');
  assert.equal(invalid.body.stack, undefined);
});

test('la comprobación de base bloquea credenciales ausentes sin intentar conectar', async () => {
  let attempted = false;
  await assert.rejects(
    verifyDatabase({ authenticate: async () => { attempted = true; } }, { user: '', password: '', port: 5432 }),
    { code: 'DB_NOT_CONFIGURED', status: 503 },
  );
  assert.equal(attempted, false);
});

test('la comprobación llama a authenticate y oculta los errores del driver', async () => {
  // Valores de prueba aislados: nunca se conectan a una base real.
  const config = { user: 'test-only', password: 'test-only', port: 5432 };
  let count = 0;
  await verifyDatabase({ authenticate: async () => { count += 1; } }, config);
  assert.equal(count, 1);
  await assert.rejects(
    verifyDatabase({ authenticate: async () => { throw new Error('password=NO_PUBLICAR host=interno'); } }, config),
    (error) => error.code === 'DB_UNAVAILABLE' && !error.message.includes('NO_PUBLICAR'),
  );
});

test('el manejador central no expone contraseñas, stack ni detalles internos', async () => {
  const testApp = express();
  testApp.get('/', () => { throw new Error('password=NO_PUBLICAR SQL SELECT interno'); });
  testApp.use(errorHandler);
  const response = await request(testApp).get('/');
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'INTERNAL_ERROR');
  assert.equal(response.body.stack, undefined);
  assert.ok(!JSON.stringify(response.body).includes('NO_PUBLICAR'));
});
