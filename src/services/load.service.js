import { findCombination, listFusions } from './fusion.service.js';
import { atomic, conflict, idOf, invalid, localDepartmentId, notFound, one, periodOf, putRow, rows } from './database.js';

export const getOffers = (period, tx) => rows(`
  SELECT o.id,o.periodo_id,o.grupo_id,o.asignatura_id,g.ciclo,g.seccion,g.turno,
    p.codigo plan,c.id carrera_id,c.codigo carrera,c.nombre carrera_nombre,
    a.codigo,a.nombre,a.creditos, a.horas_teoria AS teoria, a.horas_practica AS practica,
    a.horas_laboratorio AS laboratorio,
    a.horas_computables AS horas,
    ao.asignacion_id
  FROM public.oferta_curso o
  JOIN public.grupo_academico g ON g.id=o.grupo_id
  JOIN public.plan_estudio p ON p.id=g.plan_id
  JOIN public.carrera c ON c.id=p.carrera_id
  JOIN public.asignatura a ON a.id=o.asignatura_id
  LEFT JOIN public.asignacion_oferta ao ON ao.oferta_id=o.id AND ao.rol='DOCENTE'
  WHERE o.periodo_id=$1 ORDER BY c.codigo,g.ciclo,g.seccion,a.codigo,o.id`,[period],tx);

export const getTeachingStaff = async (period, tx, includeExternal = false) => rows(`
  SELECT d.id, d.periodo_id, d.docente_id, d.tipo, d.categoria, d.codigo_personal, d.condicion, d.carrera_reporte_id,
    d.jornada_semanal AS jornada, CASE WHEN d.situacion='ACTIVO' THEN 'DOCENCIA' ELSE d.situacion END AS situacion,
    d.carrera_referencia_id,d.minimo_lectivo_excepcional,d.regla_minimo_pendiente,d.referencia_sustento,d.horas_referencia,
    d.cargo, d.responsabilidades, d.observaciones, d.resolucion_situacion_id AS documento_id, d.horas_cumplimiento,
    p.nombre_completo,p.documento_identidad AS identificacion, p.nombres,p.apellidos, p.activo,
    c.codigo carrera_reporte,cr.codigo AS carrera_referencia, doc.numero documento_numero, doc.tipo documento_tipo
  FROM public.docente_periodo d JOIN public.docente p ON p.id=d.docente_id
  LEFT JOIN public.carrera c ON c.id=d.carrera_reporte_id
  LEFT JOIN public.carrera cr ON cr.id=COALESCE(d.carrera_referencia_id,d.carrera_reporte_id)
  LEFT JOIN public.documento doc ON doc.id=d.resolucion_situacion_id
  WHERE d.periodo_id=$1 AND (
    (d.tipo<>'EXTERNO' AND (p.departamento_id IS NULL OR p.departamento_id=$2)) OR
    ($3 AND d.tipo='EXTERNO' AND p.departamento_id IS NOT NULL AND p.departamento_id IS DISTINCT FROM $2)
  ) ORDER BY COALESCE(p.apellidos,p.nombre_completo),p.nombres,p.id`,[period,await localDepartmentId(tx),includeExternal],tx);

const getAssignments = (period, tx) => rows(`
  SELECT a.*,f.horas_compartidas horas_fusion,f.nombre fusion_nombre,f.resolucion_id documento_id,d.numero resolucion,(d.contenido_pdf IS NOT NULL) AS fusion_pdf,f.habilitada AS fusion_habilitada,
    COALESCE((SELECT array_agg(j.docente_periodo_id ORDER BY j.docente_periodo_id)
      FROM public.asignacion_jp j WHERE j.asignacion_id=a.id),ARRAY[]::bigint[]) jp_ids,
    (SELECT count(*)::int FROM public.sesion_horario s WHERE s.asignacion_id=a.id) sesiones,
    (SELECT COALESCE(sum(extract(epoch FROM (s.hora_fin-s.hora_inicio))/3600),0)::float8
      FROM public.sesion_horario s WHERE s.asignacion_id=a.id AND s.tipo='CLASE') horas_programadas
  FROM public.asignacion_carga a LEFT JOIN public.fusion f ON f.id=a.fusion_id
  LEFT JOIN public.documento d ON d.id=f.resolucion_id
  WHERE a.periodo_id=$1 AND a.rol='DOCENTE' ORDER BY a.id`,[period],tx);

