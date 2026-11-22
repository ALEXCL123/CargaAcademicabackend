import { Op } from 'sequelize';
import { models } from '../models/catalogs.js';
import { atomic, conflict, idOf, invalid, localDepartmentId, notFound, one, periodOf, putRow, rows, turno } from './database.js';
import { saveAssignmentForPeriod } from './load.service.js';

const catalog = (table, fields, search = [], periodKey) => ({ table, fields, search, periodKey });
const name = { nombre: 'text' };
const active = { activo: 'bool' };
const teacherFields = { identificacion: '?text', nombres: '?text', apellidos: '?text', ...active };
const teacherSearch = ['identificacion','nombres','apellidos','nombre_completo'];
export const catalogs = {
  departamentos: catalog('departamento_academico', { ...name, ...active }, ['nombre']),
  carreras: catalog('carrera', { codigo: ['EIIB','CPG'], ...name, ...active }, ['codigo','nombre']),
  planes: catalog('plan_estudio', { carrera_id: 'id', codigo: 'text', ...name, anio: 'year', documento_id: '?id', ...active }, ['codigo','nombre']),
  asignaturas: catalog('asignatura', { plan_id: 'id', departamento_id: '?id', codigo: 'text', ...name, ciclo: '?cycle', creditos: '?decimal', teoria: '?hours', practica: '?hours', laboratorio: '?hours', requisito: '?text', ...active }, ['codigo','nombre']),
  docentes: catalog('docente', teacherFields, teacherSearch),
  'docentes-externos': catalog('docente', { ...teacherFields, nombres:'text', apellidos:'text', departamento_id:'id' }, teacherSearch),
  'docentes-periodo': catalog('docente_periodo', { periodo_id: 'id', docente_id: 'id', carrera_reporte_id: '?id', tipo: ['NOMBRADO','CONTRATADO','JP'], categoria: '?text', codigo_personal: '?text', condicion: '?text', jornada: 'workweek', situacion: ['DOCENCIA','SABATICO','SIN_DOCENCIA'], cargo: '?text', responsabilidades: '?text', observaciones: '?text', documento_id: '?id', horas_cumplimiento: '?decimal', carrera_referencia_id: '?id', minimo_lectivo_excepcional: '?decimal', regla_minimo_pendiente: '?bool', referencia_sustento: '?text', horas_referencia: '?decimal' }, [], 'periodo_id'),
  'actividades-jp': catalog('actividad_jp', { docente_periodo_id: 'id', descripcion: 'text', horas: 'positive', observaciones:'?text' }, ['descripcion']),
  ambientes: catalog('ambiente', { codigo: 'text', ...name, ubicacion: 'text', tipo: ['AULA','SALA','LABORATORIO'], carrera_id: '?id', ...active }, ['codigo','nombre','ubicacion']),
  grupos: catalog('grupo_academico', { periodo_id: 'id', plan_id: 'id', ciclo: 'cycle', seccion: ['','A','B','UNICA','UNICO'] }, [], 'periodo_id'),
  ofertas: catalog('oferta_curso', { periodo_id: 'id', grupo_id: 'id', asignatura_id: 'id' }, [], 'periodo_id'),
  documentos: catalog('documento', { tipo: ['RESOLUCION','CARTA','INFORME','OTRO'], numero: 'text', fecha: '?date', observaciones: '?text' }, ['numero','observaciones']),
  'documentos-horario': catalog('documento_horario', { periodo_id: 'id', carrera_id: 'id', documento_id: 'id', orden: 'positive' }, [], 'periodo_id'),
};
const get = (resource) => Object.hasOwn(catalogs, resource) ? catalogs[resource] : notFound();
const ranges = { year: [1900, 2200], periodYear: [2000, 2200], workweek: [1, 80], cycle: [1, 10], hours: [0, 30], positive: [1, 9999], decimal: [0, 999] };
export const valueOf = (field, value, type) => {
  const bad = () => invalid(`Revisa el campo ${field.replaceAll('_', ' ')}.`);
  if (Array.isArray(type)) return type.includes(value) ? value : bad();
  if (type.startsWith('?')) return value == null || value === '' ? null : valueOf(field, value, type.slice(1));
  if (type === 'id') return idOf(value);
  if (type === 'bool') return typeof value === 'boolean' ? value : bad();
  if (type === 'text') return typeof value === 'string' && value.trim() && value.length <= 2000 ? value.trim() : bad();
  if (type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad();
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0,10) === value ? value : bad();
  }
  if (type === 'hours' && (value == null || value === '')) return 0;
  if (!['string','number'].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) return bad();
  const number = Number(value);
  const [min,max] = ranges[type];
  return number >= min && number <= max && (type === 'decimal' || Number.isInteger(number)) ? number : bad();
};
const parse = (body, fields) => Object.fromEntries(Object.entries(fields).map(([field, type]) =>
  [field, valueOf(field, body?.[field] ?? (type === 'bool' ? true : undefined), type)]));
