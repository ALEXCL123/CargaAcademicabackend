import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { initializeOperator } from '../src/services/auth.service.js';
import { one } from '../src/services/database.js';
import db from '../src/config/db.js';

let prompt;
try {
  if (!process.stdin.isTTY) throw new Error('Ejecuta este comando desde una terminal interactiva.');
  if (await one('SELECT id FROM public.usuario LIMIT 1')) throw new Error('Ya existe una cuenta de operador.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) process.stdout.write(chunk, encoding);
    callback();
  } });
  prompt = createInterface({ input: process.stdin, output, terminal: true });
  const fullName = (await prompt.question('Nombre completo: ')).trim();
  const username = (await prompt.question('Usuario: ')).trim();
  const readSecret = async (label) => {
    process.stdout.write(label);
    hidden = true;
    try { return await prompt.question(''); }
    finally { hidden = false; process.stdout.write('\n'); }
  };
  const password = await readSecret('Contraseña: ');
  if (password !== await readSecret('Repite la contraseña: ')) throw new Error('Las contraseñas no coinciden.');
  await initializeOperator(username, password, fullName);
  console.log('Operador creado.');
} catch (error) {
  console.error(error.original ? 'No se pudo consultar la base. Verifica las migraciones.' : error.message);
  process.exitCode = 1;
} finally {
  prompt?.close();
  await db.close();
}

