import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import db from '../config/db.js';
import { idOf, invalid, notFound, one, periodOf, rows } from './database.js';
import { loadHeadings as headings, teacherReport } from './load-report-rows.js';
import { getLoad } from './load.service.js';
import { getSchedule } from './schedule.service.js';
import { validatePdf } from './documents.service.js';

const institution = (period, tx) => period.encabezado?.institucion
  ?? one('SELECT * FROM public.configuracion WHERE id=1',[],tx);
const readSnapshot = (operation) => db.transaction({ isolationLevel:'REPEATABLE READ', readOnly:true },operation);

const sheets = [
  ['Docentes ordinarios', (d) => d.tipo === 'NOMBRADO'],
  ['Educación Inicial', (d) => d.tipo !== 'NOMBRADO' && d.carrera_reporte === 'EIIB'],
  ['Ciencia Política', (d) => d.tipo !== 'NOMBRADO' && d.carrera_reporte === 'CPG'],
];
// El cuadro original usa márgenes, anchos de combinación y alturas distintos por hoja.
const loadLayouts = {
  'Docentes ordinarios': { offset:0, first:1, last:15, merged:4, fonts:[20,20,20,20], heights:[32.25,29.25,25.5,38.25] },
  'Educación Inicial': { offset:2, first:2, last:16, merged:4, fonts:[14,14,14,14], heights:[26.25,21.75,24,27.75] },
  'Ciencia Política': { offset:1, first:1, last:16, merged:2, fonts:[16,16,14,14], heights:[27,21.75,24.75,24.75] },
};
const loadTitleLines = ({nombre}, {institucion,periodo}) => {
  const university=institucion.universidad.trim().toLocaleUpperCase('es');
  const faculty=institucion.facultad.trim().replace(/^facultad\s+de\s+/iu,'');
  const department=institucion.departamento.trim().replace(/^departamento(?:\s+académico)?\s+de\s+/iu,'');
  const institutionLine=`FACULTAD DE ${faculty} - DEPARTAMENTO DE ${department}`.toLocaleUpperCase('es');
  const term=`${periodo.anio}-${['0','I','II'][Number(periodo.semestre)]}`;
  if (nombre==='Docentes ordinarios') return [institutionLine,institutionLine,`CARGA ACADÉMICA SEMESTRE ACADÉMICO ${term}`,
    'DOCENTES ORDINARIOS DE LA FACULTAD DE EDUCACION CIENCIAS SOCIALES'];
  if (nombre==='Educación Inicial') return [university,institutionLine,
    'PROPUESTA DE LA CARGA ACADEMICA DE DOCENTES DE LA ESCUELA PROFESIONAL DE EDUCACION INICIAL INTERCULTURAL BILINGÜE PRIMERA Y SEGUNDA INFANCIA',
    `SEMESTRE ACADÉMICO ${term}`];
  return [university,institutionLine,'PROPUESTA DE LA CARGA ACADEMICA DE DOCENTES ESCUELA PROFESIONAL DE CIENCIA POLITICA Y GOBERNABILIDAD',
    `CARGA ACADÉMICA SEMESTRE ${term}`];
};
const writeLoadTitles = (tab,sheet,report,layout) => {
  loadTitleLines(sheet,report).forEach((title,index) => {
    const number=index+1;
    const merged=number<=layout.merged;
    const row=tab.getRow(number);
    row.height=layout.heights[index];
    if (merged) tab.mergeCells(number,layout.first,number,layout.last);
    else for (let col=layout.first; col<=layout.last; col+=1) {
      row.getCell(col).alignment={horizontal:'centerContinuous',vertical:'middle'};
    }
    const cell=row.getCell(layout.first);
    if (merged) cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
    cell.font={name:index<2 ? 'Arial' : 'Arial Narrow',size:layout.fonts[index],bold:true};
    cell.value=title;
  });
};
export const loadReport = (periodId) => readSnapshot(async (tx) => {
  const period = await periodOf(periodId,tx);
  const load = await getLoad(period.id,tx);
  const info = await institution(period,tx);
  const included = load.docentes.filter((d) => d.situacion==='SABATICO' || d.asignaciones.length || d.actividades.length || d.cursos_jp?.length);
  const missing = included.filter((d) => d.tipo !== 'NOMBRADO' && !d.carrera_reporte);
  return { encabezados:headings, institucion: info, periodo: load.periodo, sin_carrera: missing.map((d) => d.nombre_completo),
    hojas: sheets.map(([nombre,filter]) => ({ nombre, docentes: included.filter(filter).map(teacherReport) })) };
});