const present = (table, row) => {
  if (table === 'periodo_academico') row.estado = row.estado === 'FINALIZADO' ? 'CERRADO' : 'ABIERTO';
  if (table === 'docente_periodo' && row.situacion === 'ACTIVO') row.situacion = 'DOCENCIA';
  if (table === 'grupo_academico' && row.seccion === 'UNICO') row.seccion = 'UNICA';
  return row;
};
const publicAttributes = (table) => table === 'documento' ? { exclude: ['contenido_pdf'] } : undefined;
const exists = (sql, bind, tx) => one(sql, bind, tx);
const isExternal = (person, home) => person.departamento_id != null && person.departamento_id!==home;

export const list = async (resource, query) => {
  const { table, search, periodKey } = get(resource);
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 30));
  const where = {};
  if (periodKey && query.periodo_id) where[periodKey] = idOf(query.periodo_id);
  if (table==='docente_periodo') where.tipo={ [Op.ne]:'EXTERNO' };
  if (table === 'actividad_jp' && query.periodo_id) {
    const records = await rows('SELECT id FROM public.docente_periodo WHERE periodo_id=$1', [idOf(query.periodo_id)]);
    where.docente_periodo_id = { [Op.in]: records.map(({ id }) => id) };
  }
  if (table === 'asignatura') {
    if (query.activos==='1') where.activo=true;
    if (query.carrera) {
      const plans = await rows(`SELECT p.id FROM public.plan_estudio p JOIN public.carrera c ON c.id=p.carrera_id WHERE c.codigo=$1`,
        [valueOf('carrera',query.carrera,['EIIB','CPG'])]);
      where.plan_id = { [Op.in]: plans.map(({ id }) => id) };
    }
    if (query.solo_oferta === '1') {
      const offers = await rows('SELECT DISTINCT asignatura_id FROM public.oferta_curso WHERE periodo_id=$1',[idOf(query.periodo_id)]);
      where.id = { [Op.in]: offers.map(({ asignatura_id }) => asignatura_id) };
    }
  }
  if (table === 'docente' && query.periodo_id && (query.carrera || query.tipo)) {
    const people = await rows(`SELECT d.docente_id FROM public.docente_periodo d LEFT JOIN public.carrera c ON c.id=COALESCE(d.carrera_referencia_id,d.carrera_reporte_id)
      WHERE d.periodo_id=$1 AND ($2::text IS NULL OR c.codigo=$2) AND ($3::text IS NULL OR d.tipo=$3)`,
      [idOf(query.periodo_id),query.carrera ? valueOf('carrera',query.carrera,['EIIB','CPG']) : null,
        query.tipo ? valueOf('tipo',query.tipo,['NOMBRADO','CONTRATADO','JP']) : null]);
    where.id = { [Op.in]: people.map(({ docente_id }) => docente_id) };
  }
  if (table === 'docente') {
    const home=await localDepartmentId();
    if (resource==='docentes-externos') {
      where.departamento_id={[Op.ne]:home};
      if (query.departamento_id) where.departamento_id[Op.eq]=idOf(query.departamento_id);
    } else {
      where.departamento_id={ [Op.or]:[null,...(home ? [home] : [])] };
    }
  }
  if (table==='departamento_academico' && query.ambito==='externo') {
    const home=await localDepartmentId();
    if (home) where.id={ [Op.ne]:home };
  }
  const q = typeof query.q === 'string' ? query.q.trim().slice(0,100) : '';
  if (q && search.length) where[Op.or] = search.map((field) => ({ [field]: { [Op.iLike]: '%' + q.replace(/[\\%_]/g, '\\$&') + '%' } }));
  const records = await models[table].findAndCountAll({ where, attributes: publicAttributes(table), order: [['id','ASC']], limit, offset: (page-1)*limit, raw: true });
  let items=records.rows.map((row) => present(table, row));
  if (resource==='docentes-externos' && query.periodo_id && items.length) {
    const profiles=await rows(`SELECT id,docente_id,carrera_referencia_id FROM public.docente_periodo
      WHERE periodo_id=$1 AND tipo='EXTERNO' AND docente_id=ANY($2::bigint[])`,[idOf(query.periodo_id),items.map(({id}) => id)]);
    const linked=await rows(`SELECT a.docente_periodo_id,a.id asignacion_id,o.id oferta_id,o.asignatura_id,o.grupo_id,m.codigo,m.nombre,g.ciclo,g.seccion
      FROM public.asignacion_carga a JOIN public.asignacion_oferta x ON x.asignacion_id=a.id
      JOIN public.oferta_curso o ON o.id=x.oferta_id JOIN public.asignatura m ON m.id=o.asignatura_id
      JOIN public.grupo_academico g ON g.id=o.grupo_id
      WHERE a.docente_periodo_id=ANY($1::bigint[]) ORDER BY a.id,o.id`,[profiles.map(({id}) => id)]);
    const byPerson=new Map(profiles.map((p) => [p.docente_id,p]));
    const byProfile=Map.groupBy(linked,(row) => row.docente_periodo_id);
    items=items.map((person) => {
      const profile=byPerson.get(person.id);
      return {...person,carrera_id:profile?.carrera_referencia_id ?? null,clases:byProfile.get(profile?.id) ?? []};
    });
  }
  return { items, total: records.count, page, limit };
};

