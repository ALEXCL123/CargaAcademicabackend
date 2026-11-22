const cycles = ['','I','II','III','IV','V','VI','VII','VIII','IX','X'];
const numeric = (value) => value==null || value==='' || !Number.isFinite(Number(value)) ? null : Number(value);

export const loadHeadings = ['N.º','Cat.','COD.','Docente','Código asignatura','GRUPO','ASIGNATURA',
  'Cr','T','P','L','N.º HORAS','TOTAL','Escuela profesional','Observaciones'];

const courseRows = (assignment, participation = false) => {
  const { id, fusion_id, fusion_nombre, ofertas } = assignment;
  const fused = assignment.modalidad==='FUSION' && Boolean(fusion_id);
  const namedAnchor = /^fusi[oó]n\s+(\S+)$/i.exec(fusion_nombre ?? '')?.[1]?.toUpperCase();
  const anchor = fused && (ofertas.find((o) => o.codigo.toUpperCase()===namedAnchor) || ofertas[0]);
  const principal = anchor && ofertas.find((o) => o.id!==anchor.id);
  const reportOffers = anchor ? [principal || anchor] : ofertas;
  const fusionGroup = principal && [cycles[Number(anchor.ciclo)],'FUSION',anchor.codigo].filter(Boolean).join('\n');
  const hours = participation ? null : numeric(assignment.modalidad==='REGULAR' ? assignment.horas : fused
    ? assignment.horas_fusion ?? assignment.horas_semanales ?? assignment.horas
    : assignment.horas_semanales ?? assignment.horas ?? reportOffers[0]?.horas);
  const note = [assignment.observaciones,assignment.resolucion && 'Resolución '+assignment.resolucion,
    participation && 'Participación JP',assignment.modalidad==='DIRIGIDO' && 'Dirigido'].filter(Boolean).join(' · ');
  if (!reportOffers.length) return [{
    id, fusion_id, key:id+'-sin-oferta', nombre:'Asignación sin oferta', horas:hours, observaciones:note,
  }];
  return reportOffers.map((o,i) => ({
    id, fusion_id, key:id+'-'+(o.id ?? i), codigo:o.codigo,
    grupo:fusionGroup || (assignment.modalidad==='DIRIGIDO' ? 'DIRIGIDO' : cycles[Number(o.ciclo)] || null),
    nombre:o.nombre, creditos:numeric(o.creditos), teoria:numeric(o.teoria), practica:numeric(o.practica),
    laboratorio:numeric(o.laboratorio), horas:hours,
    escuela:o.carrera_nombre || o.carrera, observaciones:note,
  }));
};

export const teacherReport = (d) => {
  const note = [...new Set([d.observaciones,d.cargo,d.referencia_sustento,
    d.documento_numero && [d.documento_tipo,d.documento_numero].filter(Boolean).join(' ')].filter(Boolean))].join(' · ');
  const teacher = { id:d.id, nombre_completo:d.nombres && d.apellidos ? d.nombres+' '+d.apellidos : d.nombre_completo || d.nombres || d.apellidos,
    categoria:d.categoria, codigo_personal:d.codigo_personal, situacion:d.situacion, observaciones:note };
  if (d.situacion==='SABATICO') return { ...teacher, filas:[{key:'sabatico',nombre:'AÑO SABÁTICO'}], total:null };
  if (d.tipo==='JP') return { ...teacher, total:numeric(d.horas_cumplimiento ?? d.jornada), filas:[
    ...d.actividades.map((a) => ({ key:'actividad-'+a.id, nombre:a.descripcion, horas:numeric(a.horas),
      escuela:d.carrera_reporte, observaciones:a.observaciones })),
    ...(d.cursos_jp ?? []).flatMap((a) => courseRows(a,true)),
  ] };
  const seen = new Set();
  let total = 0;
  const filas = d.asignaciones.flatMap((a) => courseRows(a)).map((row) => {
    const key = JSON.stringify([row.id,row.fusion_id ?? null]);
    const contabiliza = !seen.has(key) && row.horas!==null;
    if (contabiliza) { seen.add(key); total+=row.horas; }
    return { ...row, contabiliza };
  });
  return { ...teacher, filas, total };
};
