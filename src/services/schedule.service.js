import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import db from '../config/db.js';
import { atomic, conflict, idOf, invalid, notFound, one, periodOf, putRow, rows } from './database.js';
import { getLoad } from './load.service.js';
import { checkPlacement, normalizeSession } from './schedule.rules.js';

const getSessions = async (period, tx) => (await rows(`
  SELECT s.*, EXTRACT(EPOCH FROM s.hora_inicio)::numeric / 3600 AS inicio,
    EXTRACT(EPOCH FROM s.hora_fin)::numeric / 3600 AS fin,
    CASE WHEN s.tipo='ACTIVIDAD_JP' THEN s.asignacion_id END AS actividad_jp_id,
    ARRAY(SELECT grupo_id FROM public.ocupacion_grupo WHERE sesion_id=s.id
      UNION SELECT s.grupo_tutoria_id WHERE s.grupo_tutoria_id IS NOT NULL ORDER BY 1) grupos,
    ARRAY(SELECT docente_id FROM public.ocupacion_docente WHERE sesion_id=s.id
      UNION SELECT s.docente_id WHERE s.docente_id IS NOT NULL ORDER BY 1) docentes,
    d.nombres, d.apellidos, a.codigo ambiente_codigo, a.nombre ambiente_nombre,
    jp.descripcion_actividad actividad
  FROM public.sesion_horario s LEFT JOIN public.docente d ON d.id=s.docente_id
  LEFT JOIN public.ambiente a ON a.id=s.ambiente_id
  LEFT JOIN public.asignacion_carga jp ON jp.id=s.asignacion_id AND s.tipo='ACTIVIDAD_JP'
  WHERE s.periodo_id=$1 ORDER BY s.dia,s.hora_inicio,s.id`,[period],tx)).map((s) => ({
    ...s, inicio: Number(s.inicio), fin: Number(s.fin),
    asignacion_id: s.tipo === 'ACTIVIDAD_JP' ? null : s.asignacion_id,
    excepcion: s.excepcion ?? (s.excepcion_duracion ? s.observaciones || 'Excepción registrada' : null),
  }));

const contextFor = async (period, tx) => {
  const [load, ambientes, sesiones] = await Promise.all([
    getLoad(period,tx,{includeExternal:true}), rows('SELECT *, carrera_exclusiva_id AS carrera_id FROM public.ambiente ORDER BY id',[],tx), getSessions(period,tx),
  ]);
  return { ...load, ambientes, sesiones };
};
export const progress = (context, sessions = context.sesiones) => ({
  cursos: context.asignaciones.map((a) => {
    const programadas = sessions.filter((s) => s.asignacion_id === a.id).reduce((n,s) => n+s.fin-s.inicio,0);
    return { id: a.id, requeridas: a.horas, programadas, pendientes: Math.max(0,a.horas-programadas),exceso: a.horas==null ? 0 : Math.max(0,programadas-a.horas) };
  }),
  sinAsignar: context.ofertas.filter((o) => !o.asignacion_id).length,
  tutorias: context.grupos.filter((g) => !sessions.some((s) => s.tipo === 'TUTORIA' && s.grupos.includes(g.id))).map((g) => g.id),
});

export const getSchedule = async (period, tx) => {
  const record = await periodOf(period,tx);
  if (record.encabezado?.horario) return record.encabezado.horario;
  const context = await contextFor(record.id,tx);
  return { ...context, avance: progress(context) };
};

const normalized = (body, ctx) => {
  try { return normalizeSession(body,ctx); }
  catch (error) { return invalid(error.message); }
};
const validate = (s, sessions, context) => {
  const error = checkPlacement(s,sessions,context);
  if (error) conflict(error);
};

const persist = async (period, s, tx, id) => {
  const { grupos, docentes } = s;
  if (id) {
    await rows('DELETE FROM public.ocupacion_grupo WHERE sesion_id=$1',[id],tx);
    await rows('DELETE FROM public.ocupacion_docente WHERE sesion_id=$1',[id],tx);
  }
  const time = (hour) => String(hour).padStart(2, '0') + ':00';
  const saved = await putRow('sesion_horario', {
    periodo_id: period, tipo: s.tipo, asignacion_id: s.asignacion_id ?? s.actividad_jp_id,
    grupo_tutoria_id: s.tipo === 'TUTORIA' ? grupos[0] : null,
    docente_id: s.docente_id, ambiente_id: s.ambiente_id, dia: s.dia,
    hora_inicio: time(s.inicio), hora_fin: time(s.fin), excepcion: s.excepcion,
    excepcion_duracion: Boolean(s.excepcion),
  }, tx, id);
  for (const group of grupos) await rows(`INSERT INTO public.ocupacion_grupo
    (sesion_id,periodo_id,grupo_id,dia,rango_minutos)
    SELECT id,periodo_id,$2,dia,rango_minutos FROM public.sesion_horario WHERE id=$1`,
    [saved.id,group],tx);
  for (const teacher of docentes) await rows(`INSERT INTO public.ocupacion_docente
    (sesion_id,periodo_id,docente_id,dia,rango_minutos)
    SELECT id,periodo_id,$2,dia,rango_minutos FROM public.sesion_horario WHERE id=$1`,
    [saved.id,teacher],tx);
  return { ...saved, ...s };
};