export const detail = async (resource, id) => {
  const { table } = get(resource);
  const row = await models[table].findByPk(idOf(id), { attributes: publicAttributes(table), raw: true });
  if (table==='docente_periodo' && row?.tipo==='EXTERNO') notFound();
  if (row && table==='docente' && isExternal(row,await localDepartmentId())!==(resource==='docentes-externos')) notFound();
  return row ? present(table, row) : notFound();
};

const clearCompletion = async (period, tx) => {
  if (period) await rows('UPDATE public.periodo_academico SET carga_completa=false WHERE id=$1', [period], tx);
};
const denyWhen = async (condition, message) => { if (await condition) conflict(message); };

const validate = async (table, data, old, tx) => {
  if (old && data.periodo_id && data.periodo_id !== String(old.periodo_id)) conflict('El período de un registro existente no se puede cambiar.');
  if (data.periodo_id) await periodOf(data.periodo_id, tx, true);

  if (table === 'carrera' && old && data.codigo !== old.codigo) conflict('El código de carrera determina sus franjas y se conserva.');
  if (table === 'plan_estudio' && old && data.carrera_id !== String(old.carrera_id)) {
    await denyWhen(exists('SELECT 1 FROM public.grupo_academico WHERE plan_id=$1 LIMIT 1',[old.id],tx),'El plan tiene grupos registrados.');
  }
  if (table==='asignatura' && old && (String(data.plan_id)!==String(old.plan_id) || data.ciclo!==old.ciclo)) {
    await denyWhen(exists('SELECT 1 FROM public.oferta_curso WHERE asignatura_id=$1 LIMIT 1',[old.id],tx),
      'Quita la oferta del curso antes de cambiar su malla o ciclo.');
  }
  if (table === 'grupo_academico') {
    const plan = await one('SELECT p.activo,c.codigo,c.activa carrera_activa FROM public.plan_estudio p JOIN public.carrera c ON c.id=p.carrera_id WHERE p.id=$1',[data.plan_id],tx);
    if (!plan || (!old && (!plan.activo || !plan.carrera_activa))) invalid('Selecciona un plan y carrera activos.');
    data.turno = turno(plan.codigo,data.ciclo);
    if (!data.seccion || data.seccion === 'UNICA') data.seccion = 'UNICO';
    if (old && (data.plan_id !== String(old.plan_id) || data.ciclo !== old.ciclo)) {
      await denyWhen(exists('SELECT 1 FROM public.oferta_curso WHERE grupo_id=$1 UNION ALL SELECT 1 FROM public.ocupacion_grupo WHERE grupo_id=$1 LIMIT 1',[old.id],tx),
        'El grupo tiene ofertas o sesiones y no se puede cambiar de plan o ciclo.');
    }
  }
  if (table === 'oferta_curso') {
    const row = await one(`SELECT g.periodo_id,g.plan_id grupo_plan,g.ciclo grupo_ciclo,a.plan_id,a.ciclo, COALESCE(a.horas_computables,0) AS horas, a.activa AS activo
      FROM public.grupo_academico g CROSS JOIN public.asignatura a WHERE g.id=$1 AND a.id=$2`,[data.grupo_id,data.asignatura_id],tx);
    if (!row || String(row.periodo_id) !== data.periodo_id || row.grupo_plan !== row.plan_id || row.grupo_ciclo !== row.ciclo || row.horas <= 0 || (!old && !row.activo)) {
      invalid('El grupo y la asignatura deben compartir período, plan y ciclo. La asignatura debe estar activa y tener horas.');
    }
    if (old && (data.grupo_id !== String(old.grupo_id) || data.asignatura_id !== String(old.asignatura_id))) {
      await denyWhen(exists('SELECT 1 FROM public.asignacion_oferta WHERE oferta_id=$1',[old.id],tx),'Retira primero la asignación de carga.');
    }
  }

  if (table === 'docente' && old && !data.activo && old.activo) {
    await denyWhen(exists(`SELECT 1 FROM public.docente_periodo d JOIN public.periodo_academico p ON p.id=d.periodo_id
      WHERE d.docente_id=$1 AND p.estado='BORRADOR' AND (
      EXISTS(SELECT 1 FROM public.asignacion_carga WHERE docente_periodo_id=d.id) OR
      EXISTS(SELECT 1 FROM public.asignacion_jp WHERE docente_periodo_id=d.id) OR
      EXISTS(SELECT 1 FROM public.sesion_horario WHERE periodo_id=p.id AND docente_id=d.docente_id)) LIMIT 1`,[old.id],tx),
      'Retira las asignaciones y sesiones del docente en períodos abiertos antes de desactivarlo.');
  }
  if (table === 'docente_periodo') {
    if (data.situacion === 'DOCENCIA') data.situacion = 'ACTIVO';
    if (data.tipo !== 'JP' && data.horas_cumplimiento !== null) invalid('Las horas de cumplimiento se registran solo para JP.');
    if (data.situacion === 'SABATICO' && !data.documento_id && !data.referencia_sustento && !data.observaciones) invalid('Selecciona un documento o registra la referencia de sustento para el sabático.');
    if (data.minimo_lectivo_excepcional != null && Number(data.minimo_lectivo_excepcional)!==Number(old?.minimo_lectivo_excepcional ?? -1) && (!data.documento_id || data.tipo==='JP' || data.situacion!=='ACTIVO' || data.regla_minimo_pendiente || data.minimo_lectivo_excepcional > data.jornada / 2)) {
      invalid('Un mínimo reducido requiere docencia, documento de sustento y un valor entre cero y la mitad de la jornada.');
    }
    data.regla_minimo_pendiente ??= old?.regla_minimo_pendiente ?? false;
    const person=await one('SELECT activo,departamento_id FROM public.docente WHERE id=$1',[data.docente_id],tx);
    if (person && isExternal(person,await localDepartmentId(tx))) invalid('El docente pertenece a otro departamento.');
    if (!old && !person?.activo) invalid('Selecciona un docente activo.');
    if (old && data.docente_id !== String(old.docente_id)) conflict('El registro pertenece a otro docente. Crea un registro independiente.');
    const changesAcademicRole = old && ((data.tipo === 'JP') !== (old.tipo === 'JP'));
    if (old && (data.situacion !== 'ACTIVO' || changesAcademicRole)) {
      await denyWhen(exists(`SELECT 1 FROM public.asignacion_carga WHERE docente_periodo_id=$1
        UNION ALL SELECT 1 FROM public.asignacion_jp WHERE docente_periodo_id=$1
        LIMIT 1`,[old.id],tx),
        'Resuelve las asignaciones o actividades vinculadas antes de cambiar la situación o el tipo.');
    }
  }
  if (table === 'actividad_jp') {
    const jp = await one('SELECT * FROM public.docente_periodo WHERE id=$1',[data.docente_periodo_id],tx);
    if (!jp || jp.tipo !== 'JP' || jp.situacion !== 'ACTIVO' || Number(data.horas) <= 0) invalid('Selecciona un JP con docencia y registra horas positivas.');
    await periodOf(jp.periodo_id,tx,true);
    if (old && old.periodo_id !== jp.periodo_id) conflict('La actividad pertenece a otro período.');
    Object.assign(data, { periodo_id: jp.periodo_id, docente_id: jp.docente_id, rol: 'JP', modalidad: 'ACTIVIDAD_JP' });
    if (old && (String(old.docente_periodo_id) !== data.docente_periodo_id || Number(old.horas) !== data.horas)) {
      await denyWhen(exists('SELECT 1 FROM public.sesion_horario WHERE asignacion_id=$1 LIMIT 1',[old.id],tx),'Retira las sesiones de la actividad antes de modificar sus horas o su responsable.');
    }
  }
  if (table === 'ambiente' && old && (String(data.carrera_id) !== String(old.carrera_id) || !data.activo || data.tipo !== old.tipo)) {
    await denyWhen(exists(`SELECT 1 FROM public.sesion_horario s JOIN public.periodo_academico p ON p.id=s.periodo_id
      WHERE s.ambiente_id=$1 AND p.estado='BORRADOR' LIMIT 1`,[old.id],tx),
      'El ambiente tiene sesiones en un período abierto. Reubícalas primero.');
  }
  if (table === 'documento' && old) {
    await denyWhen(exists(`SELECT 1 FROM public.documento_horario d JOIN public.periodo_academico p ON p.id=d.periodo_id
      WHERE d.documento_id=$1 AND p.estado='FINALIZADO' LIMIT 1`,[old.id],tx),'El documento está vinculado a un horario histórico.');
  }
  if (table === 'documento' && old && old.tipo === 'RESOLUCION' && data.tipo !== old.tipo) {
    await denyWhen(exists('SELECT 1 FROM public.fusion WHERE resolucion_id=$1 LIMIT 1',[old.id],tx),'El documento sustenta una fusión y debe conservar su tipo de resolución.');
  }
};

