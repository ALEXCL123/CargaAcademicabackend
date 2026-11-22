import db from '../config/db.js';
import { HttpError } from '../utils/HttpError.js';

export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const invalid = (message) => fail(422, 'INVALID_DATA', message);
export const conflict = (message) => fail(409, 'ACADEMIC_CONFLICT', message);
export const notFound = (message = 'No se encontró el registro.') => fail(404, 'NOT_FOUND', message);
export const rows = async (sql, bind = [], transaction) => (await db.query(sql, { bind, transaction }))[0];
export const one = async (sql, bind = [], transaction) => (await rows(sql, bind, transaction))[0];
export const localDepartmentId = async (tx) => (await one(`SELECT id FROM public.departamento_academico
  WHERE lower(btrim(nombre))=lower($1) ORDER BY id LIMIT 1`,['Educación y Ciencia Política'],tx))?.id ?? null;
export const atomic = (operation) => db.transaction(async (transaction) => {
  await rows('SELECT pg_advisory_xact_lock(4071322)', [], transaction);
  return operation(transaction);
});

export const idOf = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) invalid('Identificador inválido.');
  if (!/^[1-9][0-9]{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) invalid('Identificador inválido.');
  return String(value);
};

export const periodOf = async (id, transaction, writable = false) => {
  const period = await one(`SELECT id, anio, numero AS semestre, fecha_inicio AS inicio, fecha_fin AS fin,
    CASE WHEN estado='FINALIZADO' THEN 'CERRADO' ELSE 'ABIERTO' END AS estado,
    activo, carga_completa, encabezado FROM public.periodo_academico WHERE id=$1`, [idOf(id)], transaction);
  if (!period) notFound('No se encontró el período.');
  if (writable && period.estado !== 'ABIERTO') conflict('El período está cerrado.');
  return period;
};

export const turno = (codigo, ciclo) => (codigo === 'EIIB' ? ciclo <= 4 : ciclo % 2 === 1) ? 'MANANA' : 'TARDE';

export const putRow = (table, data, transaction, id) => {
  const names = Object.keys(data);
  const binds = Object.values(data);
  if (id) {
    const columns = names.map((name, i) => `${name}=$${i + 1}`).join(',');
    return one(`UPDATE public.${table} SET ${columns} WHERE id=$${names.length + 1} RETURNING *`, [...binds, id], transaction);
  }
  return one(`INSERT INTO public.${table}(${names.join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, binds, transaction);
};