export const exportLoad = async (periodId) => {
  const report = await loadReport(periodId);
  if (report.sin_carrera.length) invalid('Selecciona la carrera de reporte para todos los contratados y JP antes de exportar.');
  const book = new ExcelJS.Workbook();
  book.creator = 'Sistema de Carga Académica';
  book.calcProperties.fullCalcOnLoad = true;
  for (const sheet of report.hojas) {
    const layout=loadLayouts[sheet.nombre];
    const { offset }=layout;
    const tab = book.addWorksheet(sheet.nombre, {
      views: [{ state:'frozen', ySplit:5 }],
      pageSetup: { orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:0, printTitlesRow:'1:5' },
    });
    const margin=Array(offset).fill(3);
    tab.columns = [...margin,6,15,8,29,15,15,38,7,5,5,5,12,9,28,40].map((width) => ({ width }));
    writeLoadTitles(tab,sheet,report,layout);
    const addRow=(values) => tab.addRow([...margin.map(() => null),...values]);
    const headingsRow = addRow(headings);
    headingsRow.eachCell((cell) => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF79D5E2'} };
      cell.font = { bold:true, color:{argb:'FF173B43'} };
      cell.alignment = { wrapText:true, vertical:'middle' };
    });
    headingsRow.height = 30;
    sheet.docentes.forEach((d,i) => {
      const start = tab.rowCount+1;
      const hoursColumn=tab.getColumn(offset+12).letter;
      const sources = d.filas.flatMap((r,j) => r.contabiliza ? [hoursColumn+(start+j)] : []);
      const total = sources.length && sources.length<=255 ? { formula:'SUM('+sources.join(',')+')',result:d.total } : d.total;
      d.filas.forEach((entry,j) => {
        const { codigo,grupo,nombre,creditos,teoria,practica,laboratorio,horas,escuela,observaciones } = entry;
        const sabbatical = d.situacion==='SABATICO';
        const row = addRow([j===0 ? i+1 : null,j===0 ? d.categoria : null,j===0 ? d.codigo_personal : null,j===0 ? d.nombre_completo : null,
          sabbatical ? nombre : codigo,grupo,sabbatical ? null : nombre,creditos,teoria,practica,laboratorio,horas,j===0 ? total : null,
          escuela,[j===0 && d.observaciones,observaciones].filter(Boolean).join(' · ')]);
        if (creditos!==null && creditos!==undefined) row.getCell(offset+8).numFmt = Number.isInteger(creditos) ? '0' : '0.0#';
        row.eachCell({includeEmpty:true},(cell,col) => {
          if (col<=offset) return;
          cell.alignment = { wrapText:true, vertical:'middle', ...(col===offset+6 ? {horizontal:'center'} : {}) };
          if (i % 2 === 0) cell.fill = { type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F7F6'} };
        });
        row.height = Math.min(390, Math.max(28,...Array.from(row.values.slice(1),(value,index) => {
          const width=Math.max(5,tab.getColumn(index+1).width-2);
          const lines=String(value?.result ?? value ?? '').split(/\r?\n/)
            .reduce((count,line) => count+Math.max(1,Math.ceil(line.length/width)),0);
          return 15*lines+9;
        })));
      });
      if (d.situacion==='SABATICO') tab.mergeCells(start,offset+5,start,offset+14);
      if (tab.rowCount > start) for (const col of [1,2,3,4,13]) tab.mergeCells(start,offset+col,tab.rowCount,offset+col);
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
};

export const scheduleReport = (periodId, careerCode) => readSnapshot(async (tx) => {
  if (!['EIIB','CPG'].includes(careerCode)) invalid('Selecciona una carrera.');
  const period = await periodOf(periodId,tx);
  const [schedule, info, currentCareer] = await Promise.all([
    getSchedule(period.id,tx), institution(period,tx),
    one('SELECT id,nombre FROM public.carrera WHERE codigo=$1',[careerCode],tx),
  ]);
  const groups = schedule.grupos.filter((g) => g.carrera === careerCode);
  const assignments = new Map(schedule.asignaciones.map((a) => [a.id,a]));
  const list = groups.map((group) => ({
    grupo: group,
    sesiones: schedule.sesiones.filter((s) => s.grupos.includes(group.id)).map((s) => ({
      ...s,
      titulo: s.tipo === 'TUTORIA' ? 'Tutoría' : s.tipo === 'ACTIVIDAD_JP' ? s.actividad :
        assignments.get(s.asignacion_id)?.ofertas.map((o) => `${o.codigo} ${o.nombre}`).join(' / '),
      participantes: s.docentes.map((id) => schedule.docentes.find((d) => d.docente_id === id)).filter(Boolean).map((d) => d.nombre_completo),
    })),
  }));
  const documents = await rows(`SELECT l.documento_id id,d.tipo,d.numero,d.nombre_archivo,l.orden
    FROM public.documento_horario l JOIN public.documento d ON d.id=l.documento_id
    WHERE l.periodo_id=$1 AND l.carrera_id=$2 AND l.incluir_en_pdf ORDER BY l.orden,l.id`,[period.id,currentCareer.id],tx);
  return { institucion:info, periodo:schedule.periodo, carrera:groups[0]?.carrera_nombre || currentCareer.nombre, grupos:list, documentos:documents };
});

const days = ['Lunes','Martes','Miércoles','Jueves','Viernes'];
const hour = (n) => { const minutes=Math.round(n*60); return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0'); };
const textSafe = (text, font) => [...String(text ?? '')].map((char) => {
  if (/\s/.test(char)) return ' ';
  try { font.encodeText(char); return char; } catch { return '?'; }
}).join('');
const wrap = (value,font,size,width) => {
  const lines = [];
  let line = '';
  for (const word of textSafe(value,font).split(/\s+/)) {
    if (!word) continue;
    if (line && font.widthOfTextAtSize(line+' '+word,size) > width) { lines.push(line); line=''; }
    if (font.widthOfTextAtSize(word,size) <= width) { line += (line ? ' ' : '') + word; continue; }
    for (const char of word) {
      if (line && font.widthOfTextAtSize(line+char,size) > width) { lines.push(line); line=''; }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
};
const addSchedulePages = async (pdf,report) => {
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const color = rgb(.08,.19,.23);
  const headings = [report.institucion.universidad,report.institucion.facultad,report.institucion.departamento,
    `Horario ${report.periodo.anio}-${report.periodo.semestre} · ${report.carrera}`];
  for (const entry of report.grupos.length ? report.grupos : [{ grupo:null, sesiones:[] }]) {
    let page, y;
    const print = (value, font, size, x, at) => page.drawText(textSafe(value,font), {x,y:at,size,font,color});
    const header = () => {
      page = pdf.addPage([842,595]);
      y=554;
      for (const line of headings.flatMap((line) => wrap(line,bold,12,770))) { print(line,bold,12,36,y); y-=18; }
      const group = entry.grupo;
      for (const line of wrap(group ? `Ciclo ${group.ciclo} · Sección ${group.seccion} · Plan ${group.plan}` : 'Sin grupos registrados',bold,11,770)) {
        print(line,bold,11,36,y); y-=16;
      }
      y-=12;
    };
    header();
    const left=36, width=770, timeWidth=70, column=(width-timeWidth)/5, height=28;
    const border=rgb(.72,.79,.81);
    const cell=(x,top,w,h,fill) => page.drawRectangle({x,y:top-h,width:w,height:h,color:fill,borderColor:border,borderWidth:.6});
    cell(left,y,width,20,rgb(.89,.95,.96));
    print('Hora',bold,9,left+5,y-13);
    days.forEach((day,i) => print(day,bold,9,left+timeWidth+i*column+5,y-13));
    const top=y-20;
    for (let h=7;h<20;h+=1) {
      const row=top-(h-7)*height;
      const fill=h===13 ? rgb(.94,.94,.94) : rgb(1,1,1);
      cell(left,row,timeWidth,height,fill);
      print(hour(h)+'–'+hour(h+1),regular,8,left+4,row-16);
      for (let i=0;i<5;i+=1) cell(left+timeWidth+i*column,row,column,height,fill);
      if (h===13) print('Almuerzo',regular,9,left+timeWidth+5,row-16);
    }
    for (const s of entry.sesiones) {
      const x=left+timeWidth+(s.dia-1)*column;
      const row=top-(s.inicio-7)*height;
      const h=(s.fin-s.inicio)*height;
      const tutor=s.tipo==='TUTORIA';
      cell(x,row,column,h,tutor ? rgb(.93,.89,.97) : rgb(.86,.95,.93));
      const details=[s.titulo,!tutor && s.participantes.join(' / '),!tutor && s.ambiente_codigo].filter(Boolean);
      const lines=details.flatMap((line) => wrap(line,regular,7,column-8));
      const visible=Math.floor((h-4)/7);
      if (visible===3) {
        details.forEach((detail,i) => {
          const parts=wrap(detail,regular,7,column-8);
          print(parts.length>1 ? parts[0].slice(0,-3)+'…' : parts[0] || '',regular,7,x+4,row-8-i*7);
        });
      } else lines.slice(0,visible).forEach((line,i) => print(i===visible-1 && lines.length>visible ? line.slice(0,-3)+'…' : line,regular,7,x+4,row-8-i*7));
    }
    if (!entry.sesiones.length) continue;
    print('Consulta el detalle de las sesiones en las páginas siguientes.',regular,8,left,top-13*height-15);
    header();
    for (const [index,day] of days.entries()) {
      if (y<78) header();
      print(day,bold,11,36,y); y-=17;
      const sessions = entry.sesiones.filter((s) => s.dia === index+1);
      if (!sessions.length) { print('Sin sesiones',regular,9,50,y); y-=22; continue; }
      for (const s of sessions) {
        const details = [s.titulo, s.tipo!=='TUTORIA' && s.participantes.join(' / '),
          s.tipo!=='TUTORIA' && s.ambiente_codigo && `${s.ambiente_codigo} · ${s.ambiente_nombre}`,
          s.excepcion && `Excepción: ${s.excepcion}`].filter(Boolean);
        const lines = details.flatMap((line) => wrap(line,regular,10,652));
        if (y<52 || (lines.length<=16 && y-lines.length*14<42)) { header(); print(day+' (continuación)',bold,11,36,y); y-=17; }
        print(hour(s.inicio)+' - '+hour(s.fin),bold,9,50,y);
        for (const line of lines) {
          if (y<42) { header(); print(day+' · '+hour(s.inicio)+' (continuación)',bold,11,36,y); y-=17; }
          print(line,regular,10,142,y); y-=14;
        }
        y-=7;
      }
    }
  }
};

export const exportSchedule = async (periodId,career,documentIds = [],position = 'ANTES') => {
  if (!Array.isArray(documentIds) || documentIds.length>20 || !['ANTES','DESPUES'].includes(position)) invalid('Revisa la selección y el orden de documentos.');
  const ids = documentIds.map(idOf);
  if (new Set(ids).size !== ids.length) invalid('Los documentos no se pueden repetir.');
  const report = await scheduleReport(periodId,career);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Horarios ${report.periodo.anio}-${report.periodo.semestre} ${career}`);
  const addDocuments = async () => {
    for (const id of ids) {
      if (!report.documentos.some((d) => d.id===id)) invalid('El documento seleccionado no está vinculado al horario.');
      const row = await one('SELECT contenido_pdf FROM public.documento WHERE id=$1',[id]);
      if (!row?.contenido_pdf) notFound('Uno de los documentos seleccionados no tiene PDF.');
      const attachment = await validatePdf(row.contenido_pdf);
      for (const page of await pdf.copyPages(attachment,attachment.getPageIndices())) pdf.addPage(page);
    }
  };
  if (position==='ANTES') await addDocuments();
  await addSchedulePages(pdf,report);
  if (position==='DESPUES') await addDocuments();
  return Buffer.from(await pdf.save());
};