const saveCatalog = async (resource, body, id, tx, displayName) => {
  const { table, fields } = get(resource);
  const model = models[table];
  const old = id && await model.findByPk(idOf(id), { attributes: publicAttributes(table), transaction: tx });
  if (id && !old) notFound();
  if (table==='docente_periodo' && old?.tipo==='EXTERNO') notFound();
  const data = parse(table==='grupo_academico' ? { ...body,seccion:body?.seccion ?? '' } : body, fields);
  if (table==='docente_periodo' && old) {
    for (const key of ['carrera_referencia_id','referencia_sustento','horas_referencia','minimo_lectivo_excepcional','regla_minimo_pendiente','codigo_personal','condicion']) {
      if (!Object.hasOwn(body,key)) data[key]=old[key];
    }
  }
  if (table === 'docente') {
    const home=await localDepartmentId(tx);
    const external=resource==='docentes-externos';
    if (old && isExternal(old,home)!==external) notFound();
    if (external) {
      const department=await one('SELECT activo FROM public.departamento_academico WHERE id=$1',[data.departamento_id],tx);
      if (!department || data.departamento_id===home || (!department.activo && old?.departamento_id!==data.departamento_id)) {
        invalid('Selecciona un departamento académico de origen.');
      }
      if (old && !Object.hasOwn(body,'activo')) data.activo=old.activo;
    } else if (!old) {
      data.departamento_id=home;
    }
    data.nombre_completo = displayName || [data.nombres, data.apellidos].filter(Boolean).join(' ');
    if (!data.nombre_completo) invalid('Ingresa los nombres del docente.');
    if ([...data.nombre_completo].length > 200) invalid('Los nombres y apellidos juntos admiten hasta 200 caracteres.');
    if (data.identificacion && [...data.identificacion].length > 20) invalid('El DNI admite hasta 20 caracteres.');
    if (data.identificacion) await denyWhen(exists(`SELECT 1 FROM public.docente
      WHERE btrim(documento_identidad)=$1 AND id IS DISTINCT FROM $2::bigint`,[data.identificacion,old?.id ?? null],tx),
      'Ya existe una persona registrada con ese DNI.');
  }
  if (table==='docente_periodo' && data.codigo_personal && [...data.codigo_personal].length>80) {
    invalid('El código de personal admite hasta 80 caracteres.');
  }
  if (table === 'asignatura') {
    const components = [data.teoria,data.practica,data.laboratorio];
    data.horas = components.includes(null) ? null : data.teoria+data.practica+data.laboratorio || null;
    if (old?.horas!=null && data.horas===null) {
      await denyWhen(exists(`SELECT 1 FROM public.oferta_curso o JOIN public.asignacion_oferta ao ON ao.oferta_id=o.id
        JOIN public.asignacion_carga ac ON ac.id=ao.asignacion_id JOIN public.periodo_academico p ON p.id=ac.periodo_id
        WHERE o.asignatura_id=$1 AND ac.modalidad='REGULAR' AND p.estado='BORRADOR' LIMIT 1`,[old.id],tx),
        'Completa las horas de la malla. La asignatura tiene carga regular en un semestre abierto.');
    }
  }
  await validate(table, data, old, tx);
  const changedHours = table==='asignatura' && old && data.horas!==old.horas;
  const saved = old ? await old.update(data, { transaction: tx }) : await model.create(data, { transaction: tx });
  if (['docente_periodo','grupo_academico','oferta_curso'].includes(table)) await clearCompletion(data.periodo_id,tx);
  if (changedHours) {
    await rows(`UPDATE public.asignacion_carga ac SET horas_semanales=$2 FROM public.asignacion_oferta ao
      JOIN public.oferta_curso o ON o.id=ao.oferta_id JOIN public.periodo_academico p ON p.id=o.periodo_id
      WHERE o.asignatura_id=$1 AND ao.asignacion_id=ac.id AND ac.modalidad='REGULAR' AND p.estado='BORRADOR'`,[old.id,data.horas],tx);
    await rows(`UPDATE public.periodo_academico SET carga_completa=false WHERE estado='BORRADOR'
      AND id IN (SELECT periodo_id FROM public.oferta_curso WHERE asignatura_id=$1)`,[old.id],tx);
  }
  const result = saved.get({ plain: true });
  delete result.contenido_pdf;
  return present(table, result);
};