export const summarizeTeacher = (teacher, assignments, activities) => {
  const jp = teacher.tipo === 'JP';
  const total = assignments.reduce((sum, item) => sum + item.horas, 0);
  const minimum = !jp && teacher.tipo!=='EXTERNO' && teacher.activo && (teacher.situacion === 'DOCENCIA' || total > 0)
    ? (teacher.minimo_lectivo_excepcional != null && Number(teacher.minimo_lectivo_excepcional)<=Number(teacher.jornada)/2 && teacher.documento_id && !teacher.regla_minimo_pendiente
      ? Number(teacher.minimo_lectivo_excepcional) : Number(teacher.jornada) / 2) : null;
  const directed = assignments.filter((item) => item.modalidad==='DIRIGIDO').reduce((sum,item) => sum + item.horas,0);
  return {
    ...teacher, asignaciones: assignments, actividades: activities,
    horas_asignadas: total, horas_regulares:total-directed, horas_dirigidas:directed, minimo: minimum,
    excedente: minimum === null ? null : Math.max(0,total-minimum),
    faltantes: minimum === null ? null : Math.max(0,minimum-total),
    horas_actividades: activities.reduce((sum, item) => sum + Number(item.horas),0),
  };
};

export const teacherHourIssues = (personal) => ({
  pendientes:[
    ...personal.filter((d) => d.horas_referencia!=null && Number(d.horas_referencia)!==d.horas_asignadas && d.tipo!=='JP').map((d) => ({ tipo:'REFERENCIA',id:d.id,docente_id:d.docente_id,motivo:d.nombre_completo+': '+d.horas_referencia+' h de referencia y '+d.horas_asignadas+' h calculadas.' })),
    ...personal.filter((d) => d.faltantes > 0).map((d) => ({ tipo: 'MINIMO', id: d.id, docente_id:d.docente_id, motivo: `${d.nombre_completo}: faltan ${d.faltantes} h para el mínimo.` })),
  ],
  avisos:personal.filter((d) => d.jornada!=null && d.horas_asignadas>Number(d.jornada)).map((d) => ({ tipo:'EXCESO',id:d.id,docente_id:d.docente_id,motivo:d.nombre_completo+': '+(d.horas_asignadas-Number(d.jornada))+' h por encima de la jornada.' })),
});

