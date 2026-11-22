import { atomic, conflict, idOf, invalid, notFound, one, periodOf, putRow, rows } from './database.js';

export const listFusions = async (periodId, tx) => {
  const period = await periodOf(periodId,tx);
  return rows(`SELECT f.id,f.nombre,f.resolucion_id,f.horas_compartidas,f.habilitada,d.numero,
    (f.habilitada AND f.horas_compartidas>0 AND d.contenido_pdf IS NOT NULL) AS autorizada,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id::text,'codigo',a.codigo,'nombre',a.nombre,
      'plan',p.codigo,'carrera',c.codigo) ORDER BY a.id)
      FROM public.fusion_asignatura fa JOIN public.asignatura a ON a.id=fa.asignatura_id
      JOIN public.plan_estudio p ON p.id=a.plan_id JOIN public.carrera c ON c.id=p.carrera_id
      WHERE fa.fusion_id=f.id),'[]'::jsonb) AS cursos
    FROM public.fusion f LEFT JOIN public.documento d ON d.id=f.resolucion_id WHERE f.periodo_id=$1 ORDER BY f.id`,[period.id],tx);
};

export const findCombination = (period, subjects, tx) => one(`SELECT f.* FROM public.fusion f
  WHERE f.periodo_id=$1 AND ARRAY(SELECT asignatura_id FROM public.fusion_asignatura
    WHERE fusion_id=f.id ORDER BY asignatura_id)=ARRAY(SELECT x FROM unnest($2::bigint[]) x ORDER BY x)
  ORDER BY f.id LIMIT 1`,[period,subjects],tx);

export const authorizeFusion = (periodId, body, fusionId) => atomic(async (tx) => {
  const period = await periodOf(periodId,tx,true);
  if (!Array.isArray(body?.asignatura_ids) || body.asignatura_ids.length!==2) invalid('Selecciona dos cursos distintos.');
  const subjects = body.asignatura_ids.map(idOf);
  if (new Set(subjects).size!==2) invalid('Selecciona dos cursos distintos.');
  const combination = await findCombination(period.id,subjects,tx);
  if (combination && combination.id!==fusionId) conflict('Esta combinación de cursos ya está registrada en el semestre.');
  const previous = fusionId && await one('SELECT id FROM public.fusion WHERE id=$1 AND periodo_id=$2',[idOf(fusionId),period.id],tx);
  if (fusionId && !previous) invalid('La fusión no pertenece a este semestre.');
  const available = await rows('SELECT id,codigo FROM public.asignatura WHERE id=ANY($1::bigint[]) AND activa ORDER BY id',[subjects],tx);
  if (available.length!==2) invalid('Selecciona dos cursos activos.');
  const document = idOf(body.resolucion_id);
  const hours = Number(body.horas_compartidas);
  if (!Number.isInteger(hours) || hours<1 || hours>30) invalid('Indica entre 1 y 30 horas autorizadas.');
  if (!await one("SELECT id FROM public.documento WHERE id=$1 AND tipo='RESOLUCION' AND contenido_pdf IS NOT NULL",[document],tx)) {
    invalid('Adjunta el PDF de la resolución antes de autorizar la fusión.');
  }
  if (previous) {
    const assignments=await rows('SELECT horas_semanales FROM public.asignacion_carga WHERE fusion_id=$1',[previous.id],tx);
    if (assignments.length && (combination?.id!==previous.id || assignments.some((a) => Number(a.horas_semanales)!==hours))) {
      conflict('Retira las asignaciones vinculadas antes de cambiar los cursos o las horas autorizadas.');
    }
  }
  const saved = await putRow('fusion',{ periodo_id:period.id,nombre:'Fusión '+available.map((a) => a.codigo).join(' / ').slice(0,100),
    resolucion_id:document,horas_compartidas:hours,habilitada:true },tx,fusionId);
  if (fusionId) await rows('DELETE FROM public.fusion_asignatura WHERE fusion_id=$1',[saved.id],tx);
  for (const id of subjects) await rows('INSERT INTO public.fusion_asignatura(fusion_id,asignatura_id) VALUES($1,$2)',[saved.id,id],tx);
  return saved;
});


export const removeFusion = (periodId, fusionId) => atomic(async (tx) => {
  const period=await periodOf(periodId,tx,true);
  const id=idOf(fusionId);
  if (!await one('SELECT id FROM public.fusion WHERE id=$1 AND periodo_id=$2',[id,period.id],tx)) notFound();
  if (await one('SELECT id FROM public.asignacion_carga WHERE fusion_id=$1 LIMIT 1',[id],tx)) {
    conflict('Retira las asignaciones vinculadas antes de eliminar la fusión.');
  }
  await rows('DELETE FROM public.fusion_asignatura WHERE fusion_id=$1',[id],tx);
  await rows('DELETE FROM public.fusion WHERE id=$1',[id],tx);
});
