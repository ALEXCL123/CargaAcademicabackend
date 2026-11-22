import { createHash } from 'node:crypto';
import { atomic, conflict, idOf, notFound, one, rows } from './database.js';
import { summarizeTeacher, teacherHourIssues } from './load.service.js';
import { progress } from './schedule.service.js';

const ids = (records) => records.map((record) => record.id);

const impactFor = async (id, tx) => {
  const asignatura = await one('SELECT id,codigo,nombre FROM public.asignatura WHERE id=$1',[id],tx);
  if (!asignatura) notFound('No se encontró la asignatura.');
  const ofertas = await rows(`SELECT o.id,o.periodo_id,g.ciclo,g.seccion,c.nombre carrera
    FROM public.oferta_curso o JOIN public.grupo_academico g ON g.id=o.grupo_id
    JOIN public.plan_estudio p ON p.id=g.plan_id JOIN public.carrera c ON c.id=p.carrera_id
    WHERE o.asignatura_id=$1 ORDER BY o.id`,[id],tx);
  const fusiones = await rows(`SELECT f.id,f.periodo_id,f.nombre,f.horas_compartidas,
    ARRAY(SELECT a.codigo FROM public.fusion_asignatura x JOIN public.asignatura a ON a.id=x.asignatura_id
      WHERE x.fusion_id=f.id ORDER BY a.id) cursos
    FROM public.fusion f JOIN public.fusion_asignatura x ON x.fusion_id=f.id
    WHERE x.asignatura_id=$1 ORDER BY f.id`,[id],tx);
  const asignaciones = await rows(`SELECT a.id,a.periodo_id,d.nombre_completo docente,a.modalidad,a.horas_semanales
    FROM public.asignacion_carga a JOIN public.docente d ON d.id=a.docente_id
    WHERE a.fusion_id=ANY($1::bigint[]) OR EXISTS(SELECT 1 FROM public.asignacion_oferta x
      WHERE x.asignacion_id=a.id AND x.oferta_id=ANY($2::bigint[])) ORDER BY a.id`,[ids(fusiones),ids(ofertas)],tx);
  const bloques = await rows(`SELECT s.id,s.periodo_id,s.asignacion_id,s.dia,s.hora_inicio,s.hora_fin,r.codigo aula
    FROM public.sesion_horario s LEFT JOIN public.ambiente r ON r.id=s.ambiente_id
    WHERE s.asignacion_id=ANY($1::bigint[]) ORDER BY s.id`,[ids(asignaciones)],tx);
  const ofertasLiberadas = await rows(`SELECT DISTINCT o.id,o.periodo_id,a.codigo,a.nombre,g.ciclo,g.seccion
    FROM public.asignacion_oferta x JOIN public.oferta_curso o ON o.id=x.oferta_id
    JOIN public.asignatura a ON a.id=o.asignatura_id JOIN public.grupo_academico g ON g.id=o.grupo_id
    WHERE x.asignacion_id=ANY($1::bigint[]) AND o.asignatura_id<>$2 ORDER BY o.id`,[ids(asignaciones),id],tx);
  const affectedPeriods = [...new Set([...ofertas,...fusiones,...asignaciones,...bloques].map((record) => record.periodo_id))];
  const periodos = await rows(`SELECT p.id,p.anio,p.numero semestre,p.estado FROM public.periodo_academico p
    WHERE p.id=ANY($1::bigint[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.encabezado->'carga'->'avisos') aviso
      WHERE aviso->>'asignatura_id'=$2) ORDER BY p.anio,p.numero,p.id`,[affectedPeriods,id],tx);
  const impact = { asignatura,ofertas,fusiones,asignaciones,bloques,ofertasLiberadas,periodos };
  return { ...impact, revision:createHash('sha256').update(JSON.stringify(impact)).digest('hex') };
};

export const inspectCourseDeletion = (id) => atomic((tx) => impactFor(idOf(id),tx));