export const getLoad = async (periodId, tx, { includeExternal = false } = {}) => {
  const period = await periodOf(periodId,tx);
  if (period.encabezado?.carga) return period.encabezado.carga;
  const [ofertas, docentes, raw, actividades, grupos] = await Promise.all([
    getOffers(period.id,tx), getTeachingStaff(period.id,tx,includeExternal), getAssignments(period.id,tx),
    rows(`SELECT id, docente_periodo_id, descripcion_actividad AS descripcion, horas_semanales AS horas, observaciones
      FROM public.asignacion_carga WHERE periodo_id=$1 AND modalidad='ACTIVIDAD_JP' ORDER BY id`,[period.id],tx),
    rows(`SELECT g.*,p.codigo plan,c.codigo carrera,c.id carrera_id,c.nombre carrera_nombre
      FROM public.grupo_academico g JOIN public.plan_estudio p ON p.id=g.plan_id JOIN public.carrera c ON c.id=p.carrera_id
      WHERE g.periodo_id=$1 ORDER BY c.codigo,g.ciclo,g.seccion`,[period.id],tx),
  ]);
  const ofertasPorAsignacion = Map.groupBy(ofertas, (offer) => offer.asignacion_id);
  const staffIds = new Set(docentes.map((teacher) => teacher.id));
  const asignaciones = raw.filter((assignment) => staffIds.has(assignment.docente_periodo_id)).map((assignment) => {
    const offers = ofertasPorAsignacion.get(assignment.id) || [];
    return {
      ...assignment, ofertas: offers,
      horas: assignment.modalidad==='REGULAR' ? (offers[0]?.horas ?? null)
        : assignment.modalidad==='FUSION' ? (assignment.horas_fusion ?? assignment.horas_semanales ?? 0)
          : (assignment.horas_semanales ?? offers[0]?.horas ?? 0),
    };
  });
  const porDocente = Map.groupBy(asignaciones, (a) => a.docente_periodo_id);
  const actividadesPorDocente = Map.groupBy(actividades, (a) => a.docente_periodo_id);
  const personal = docentes.map((d) => ({
    ...summarizeTeacher(d, porDocente.get(d.id) || [], actividadesPorDocente.get(d.id) || []),
    cursos_jp: d.tipo==='JP' ? asignaciones.filter((a) => a.jp_ids.includes(d.id)) : [],
  }));
  const hours = teacherHourIssues(personal);
  const pendientes = [
    ...ofertas.filter((o) => !o.asignacion_id).map((o) => ({ tipo: 'OFERTA', id: o.id, asignatura_id:o.asignatura_id, motivo: `${o.codigo} · ${o.nombre} · ${o.carrera} ${o.ciclo} ${o.seccion}: falta docente.` })),
    ...personal.filter((d) => d.regla_minimo_pendiente && d.situacion==='DOCENCIA').map((d) => ({ tipo:'REDUCCION',id:d.id,docente_id:d.docente_id,motivo:d.nombre_completo+': reducción de horas pendiente de precisar.' })),
    ...hours.pendientes,
    ...personal.filter((d) => d.tipo === 'JP' && d.situacion === 'DOCENCIA' && d.horas_cumplimiento === null)
      .map((d) => ({ tipo: 'JP', id: d.id, docente_id:d.docente_id, motivo: `${d.nombre_completo}: registra las horas de cumplimiento de JP.` })),
    ...asignaciones.filter((a) => a.modalidad === 'FUSION' ? a.ofertas.length < 2 || !a.fusion_habilitada || !a.fusion_pdf : a.ofertas.length !== 1)
      .map((a) => ({ tipo: 'ASIGNACION', id: a.id, motivo: 'Revisa la composición de la asignación y su sustento.' })),
  ];
  const fusions = await listFusions(period.id,tx);
  for (const f of fusions.filter((item) => !item.autorizada)) pendientes.push({ tipo:'FUSION',id:f.id,motivo:f.nombre+': falta sustento o habilitación.' });
  for (const o of ofertas.filter((item) => !item.horas)) pendientes.push({ tipo:'HORAS',id:o.id,asignatura_id:o.asignatura_id,motivo:o.codigo+': faltan horas computables.' });
  const { avisos } = hours;
  for (const a of asignaciones.filter((item) => item.modalidad==='REGULAR' && item.horas!=null && item.horas_programadas>item.horas)) {
    avisos.push({tipo:'HORARIO_EXCESO',id:a.id,motivo:a.ofertas.map((o) => o.codigo).join(' / ')+': '+a.horas_programadas+
      ' h programadas y '+a.horas+' h de malla. Revisa las sesiones guardadas.'});
  }
  for (const d of personal.filter((item) => !item.codigo_personal && (item.categoria || item.condicion))) {
    avisos.push({tipo:'CODIGO_PERSONAL',id:d.id,docente_id:d.docente_id,motivo:d.nombre_completo+
      ': verifica la categoría y registra el código de personal en campos separados.'});
  }
  const incomplete = await rows(`SELECT a.id,a.codigo,p.codigo AS plan FROM public.asignatura a JOIN public.plan_estudio p ON p.id=a.plan_id
    WHERE a.activa AND (a.horas_computables IS NULL OR a.ciclo IS NULL)
    AND (p.activo OR EXISTS (SELECT 1 FROM public.grupo_academico g WHERE g.periodo_id=$1 AND g.plan_id=p.id))
    AND NOT EXISTS (SELECT 1 FROM public.oferta_curso o WHERE o.periodo_id=$1 AND o.asignatura_id=a.id)
    ORDER BY p.codigo,a.codigo`,[period.id],tx);
  for (const a of incomplete) avisos.push({ tipo:'HORAS',id:a.id,asignatura_id:a.id,motivo:a.codigo+' · '+a.plan+': revisa el ciclo y las horas computables de la malla.' });
  const { encabezado: _snapshot, ...publicPeriod } = period;
  return { periodo: publicPeriod, ofertas, grupos, docentes: personal, asignaciones, pendientes, avisos };
};

const getAssignment = async (id, period, tx, external) => {
  const assignment = await one(`SELECT a.* FROM public.asignacion_carga a
    JOIN public.docente_periodo d ON d.id=a.docente_periodo_id
    WHERE a.id=$1 AND a.periodo_id=$2 AND a.rol='DOCENTE' AND (d.tipo='EXTERNO')=$3`,[idOf(id),period,external],tx);
  return assignment || notFound('No se encontró la asignación.');
};

