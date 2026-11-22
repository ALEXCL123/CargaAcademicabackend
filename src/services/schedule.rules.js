export const overlap = (a,b) => a.dia === b.dia && a.inicio < b.fin && b.inicio < a.fin;
const shares = (left,right) => left.some((value) => right.includes(value));
export const fits = (group,start,end,opposite = false) => (group.turno === 'MANANA') !== opposite
  ? start >= 7 && end <= 13 : start >= 14 && end <= 20;
export const compatibleRoom = (room, groups) => room.activo && (!room.carrera_id || groups.every((g) => g.carrera_id === room.carrera_id));
const byId = (items, id) => items.find((item) => item.id === String(id));
const optional = (id) => id == null || id === '' ? null : String(id);
const duration = (s) => s.fin - s.inicio;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export const normalizeSession = (body, context) => {
  assert(body && typeof body === 'object', 'Revisa los datos de la sesión.');
  const { tipo } = body;
  const dia = Number(body.dia), inicio = Number(body.inicio), fin = Number(body.fin);
  assert([dia,inicio,fin].every(Number.isInteger) && dia >= 1 && dia <= 5 && inicio >= 7 && fin <= 20 && fin > inicio && (fin <= 13 || inicio >= 14),
    'Programa de lunes a viernes, entre 07:00 y 20:00, en horas completas y fuera del almuerzo.');
  const s = { tipo, dia, inicio, fin, asignacion_id: null, actividad_jp_id: null, ambiente_id: null, docente_id: null, excepcion: null, grupos: [], docentes: [] };
  if (body.excepcion != null && body.excepcion !== '') {
    assert(typeof body.excepcion === 'string' && body.excepcion.trim().length > 0 && body.excepcion.length <= 500, 'Escribe el motivo de la excepción.');
    s.excepcion = body.excepcion.trim();
  }
  if (tipo === 'CLASE') {
    const assignment = byId(context.asignaciones, body.asignacion_id);
    assert(assignment && assignment.ofertas.length, 'Selecciona una asignación del período.');
    assert(assignment.modalidad!=='FUSION' || (assignment.fusion_habilitada && assignment.fusion_pdf), 'La fusión requiere autorización y PDF.');
    const teacher = byId(context.docentes, assignment.docente_periodo_id);
    assert(teacher?.activo && teacher.situacion === 'DOCENCIA' && teacher.tipo !== 'JP', 'El docente de la asignación no está habilitado.');
    const groupIds = [...new Set(assignment.ofertas.map((o) => o.grupo_id))];
    const groups = groupIds.map((id) => byId(context.grupos,id));
    assert(groups.every((g) => g && fits(g,inicio,fin)), 'La clase está fuera de la franja de uno de sus grupos.');
    const room = byId(context.ambientes,body.ambiente_id);
    assert(room && compatibleRoom(room,groups), 'Selecciona un ambiente activo compatible con todos los grupos.');
    const jp = assignment.jp_ids.map((id) => byId(context.docentes,id));
    assert(jp.every((d) => d?.activo && d.tipo === 'JP' && d.situacion === 'DOCENCIA'), 'Uno de los JP participantes no está habilitado.');
    Object.assign(s,{ asignacion_id: assignment.id, docente_id: teacher.docente_id, ambiente_id: room.id,
      grupos: groupIds, docentes: [teacher.docente_id,...jp.map((d) => d.docente_id)] });
  } else if (tipo === 'TUTORIA') {
    assert(![body.docente_id, body.ambiente_id, body.asignacion_id, body.actividad_jp_id].some(optional), 'La tutoría solo reserva al grupo.');
    const group = byId(context.grupos,body.grupo_id);
    assert(group, 'Selecciona un grupo del período.');
    const eiib = group.carrera === 'EIIB';
    assert(fits(group,inicio,fin,eiib), 'La tutoría está fuera de la franja correspondiente.');
    assert(!eiib || (dia === 4 && duration(s) === 4), 'La tutoría EIIB debe durar cuatro horas el jueves.');
    s.grupos = [group.id];
  } else if (tipo === 'ACTIVIDAD_JP') {
    const teacher = context.docentes.find((d) => d.activo && d.tipo === 'JP' && d.situacion === 'DOCENCIA' &&
      d.actividades.some((a) => a.id === String(body.actividad_jp_id)));
    assert(teacher, 'Selecciona una actividad de un JP activo del período.');
    const group = byId(context.grupos,body.grupo_id);
    assert(group && fits(group,inicio,fin), 'Selecciona un grupo del período y una hora en su franja.');
    const room = optional(body.ambiente_id) && byId(context.ambientes,body.ambiente_id);
    assert(!optional(body.ambiente_id) || (room && compatibleRoom(room,[group])), 'El ambiente de la actividad no es compatible.');
    Object.assign(s,{ actividad_jp_id: String(body.actividad_jp_id), docente_id: teacher.docente_id, ambiente_id: room?.id ?? null,
      grupos: [group.id], docentes: [teacher.docente_id] });
  } else assert(false, 'Selecciona un tipo de sesión válido.');
  return s;
};

export const checkPlacement = (s, saved, context) => {
  for (const other of saved) {
    if (!overlap(s,other)) continue;
    if (shares(s.docentes,other.docentes)) return 'El docente o JP ya tiene una sesión en ese intervalo.';
    if (s.ambiente_id && s.ambiente_id === other.ambiente_id) return 'El ambiente está ocupado en ese intervalo.';
    if (shares(s.grupos,other.grupos)) return 'Un grupo ya tiene una sesión o tutoría en ese intervalo.';
  }
  if (s.tipo === 'TUTORIA' && saved.some((other) => other.tipo === 'TUTORIA' && shares(s.grupos,other.grupos))) return 'El grupo ya tiene una tutoría semanal.';
  if (s.tipo === 'ACTIVIDAD_JP') {
    const activity = context.docentes.flatMap((d) => d.actividades).find((a) => a.id === s.actividad_jp_id);
    if (saved.filter((o) => o.actividad_jp_id === activity.id).reduce((sum,o) => sum+duration(o),duration(s)) > Number(activity.horas)) return 'La actividad supera sus horas registradas.';
  }
  if (s.tipo !== 'CLASE') return null;
  const same = saved.filter((other) => other.asignacion_id === s.asignacion_id);
  const required = byId(context.asignaciones,s.asignacion_id).horas;
  if (same.reduce((sum, other) => sum + duration(other),duration(s)) > required) return 'La asignación superaría sus horas requeridas.';
  const withNew = [...same,s];
  const dayBlocks = withNew.filter((o) => o.dia === s.dia).sort((a,b) => a.inicio-b.inicio);
  let start, end, exception;
  for (const block of dayBlocks) {
    if (block.inicio !== end) { start = block.inicio; exception = false; }
    end = block.fin;
    exception ||= Boolean(block.excepcion);
    if (end-start > 2 && !exception && !dayBlocks.some((o) => o.inicio === end && o.excepcion)) {
      return 'Un bloque de más de dos horas consecutivas requiere un motivo de excepción.';
    }
  }
  const days = new Set(withNew.map((o) => o.dia));
  for (let day=1; day<=3; day+=1) {
    const sequence = [day,day+1,day+2];
    if (sequence.every((d) => days.has(d)) && !withNew.some((o) => sequence.includes(o.dia) && o.excepcion)) {
      return 'Tres días consecutivos requieren un motivo de excepción.';
    }
  }
  return null;
};

