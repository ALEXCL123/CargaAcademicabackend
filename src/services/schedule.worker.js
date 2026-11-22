import { parentPort, workerData } from 'node:worker_threads';
import { checkPlacement, compatibleRoom, fits, normalizeSession } from './schedule.rules.js';

const { ctx, scoped, limit, exception } = workerData;
const deadline = performance.now()+limit;
const plan = [];
let best = [];
let bestHours = 0;
let exhausted = false;
const saved = [...scoped.fixed];
const causes = [];
const candidates = scoped.assignments.map((a) => {
  const groups = [...new Set(a.ofertas.map((o) => o.grupo_id))].map((id) => ctx.grupos.find((g) => g.id === id));
  const teacher=ctx.docentes.find((d) => d.id===a.docente_periodo_id);
  const active=(d) => d?.activo && d.situacion==='DOCENCIA';
  const invalidData=!groups.length || groups.some((g) => !g) || !Number.isInteger(a.horas) || a.horas<=0;
  const unauthorized=a.modalidad==='FUSION' && (!a.fusion_habilitada || !a.fusion_pdf);
  const invalidStaff=!active(teacher) || teacher.tipo==='JP' ||
    a.jp_ids.some((id) => !active(ctx.docentes.find((d) => d.id===id && d.tipo==='JP')));
  if (invalidData || unauthorized || invalidStaff) {
    causes.push({ id:a.id,motivo:invalidData ? 'Faltan grupos u horas computables.' :
      unauthorized ? 'La fusión requiere una resolución con PDF y autorización.' : 'Hay participantes sin habilitación en el semestre.' });
    return { a,possible:[] };
  }
  const rooms = ctx.ambientes.filter((room) => compatibleRoom(room,groups));
  if (!rooms.length) causes.push({ id: a.id, motivo: 'No hay un ambiente activo compatible con todos sus grupos.' });
  const possible = [];
  for (let dia=1;dia<=5;dia+=1) {
    for (let inicio=7;inicio<20;inicio+=1) {
      for (let length=1;length<=(exception ? 6 : 2);length+=1) {
        const fin = inicio+length;
        if (!groups.every((g) => fits(g,inicio,fin))) continue;
        for (const room of rooms) {
          const s = normalizeSession({ tipo:'CLASE',asignacion_id:a.id,ambiente_id:room.id,dia,inicio,fin,excepcion:exception },ctx);
          if (!checkPlacement(s,scoped.fixed,ctx)) possible.push(s);
        }
      }
    }
  }
  if (rooms.length && !possible.length) causes.push({ id:a.id,motivo:'Los recursos fijos y la franja no dejan intervalos compatibles.' });
  return { a, possible };
}).sort((left,right) => left.possible.length/Math.max(1,left.a.horas)-right.possible.length/Math.max(1,right.a.horas) || right.a.horas-left.a.horas);

const days = [1,3,5,2,4];
const score = (s, assigned, remaining) => {
  const usedDays = assigned.map((other) => other.dia);
  const separation = usedDays.length ? Math.min(...usedDays.map((day) => Math.abs(day-s.dia))) : 0;
  return Math.min(remaining,s.fin-s.inicio)*50 + separation*7 - days.indexOf(s.dia) - s.inicio/100;
};
const targetHours = candidates.reduce((sum,{a}) => sum+a.horas,0);
const search = (index, remaining, scheduledHours, assigned) => {
  if (scheduledHours > bestHours) { bestHours = scheduledHours; best = [...plan]; }
  if (performance.now() >= deadline) { exhausted = true; return false; }
  if (index === candidates.length) return scheduledHours === targetHours;
  if (!remaining) return search(index+1,candidates[index+1]?.a.horas ?? 0,scheduledHours,[]);
  const current = candidates[index];
  const viable = current.possible.filter((s) => s.fin-s.inicio <= remaining &&
    !checkPlacement(s,saved,ctx));
  viable.sort((a,b) => score(b,assigned,remaining)-score(a,assigned,remaining));
  for (const s of viable) {
    saved.push(s);
    plan.push(s);
    if (search(index,remaining-s.fin+s.inicio,scheduledHours+s.fin-s.inicio,[...assigned,s])) return true;
    plan.pop();
    saved.pop();
    if (exhausted) return false;
  }
  return search(index+1,candidates[index+1]?.a.horas ?? 0,scheduledHours,[]);
};

search(0,candidates[0]?.a.horas ?? 0,0,[]);
const result = [...best];
const occupied = [...scoped.fixed,...result];
const pendingTutoring = [];
for (const group of scoped.groups) {
  const eiib = group.carrera === 'EIIB';
  let chosen = null;
  for (const dia of eiib ? [4] : days) {
    const starts = eiib ? (group.turno==='MANANA' ? [14,15,16] : [9,8,7]) : Array.from({length:13},(_,i) => i+7);
    for (const inicio of starts) {
      const fin = inicio+(eiib ? 4 : 1);
      if (!fits(group,inicio,fin,eiib)) continue;
      const s = normalizeSession({ tipo:'TUTORIA',grupo_id:group.id,dia,inicio,fin },ctx);
      if (!checkPlacement(s,occupied,ctx)) { chosen = s; break; }
    }
    if (chosen) break;
  }
  if (chosen) { result.push(chosen); occupied.push(chosen); }
  else pendingTutoring.push(group.id);
}

const pending = scoped.assignments.map((a) => {
  const programadas = result.filter((s) => s.asignacion_id === a.id).reduce((n,s) => n+s.fin-s.inicio,0);
  return { id:a.id, programadas, faltan:a.horas-programadas };
}).filter((a) => a.faltan > 0);
for (const a of scoped.cross) {
  const programadas = scoped.fixed.filter((s) => s.asignacion_id === a.id).reduce((n,s) => n+s.fin-s.inicio,0);
  if (programadas < a.horas) {
    pending.push({ id:a.id, programadas, faltan:a.horas-programadas });
    causes.push({ id:a.id,motivo:'La fusión abarca ambas carreras. Genérala con el alcance Todas.' });
  }
}
for (const item of pending.filter((a) => !causes.some((c) => c.id===a.id))) {
  causes.push({ id:item.id,motivo:exhausted ? 'La búsqueda alcanzó su límite de tiempo.' : 'No hubo suficientes intervalos sin cruces de grupo, docente o aula.' });
}
const scopeIds = new Set(scoped.groups.map((g) => g.id));
const unassigned = ctx.ofertas.filter((o) => scopeIds.has(o.grupo_id) && !o.asignacion_id).length;
const status = exhausted ? 'TIEMPO_AGOTADO' : pending.length || causes.length || pendingTutoring.length || unassigned ? 'PARCIAL' : 'COMPLETA';
const avance = [...scoped.assignments,...scoped.cross].map((a) => {
  const programadas=[...scoped.fixed,...result].filter((s) => s.asignacion_id===a.id).reduce((sum,s) => sum+s.fin-s.inicio,0);
  return { id:a.id,requeridas:a.horas,programadas,faltan:Math.max(0,a.horas-programadas) };
});
const sesiones = result.map(({ grupos, ...s }) => ({ ...s, grupos, grupo_id: s.tipo === 'TUTORIA' ? grupos[0] : undefined }));
parentPort.postMessage({ estado: status, sesiones, avance, pendientes: pending, causas: causes,
  tutorias_pendientes: pendingTutoring, ofertas_sin_docente: unassigned, conflictos: [], excepcional: Boolean(exception) });