const resolveSessions = async (assignment, body, tx) => {
  const result = await one('SELECT count(*)::int total FROM public.sesion_horario WHERE asignacion_id=$1',[assignment.id],tx);
  if (!result.total) return;
  if (body?.retirar_sesiones !== true) conflict(`La asignación tiene ${result.total} sesiones. Confirma su retiro para continuar.`);
  await rows('DELETE FROM public.sesion_horario WHERE asignacion_id=$1',[assignment.id],tx);
};

const validatedIds = (value, max) => {
  if (!Array.isArray(value) || value.length > max) invalid('Revisa la lista de registros seleccionados.');
  const ids = value.map(idOf);
  if (new Set(ids).size !== ids.length) invalid('No repitas registros en la selección.');
  return ids;
};

const validateAssignment = async (period, body, id, tx, external) => {
  const modalidad = body?.modalidad;
  if (!['REGULAR','DIRIGIDO','FUSION'].includes(modalidad)) invalid('Selecciona una modalidad válida.');
  const docente = idOf(body.docente_periodo_id);
  const offerIds = validatedIds(body.oferta_ids, 20);
  const jpIds = validatedIds(body.jp_ids ?? [], 20);
  if (modalidad === 'FUSION' ? offerIds.length < 2 : offerIds.length !== 1) {
    invalid('Selecciona una oferta para una carga regular o dirigida, y dos o más para una fusión.');
  }
  const staff = await getTeachingStaff(period,tx,external);
  const teacher = staff.find((d) => d.id === docente);
  if (!teacher?.activo || teacher.situacion !== 'DOCENCIA' || teacher.tipo === 'JP') invalid('Selecciona un docente activo con docencia en este período.');
  if (external && (teacher.tipo!=='EXTERNO' || modalidad!=='REGULAR' || jpIds.length)) {
    invalid('Selecciona un docente externo del semestre y una clase regular.');
  }
  if (jpIds.some((jp) => !staff.some((d) => d.id === jp && d.activo && d.tipo === 'JP' && d.situacion === 'DOCENCIA'))) {
    invalid('Selecciona jefes de práctica activos con docencia del período.');
  }
  const offers = (await getOffers(period,tx)).filter((o) => offerIds.includes(o.id));
  if (offers.length !== offerIds.length) invalid('Selecciona ofertas válidas del mismo período.');
  if (external && offers.some((o) => o.carrera_id!==teacher.carrera_referencia_id)) {
    invalid('La asignatura y el grupo deben pertenecer a la carrera donde enseñará el docente este semestre.');
  }
  if (offers.some((o) => o.asignacion_id && o.asignacion_id !== id)) conflict('Una de las ofertas ya tiene asignación.');
  const hoursAssigned=modalidad==='REGULAR' ? offers[0].horas
    : modalidad==='DIRIGIDO' ? Number(body.horas_asignadas ?? offers[0]?.horas) : null;
  if (modalidad==='REGULAR' && !hoursAssigned) invalid('Completa las horas de la malla antes de guardar la asignación regular.');
  if (modalidad!=='FUSION' && (!Number.isInteger(hoursAssigned) || hoursAssigned<1 || hoursAssigned>90)) {
    invalid('Indica entre 1 y 90 horas computables para la asignación, en horas completas.');
  }
  let fusion = null;
  let authorized = null;
  if (modalidad === 'FUSION') {
    if (new Set(offers.map((o) => o.turno)).size !== 1) invalid('Los grupos de la fusión deben compartir franja.');
    if (new Set(offers.map((o) => o.grupo_id)).size !== offers.length) invalid('La fusión requiere grupos distintos.');
    if (offers.length!==2) invalid('Una fusión vincula dos cursos distintos.');
    authorized = await findCombination(period,offers.map((o) => o.asignatura_id),tx);
    if (body.fusion_id && String(body.fusion_id)!==authorized?.id) invalid('Las ofertas no corresponden a la combinación seleccionada.');
    if (authorized && !authorized.habilitada) invalid('Autoriza primero la combinación en Resoluciones y fusiones.');
    const documento = authorized?.resolucion_id ?? idOf(body.documento_id);
    const resolution = await one("SELECT id FROM public.documento WHERE id=$1 AND tipo='RESOLUCION' AND contenido_pdf IS NOT NULL",[documento],tx);
    if (!resolution) invalid('Adjunta el PDF de la resolución antes de autorizar o asignar la fusión.');
    if (new Set(offers.map((o) => o.asignatura_id)).size!==offers.length) invalid('Selecciona cursos distintos.');
    const hours = Number(authorized?.horas_compartidas ?? body.horas_fusion);
    if (!Number.isInteger(hours) || hours <= 0 || hours > 30) {
      invalid('Indica entre 1 y 30 horas compartidas según la resolución.');
    }
    fusion = { periodo_id: period, resolucion_id: documento, horas_compartidas: hours,
      nombre: 'Fusión ' + offers.map((offer) => offer.codigo).join(' / ').slice(0, 100), habilitada: true };
  }
  if (body.observaciones != null && (typeof body.observaciones !== 'string' || body.observaciones.length > 2000)) invalid('Revisa las observaciones.');
  return { docente, teacher, modalidad, offers, offerIds, jpIds, fusion, authorized, hoursAssigned, observaciones: body.observaciones?.trim() || null };
};