const saveExternalTeacher = async (body, id, tx) => {
  const period=await periodOf(body?.periodo_id,tx,true);
  const career=idOf(body?.carrera_id);
  if (!await one("SELECT id FROM public.carrera WHERE id=$1 AND codigo IN ('EIIB','CPG')",[career],tx)) {
    invalid('Selecciona Educación Inicial o Ciencia Política.');
  }
  const person=await saveCatalog('docentes-externos',body,id,tx);
  const profile=await one('SELECT id,tipo,carrera_referencia_id FROM public.docente_periodo WHERE docente_id=$1 AND periodo_id=$2',
    [person.id,period.id],tx);
  if (profile && profile.tipo!=='EXTERNO') conflict('El docente ya tiene una ficha de carga en este semestre.');
  const offer=body.oferta_id ? idOf(body.oferta_id) : null;
  const assignmentId=body.asignacion_id ? idOf(body.asignacion_id) : null;
  const changesCareer=profile && profile.carrera_referencia_id!==career;
  const classes=profile && (offer || assignmentId || changesCareer) ? await rows(`SELECT a.id,x.oferta_id,a.observaciones
    FROM public.asignacion_carga a LEFT JOIN public.asignacion_oferta x ON x.asignacion_id=a.id
    WHERE a.docente_periodo_id=$1`,[profile.id],tx) : [];
  const currentClass=classes.find((item) => item.id===assignmentId);
  if (assignmentId && (!currentClass || !offer)) conflict('El vínculo cambió. Vuelve a abrir la ficha del docente.');
  if (offer && !assignmentId && classes.length) conflict('El docente ya tiene una clase vinculada. Vuelve a abrir su ficha.');
  if (changesCareer && classes.some((item) => item.id!==assignmentId)) {
    conflict('Retira primero las demás clases vinculadas en Horarios para cambiar la carrera de este semestre.');
  }
  const savedProfile=!profile || changesCareer ? await putRow('docente_periodo',{
    docente_id:person.id,periodo_id:period.id,tipo:'EXTERNO',carrera_referencia_id:career,jornada_semanal:null,
  },tx,profile?.id) : profile;
  if (offer && currentClass?.oferta_id!==offer) {
    await saveAssignmentForPeriod(period,{docente_periodo_id:savedProfile.id,modalidad:'REGULAR',oferta_ids:[offer],observaciones:currentClass?.observaciones},
      assignmentId,tx,{external:true});
  } else if (changesCareer && currentClass) {
    invalid('Selecciona una asignatura de la nueva carrera.');
  }
  return { ...person,carrera_id:career };
};