export const saveSession = (period, body, id) => atomic(async (tx) => {
  await periodOf(period,tx,true);
  const ctx = await contextFor(period,tx);
  const key = id && idOf(id);
  if (key && !ctx.sesiones.some((s) => s.id === key)) notFound('No se encontró la sesión.');
  const s = normalized(body,ctx);
  validate(s,ctx.sesiones.filter((item) => item.id !== key),ctx);
  return persist(period,s,tx,key);
});
export const removeSession = (period, id) => atomic(async (tx) => {
  await periodOf(period,tx,true);
  const deleted = await one('DELETE FROM public.sesion_horario WHERE id=$1 AND periodo_id=$2 RETURNING id',[idOf(id),period],tx);
  if (!deleted) notFound('No se encontró la sesión.');
});

const scopeFor = (scope, ctx) => {
  if (scope!=='TODAS' && !ctx.grupos.some((group) => group.carrera===scope)) {
    invalid('Selecciona una carrera con grupos registrados en este semestre.');
  }
  const groups = ctx.grupos.filter((g) => scope === 'TODAS' || g.carrera === scope);
  if (!groups.length) invalid('El alcance no tiene grupos.');
  const ids = new Set(groups.map((g) => g.id));
  // El grupo ofertado determina la carrera tanto para la carga interna como para la externa.
  const assignments = ctx.asignaciones.filter((a) => scope==='TODAS' || (a.ofertas.length && a.ofertas.every((o) => ids.has(o.grupo_id))));
  const assignmentIds = new Set(assignments.map((a) => a.id));
  const cross = ctx.asignaciones.filter((a) => !assignmentIds.has(a.id) && a.ofertas.some((o) => ids.has(o.grupo_id)));
  const editable = ctx.sesiones.filter((s) => s.tipo === 'CLASE' ? assignmentIds.has(s.asignacion_id)
    : s.tipo === 'TUTORIA' && s.grupos.every((id) => ids.has(id)));
  return { groups, assignments, cross, editable, fixed: ctx.sesiones.filter((s) => !editable.includes(s)) };
};
const version = (ctx) => createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
const executionLimit = () => Math.min(15000,Math.max(500,Number(process.env.SCHEDULE_TIMEOUT_MS) || 2500));
let generating = false;

export const proposeSchedule = async (period, body) => {
  if (generating) conflict('Ya se está generando una propuesta. Espera a que termine.');
  generating = true;
  try {
    const ctx = await db.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async (tx) => {
      await periodOf(period,tx,true);
      return contextFor(period,tx);
    });
    const scope = body?.alcance ?? 'TODAS';
    const scoped = scopeFor(scope,ctx);
    const limit = executionLimit();
    const exception = typeof body?.excepcion === 'string' ? body.excepcion.trim().slice(0,500) : '';
    const result = await new Promise((resolve,reject) => {
      const worker = new Worker(new URL('./schedule.worker.js',import.meta.url), {
        workerData: { ctx, scoped, limit, exception }, execArgv: [],
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error('El generador excedió su tiempo de ejecución.'));
      },limit+5000);
      worker.once('message',(data) => { clearTimeout(timeout); resolve(data); });
      worker.once('error',(error) => { clearTimeout(timeout); reject(error); });
      worker.once('exit',(code) => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error('El generador terminó antes de responder.'));
      });
    });
    return { ...result, alcance: scope, version: version(ctx) };
  } finally { generating = false; }
};

export const applySchedule = (period, body) => atomic(async (tx) => {
  await periodOf(period,tx,true);
  const ctx = await contextFor(period,tx);
  if (body?.version !== version(ctx)) conflict('La carga o el horario cambiaron. Genera una propuesta actualizada.');
  if (!Array.isArray(body.sesiones) || !body.sesiones.length || body.sesiones.length > 5000) invalid('La propuesta no contiene sesiones válidas.');
  const scoped = scopeFor(body.alcance,ctx);
  const sessions = [...scoped.fixed];
  const proposal = [];
  for (const item of body.sesiones) {
    const s = normalized(item,ctx);
    const allowed = s.tipo === 'CLASE' ? scoped.assignments.some((a) => a.id === s.asignacion_id)
      : s.tipo === 'TUTORIA' && scoped.groups.some((g) => g.id === s.grupos[0]);
    if (!allowed) invalid('La propuesta incluye sesiones fuera del alcance.');
    validate(s,sessions,ctx);
    sessions.push(s);
    proposal.push(s);
  }
  for (const item of scoped.editable) {
    await rows('DELETE FROM public.sesion_horario WHERE id=$1',[item.id],tx);
  }
  for (const s of proposal) await persist(period,s,tx);
  return { guardadas: proposal.length, avance: progress(ctx,sessions) };
});

export const closePeriod = (period) => atomic(async (tx) => {
  const record = await periodOf(period,tx,true);
  if (!record.carga_completa) conflict('Marca la carga como completa antes de cerrar el período.');
  const horario = await getSchedule(period,tx);
  if (horario.avance.cursos.some((c) => c.pendientes || c.exceso) || horario.avance.tutorias.length || horario.avance.sinAsignar) {
    conflict('Completa las horas y tutorías antes de cerrar el período.');
  }
  const institucion = await one('SELECT * FROM public.configuracion WHERE id=1',[],tx);
  const carga = await getLoad(period,tx);
  carga.periodo = { ...carga.periodo, estado:'CERRADO', activo:false };
  horario.periodo = carga.periodo;
  await rows(`UPDATE public.periodo_academico SET estado='FINALIZADO',activo=false,encabezado=$2
    WHERE id=$1`,[record.id,JSON.stringify({ institucion,carga,horario })],tx);
  return { id: record.id, estado: 'CERRADO' };
});