export const saveAssignmentForPeriod = async (period, body, id, tx, { external = false } = {}) => {
  const old = id && await getAssignment(id,period.id,tx,external);
  const data = await validateAssignment(period.id,body,old?.id,tx,external);
  if (old) {
    const previous = await one(`SELECT
      ARRAY(SELECT oferta_id FROM public.asignacion_oferta WHERE asignacion_id=$1 ORDER BY oferta_id) ofertas,
      ARRAY(SELECT docente_periodo_id FROM public.asignacion_jp WHERE asignacion_id=$1 ORDER BY docente_periodo_id) jp`,[old.id],tx);
    const sameIds = (a,b) => a.length === b.length && a.every((x) => b.includes(x));
    const changed = old.docente_periodo_id !== data.docente || old.modalidad !== data.modalidad ||
      !sameIds(previous.ofertas,data.offerIds) || !sameIds(previous.jp,data.jpIds) ||
      Number(old.horas_semanales)!==(data.fusion?.horas_compartidas ?? data.hoursAssigned);
    if (changed) await resolveSessions(old,body,tx);
    await rows('DELETE FROM public.asignacion_oferta WHERE asignacion_id=$1',[old.id],tx);
    await rows('DELETE FROM public.asignacion_jp WHERE asignacion_id=$1',[old.id],tx);

  }
  const fusion = data.fusion && (data.authorized ?? await putRow('fusion',data.fusion,tx));
  const assignment = await putRow('asignacion_carga',{
    periodo_id: period.id, docente_periodo_id: data.docente, docente_id: data.teacher.docente_id,
    rol: 'DOCENTE', modalidad: data.modalidad, horas_semanales: data.fusion?.horas_compartidas ?? data.hoursAssigned,
    fusion_id: fusion?.id ?? null, observaciones: data.observaciones,
  },tx,old?.id);

  for (const offer of data.offers) {
    await rows("INSERT INTO public.asignacion_oferta (asignacion_id,oferta_id,periodo_id,rol) VALUES($1,$2,$3,'DOCENTE')",
      [assignment.id,offer.id,period.id],tx);
    if (fusion && !data.authorized) await rows('INSERT INTO public.fusion_asignatura (fusion_id,asignatura_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [fusion.id,offer.asignatura_id],tx);
  }
  for (const jp of data.jpIds) await rows('INSERT INTO public.asignacion_jp (asignacion_id,docente_periodo_id,periodo_id) VALUES($1,$2,$3)',[assignment.id,jp,period.id],tx);
  await rows('UPDATE public.periodo_academico SET carga_completa=false WHERE id=$1',[period.id],tx);
  return assignment;
};

export const saveAssignment = (periodId, body, id, options) => atomic(async (tx) =>
  saveAssignmentForPeriod(await periodOf(periodId,tx,true),body,id,tx,options));

export const removeAssignment = (periodId, id, body, { external = false } = {}) => atomic(async (tx) => {
  const period = await periodOf(periodId,tx,true);
  const old = await getAssignment(id,period.id,tx,external);
  await resolveSessions(old,body,tx);
  await rows('DELETE FROM public.asignacion_carga WHERE id=$1',[old.id],tx);

  await rows('UPDATE public.periodo_academico SET carga_completa=false WHERE id=$1',[period.id],tx);
});

export const completeLoad = (periodId) => atomic(async (tx) => {
  await periodOf(periodId,tx,true);
  const load = await getLoad(periodId,tx);
  if (!load.ofertas.length) conflict('Registra al menos una oferta académica.');
  if (load.pendientes.length) conflict(load.pendientes[0].motivo);
  return one('UPDATE public.periodo_academico SET carga_completa=true WHERE id=$1 RETURNING *',[periodId],tx);
});