export const save = (resource, body, id) => atomic((tx) => resource==='docentes-externos'
  ? saveExternalTeacher(body,id,tx) : saveCatalog(resource,body,id,tx));

export const remove = (resource, id) => atomic(async (tx) => {
  const { table, fields } = get(resource);
  const row = await models[table].findByPk(idOf(id), { attributes: publicAttributes(table), transaction: tx });
  if (!row) notFound();
  if (table==='docente_periodo' && row.tipo==='EXTERNO') notFound();
  if (table==='docente' && (resource==='docentes-externos' || isExternal(row,await localDepartmentId(tx)))) notFound();
  if (row.periodo_id) await periodOf(row.periodo_id,tx,true);
  if (table === 'actividad_jp') {
    const jp = await one('SELECT periodo_id FROM public.docente_periodo WHERE id=$1',[row.docente_periodo_id],tx);
    await periodOf(jp.periodo_id,tx,true);
  }
  if (table==='asignatura') {
    invalid('Consulta y confirma el impacto antes de eliminar la asignatura.');
  }
  if (fields.activo) {
    await validate(table, { ...row.get({ plain: true }), activo: false }, row, tx);
    await row.update({ activo: false }, { transaction: tx });
  } else {
    await row.destroy({ transaction: tx });
  }
  if (['docente_periodo','grupo_academico','oferta_curso'].includes(table)) await clearCompletion(row.periodo_id,tx);
});

export const getConfig = () => models.configuracion.findByPk(1, { raw: true });
export const saveConfig = (body) => atomic(async (tx) => {
  const data = parse(body, { universidad: 'text', facultad: 'text', departamento: 'text' });
  if (Object.values(data).some((value) => value.length > 120)) invalid('Los nombres institucionales admiten hasta 120 caracteres.');
  const config = await models.configuracion.findByPk(1,{ transaction: tx });
  return config.update(data,{ transaction: tx });
});

export const listPeriods = async () => {
  const periods = await models.periodo_academico.findAll({ order: [['anio','DESC'],['semestre','DESC']], attributes: { exclude: ['encabezado'] }, raw: true });
  return periods.map((period) => present('periodo_academico', period));
};
export const savePeriod = (body, id) => atomic(async (tx) => {
  const previous = id ? await periodOf(id,tx,true) : null;
  let data;
  if (Object.hasOwn(body ?? {},'nombre')) {
    const match = typeof body.nombre==='string' && /^(\d{4})\s*-\s*(II|I|0|1|2)$/i.exec(body.nombre.trim());
    if (!match) invalid('Usa un semestre como 2027-I, 2027-II o 2027-0.');
    const semester = match[2].toUpperCase();
    data = { anio:valueOf('año',match[1],'periodYear'),semestre:semester==='0' ? 0 : ['I','1'].includes(semester) ? 1 : 2 };
  } else {
    data = parse(body,{ anio:'periodYear',semestre:['0','1','2',0,1,2],inicio:'?date',fin:'?date' });
    if (data.inicio && data.fin && data.fin<data.inicio) invalid('La fecha final debe ser posterior o igual al inicio.');
  }
  const duplicate = await one('SELECT id FROM public.periodo_academico WHERE anio=$1 AND numero=$2',[data.anio,data.semestre],tx);
  if (duplicate && duplicate.id!==previous?.id) conflict('Ese semestre ya existe.');
  if (!previous) return createPeriod(data,body,tx);
  const row = await models.periodo_academico.findByPk(id,{ transaction:tx });
  return present('periodo_academico', (await row.update(data,{ transaction:tx })).get({ plain:true }));
});
const createPeriod = async (data, body, tx) => {
  const origin = body.copiar_desde ? await periodOf(body.copiar_desde,tx) : null;
  const record = await models.periodo_academico.create(data,{ transaction:tx });
  if (origin) {
    await rows(`WITH ofertas_origen AS (
      SELECT o.asignatura_id,o.grupo_id FROM public.oferta_curso o
      JOIN public.asignatura a ON a.id=o.asignatura_id AND a.activa
      WHERE o.periodo_id=$2
    ), grupos_nuevos AS (
      INSERT INTO public.grupo_academico(periodo_id,plan_id,ciclo,seccion,turno)
      SELECT $1,g.plan_id,g.ciclo,g.seccion,g.turno FROM public.grupo_academico g
      WHERE EXISTS (SELECT 1 FROM ofertas_origen o WHERE o.grupo_id=g.id)
      RETURNING id,plan_id,ciclo,seccion
    )
      INSERT INTO public.oferta_curso(periodo_id,asignatura_id,grupo_id)
      SELECT $1,o.asignatura_id,dest.id FROM ofertas_origen o
      JOIN public.grupo_academico src ON src.id=o.grupo_id
      JOIN grupos_nuevos dest ON (dest.plan_id,dest.ciclo,dest.seccion)=(src.plan_id,src.ciclo,src.seccion)`,[record.id,origin.id],tx);
  }
  return present('periodo_academico',record.get({ plain:true }));
};

