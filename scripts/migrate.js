import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import db from '../src/config/db.js';

const baselineInstalled = async (connection, sql, options) => {
  const expected = new Map();
  for (const [, table, definition] of sql.matchAll(/CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const columns = [...definition.matchAll(/^ {4}(?!CONSTRAINT\b)([a-z][a-z_\d]*)\s/gm)].map(([, name]) => name);
    expected.set(table, columns);
  }
  const [columns] = await connection.query(`SELECT t.table_name, c.column_name FROM information_schema.tables t
    JOIN information_schema.columns c USING (table_catalog,table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE'`, options);
  const installed = Map.groupBy(columns, (row) => row.table_name);
  if (![...expected.keys()].some((table) => installed.has(table))) {
    const [[legacy]] = await connection.query("SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname <> 'public' AND tablename='usuario') AS existe", options);
    if (legacy.existe) throw new Error('Hay una instalación en otro esquema. Verifica la base antes de inicializar public.');
    return false;
  }
  const missing = [];
  for (const [table, required] of expected) {
    const actual = new Set(installed.get(table)?.map((row) => row.column_name));
    for (const name of required) if (!actual.has(name)) missing.push(table + '.' + name);
  }
  if (missing.length) {
    throw new Error('La instalación existente no coincide con la estructura base. Faltan: ' + missing.join(', '));
  }
  return true;
};

export const migrate = async (connection = db) => {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  await connection.transaction(async (transaction) => {
    const options = { transaction };
    await connection.query('SELECT pg_advisory_xact_lock(4071321)', options);
    await connection.query(`CREATE TABLE IF NOT EXISTS public.carga_migracion (
      archivo text PRIMARY KEY, sha256 text NOT NULL, aplicada timestamptz NOT NULL DEFAULT now()
    )`, options);
    const [rows] = await connection.query('SELECT archivo,sha256 FROM public.carga_migracion', options);
    const recorded = new Map(rows.map((row) => [row.archivo, row.sha256]));
    for (const file of files) {
      const sql = (await readFile(new URL(file, directory), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (recorded.has(file)) {
        if (recorded.get(file) !== checksum) throw new Error(`Cambió una migración aplicada: ${file}`);
        continue;
      }
      const adopt = file === '001_esquema.sql' && await baselineInstalled(connection, sql, options);
      if (!adopt) await connection.query(sql, options);
      await connection.query('INSERT INTO public.carga_migracion(archivo,sha256) VALUES($1,$2)', { ...options, bind: [file, checksum] });
      console.log(adopt ? 'Estructura base existente registrada:' : 'Migración ejecutada:', file);
    }
  });
};