const cleanSnapshot = (snapshot, impact) => {
  const assignmentIds = new Set(ids(impact.asignaciones));
  const fusionIds = new Set(ids(impact.fusiones));
  const courseId = impact.asignatura.id;
  const clean = (view) => {
    if (!view) return;
    const keepAssignment = (a) => !assignmentIds.has(a.id);
    const keepIssue = (issue) => issue.asignatura_id!==courseId
      && (!['ASIGNACION','HORARIO_EXCESO'].includes(issue.tipo) || !assignmentIds.has(issue.id))
      && (issue.tipo!=='FUSION' || !fusionIds.has(issue.id));
    const freed = view.ofertas.filter((offer) => offer.asignatura_id!==courseId && assignmentIds.has(offer.asignacion_id));
    view.ofertas = view.ofertas.filter((offer) => offer.asignatura_id!==courseId)
      .map((offer) => assignmentIds.has(offer.asignacion_id) ? { ...offer,asignacion_id:null } : offer);
    view.asignaciones = view.asignaciones.filter(keepAssignment);
    const affectedTeachers = new Set();
    view.docentes = view.docentes.map((teacher) => {
      const assignments = teacher.asignaciones.filter(keepAssignment);
      if (assignments.length!==teacher.asignaciones.length) affectedTeachers.add(teacher.id);
      return { ...summarizeTeacher(teacher,assignments,teacher.actividades),cursos_jp:(teacher.cursos_jp ?? []).filter(keepAssignment) };
    });
    const hours = teacherHourIssues(view.docentes.filter((teacher) => affectedTeachers.has(teacher.id)));
    view.pendientes = view.pendientes.filter((issue) => keepIssue(issue) &&
      (!['MINIMO','REFERENCIA'].includes(issue.tipo) || !affectedTeachers.has(issue.id)));
    view.pendientes.push(...hours.pendientes,...freed.map((offer) => ({tipo:'OFERTA',id:offer.id,asignatura_id:offer.asignatura_id,
      motivo:`${offer.codigo} · ${offer.nombre}: falta docente.`})));
    view.avisos = (view.avisos ?? []).filter((issue) => keepIssue(issue) && (issue.tipo!=='EXCESO' || !affectedTeachers.has(issue.id)));
    view.avisos.push(...hours.avisos);
    view.periodo.carga_completa = false;
    if (view.sesiones) {
      view.sesiones = view.sesiones.filter((session) => !assignmentIds.has(session.asignacion_id));
      view.avance = progress(view);
    }
  };
  clean(snapshot.carga);
  clean(snapshot.horario);
  return snapshot;
};

export const deleteCourse = (id, revision) => atomic(async (tx) => {
  const key = idOf(id);
  const impact = await impactFor(key,tx);
  if (revision!==impact.revision) conflict('El impacto de la eliminación cambió. Revisa los registros afectados antes de confirmar.');
  await rows('DELETE FROM public.sesion_horario WHERE id=ANY($1::bigint[])',[ids(impact.bloques)],tx);
  await rows('DELETE FROM public.asignacion_carga WHERE id=ANY($1::bigint[])',[ids(impact.asignaciones)],tx);
  await rows('DELETE FROM public.fusion WHERE id=ANY($1::bigint[])',[ids(impact.fusiones)],tx);
  await rows('DELETE FROM public.oferta_curso WHERE id=ANY($1::bigint[])',[ids(impact.ofertas)],tx);
  await rows('DELETE FROM public.asignatura WHERE id=$1',[key],tx);
  const periods = ids(impact.periodos);
  await rows('UPDATE public.periodo_academico SET carga_completa=false WHERE id=ANY($1::bigint[])',[periods],tx);
  const snapshots = await rows('SELECT id,encabezado FROM public.periodo_academico WHERE id=ANY($1::bigint[]) AND encabezado IS NOT NULL',[periods],tx);
  for (const {id:period,encabezado} of snapshots) {
    await rows('UPDATE public.periodo_academico SET encabezado=$2 WHERE id=$1',[period,JSON.stringify(cleanSnapshot(encabezado,impact))],tx);
  }
});