export const saveStaff = (periodId, body, personId) => atomic(async (tx) => {
  const period = await periodOf(periodId,tx,true);
  const original = personId ? await one('SELECT nombre_completo,nombres,apellidos,activo,documento_identidad FROM public.docente WHERE id=$1',[idOf(personId)],tx) : null;
  const splitName = Object.hasOwn(body ?? {},'nombres') || Object.hasOwn(body ?? {},'apellidos');
  const legacyName = splitName ? null : valueOf('nombre completo',body?.nombre_completo,'text');
  const sameName = original?.nombre_completo===legacyName;
  const names = splitName ? valueOf('nombres',body.nombres,'text') : sameName ? original.nombres : legacyName;
  const surnames = splitName ? body.apellidos : sameName ? original.apellidos : null;
  const person = await saveCatalog('docentes',{
    nombres:names, apellidos:surnames,
    identificacion:Object.hasOwn(body,'identificacion') ? body.identificacion : original?.documento_identidad,
    activo:body.activo ?? original?.activo ?? true,
  },personId,tx,legacyName);
  const previous = await models.docente_periodo.findOne({ where:{periodo_id:period.id,docente_id:person.id},transaction:tx,raw:true });
  const internal = Object.fromEntries(['cargo','responsabilidades','documento_id','referencia_sustento','horas_referencia','minimo_lectivo_excepcional']
    .filter((key) => previous && !Object.hasOwn(body,key)).map((key) => [key,previous[key]]));
  const profile = await saveCatalog('docentes-periodo',{
    ...internal,...body, periodo_id:period.id, docente_id:person.id,
    carrera_reporte_id:body.tipo==='NOMBRADO' ? null : idOf(body.carrera_reporte_id),
    horas_cumplimiento:body.tipo==='JP' ? (body.horas_cumplimiento==='' || body.horas_cumplimiento==null ? body.jornada : body.horas_cumplimiento) : null,
  },previous?.id,tx);
  return { persona:person, ficha:profile };
});

export const offerCourses = (periodId, body) => atomic(async (tx) => {
  const period = await periodOf(periodId,tx,true);
  const group = idOf(body?.grupo_id);
  const selected = body?.asignatura_ids;
  const target = await one('SELECT plan_id,ciclo FROM public.grupo_academico WHERE id=$1 AND periodo_id=$2',[group,period.id],tx);
  if (!target) invalid('Selecciona un grupo de este semestre.');
  let ids;
  if (body?.filtradas === true) {
    const q = typeof body.q === 'string' ? body.q.trim().slice(0,100) : '';
    ids = (await rows(`SELECT a.id FROM public.asignatura a
      JOIN public.plan_estudio p ON p.id=a.plan_id JOIN public.carrera c ON c.id=p.carrera_id
      WHERE a.plan_id=$1 AND a.ciclo=$2 AND a.activa AND ($3::text IS NULL OR c.codigo=$3)
      AND (strpos(lower(a.codigo),lower($4))>0 OR strpos(lower(a.nombre),lower($4))>0)
      ORDER BY a.id LIMIT 1001`,
      [target.plan_id,target.ciclo,body.carrera ? valueOf('escuela',body.carrera,['EIIB','CPG']) : null,q],tx)).map(({id}) => id);
  } else {
    if (!Array.isArray(selected)) invalid('Marca los cursos que quieres ofertar.');
    ids = [...new Set(selected.map(idOf))];
  }
  if (!ids.length || ids.length>1000) invalid('Selecciona entre 1 y 1000 cursos compatibles con el grupo.');
  const compatible = await rows(`SELECT id FROM public.asignatura WHERE id=ANY($1::bigint[])
    AND plan_id=$2 AND ciclo=$3 AND activa AND COALESCE(horas_computables,0)>0`,[ids,target.plan_id,target.ciclo],tx);
  if (compatible.length!==ids.length) invalid('Todos los cursos deben estar activos, tener horas computables y pertenecer al plan y ciclo del grupo.');
  const saved = await rows(`INSERT INTO public.oferta_curso(periodo_id,asignatura_id,grupo_id)
    SELECT $1,id,$2 FROM unnest($3::bigint[]) AS id ON CONFLICT DO NOTHING RETURNING id`,[period.id,group,ids],tx);
  if (saved.length) await clearCompletion(period.id,tx);
  return { agregadas:saved.length, existentes:ids.length-saved.length };
});

const courseOfferState = async (period, course, enabled, tx) => {
  const existing = await rows('SELECT id FROM public.oferta_curso WHERE periodo_id=$1 AND asignatura_id=$2',[period,course.id],tx);
  if (!enabled) {
    if (!existing.length) return;
    const ids=existing.map(({id}) => id);
    await denyWhen(exists('SELECT 1 FROM public.asignacion_oferta WHERE oferta_id=ANY($1::bigint[]) LIMIT 1',[ids],tx),
      'Retira primero las asignaciones del curso antes de quitarlo de la oferta.');
    await rows('DELETE FROM public.oferta_curso WHERE id=ANY($1::bigint[])',[ids],tx);
  } else {
    if (existing.length) return;
    if (!course.ciclo) invalid('Indica el ciclo para ofertar la asignatura.');
    const plan=await one(`SELECT p.activo,c.activa,c.codigo FROM public.plan_estudio p JOIN public.carrera c ON c.id=p.carrera_id
      WHERE p.id=$1`,[course.plan_id],tx);
    if (!plan?.activo || !plan.activa || !course.activo) invalid('Selecciona una asignatura, malla y escuela activas.');
    let groups=await rows('SELECT id FROM public.grupo_academico WHERE periodo_id=$1 AND plan_id=$2 AND ciclo=$3',
      [period,course.plan_id,course.ciclo],tx);
    if (!groups.length) groups=[await putRow('grupo_academico',{periodo_id:period,plan_id:course.plan_id,ciclo:course.ciclo,
      seccion:'UNICO',turno:turno(plan.codigo,course.ciclo)},tx)];
    await rows(`INSERT INTO public.oferta_curso(periodo_id,asignatura_id,grupo_id)
      SELECT $1,$2,id FROM unnest($3::bigint[]) AS id`,[period,course.id,groups.map(({id}) => id)],tx);
  }
  await clearCompletion(period,tx);
};

export const saveCourse = (body, id) => atomic(async (tx) => {
  const period=body?.periodo_id ? await periodOf(body.periodo_id,tx,true) : null;
  const old=id ? await models.asignatura.findByPk(idOf(id),{ raw:true,transaction:tx }) : null;
  if (id && !old) notFound();
  const school=idOf(body?.carrera_id);
  const planName=valueOf('malla / plan de estudios',body.plan,'text');
  if (planName.length>150) invalid('La malla admite hasta 150 caracteres.');
  const schoolRow=await models.carrera.findByPk(school,{ raw:true,transaction:tx });
  if (!schoolRow || (!schoolRow.activo && !old)) invalid('Selecciona una escuela profesional activa.');
  const plan=await one(`SELECT id FROM public.plan_estudio WHERE carrera_id=$1 AND
    (lower(codigo)=lower($2) OR lower(nombre)=lower($2)) ORDER BY (lower(codigo)=lower($2)) DESC,id LIMIT 1`,[school,planName],tx)
    ?? await putRow('plan_estudio',{carrera_id:school,codigo:planName.slice(0,40),nombre:planName},tx);
  const code=valueOf('código',body.codigo,'text').toUpperCase();
  if (code.length>40 || String(body.nombre ?? '').trim().length>240) invalid('El código admite 40 caracteres y el nombre 240.');
  const duplicate=await one('SELECT id FROM public.asignatura WHERE plan_id=$1 AND upper(codigo)=$2',[plan.id,code],tx);
  if (duplicate && duplicate.id!==old?.id) conflict('Ya existe ese código para la misma escuela y malla.');
  const course=await saveCatalog('asignaturas',{
    ...body,codigo:code,plan_id:plan.id,departamento_id:old?.departamento_id,requisito:old?.requisito,activo:old?.activo ?? true,
  },id,tx);
  if (period && typeof body.ofertada==='boolean') await courseOfferState(period.id,course,body.ofertada,tx);
  return course;
});

export const changeCourseOffers = (periodId, body) => atomic(async (tx) => {
  const period=await periodOf(periodId,tx,true);
  if (!Array.isArray(body?.asignatura_ids) || typeof body.ofertada!=='boolean') invalid('Selecciona las asignaturas de la oferta.');
  const ids=[...new Set(body.asignatura_ids.map(idOf))];
  if (!ids.length || ids.length>1000) invalid('Selecciona entre 1 y 1000 asignaturas.');
  const courses=await models.asignatura.findAll({where:{id:ids},raw:true,transaction:tx});
  if (courses.length!==ids.length) invalid('Hay asignaturas que ya no están disponibles.');
  let omitted=0;
  for (const course of courses) {
    if (body.ofertada && (!course.ciclo || !course.activo) && ids.length>1) { omitted+=1; continue; }
    await courseOfferState(period.id,course,body.ofertada,tx);
  }
  return { actualizadas:ids.length-omitted,omitidas:omitted };
});

export const activatePeriod = (id) => atomic(async (tx) => {
  await periodOf(id,tx,true);
  await rows('UPDATE public.periodo_academico SET activo=false WHERE activo',[],tx);
  await rows('UPDATE public.periodo_academico SET activo=true WHERE id=$1',[id],tx);
  return periodOf(id,tx);
});
