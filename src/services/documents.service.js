import { PDFDocument } from 'pdf-lib';
import { atomic, conflict, idOf, invalid, notFound, one } from './database.js';

export const validatePdf = async (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length > 10 * 1024 * 1024 || bytes.subarray(0,5).toString() !== '%PDF-') invalid('Selecciona un PDF válido de hasta 10 MB.');
  try {
    const pdf = await PDFDocument.load(bytes);
    if (!pdf.getPageCount()) invalid('El PDF no contiene páginas.');
    return pdf;
  } catch { return invalid('El PDF está dañado, protegido o no contiene páginas.'); }
};
export const uploadPdf = async (id, filename, bytes) => {
  id = idOf(id);
  await validatePdf(bytes);
  const name = typeof filename === 'string' ? filename.replace(/[^\p{L}\p{N} ._-]/gu,'_').slice(0,120) : 'documento.pdf';
  return atomic(async (tx) => {
    const doc = await one('SELECT tipo FROM public.documento WHERE id=$1',[id],tx);
    if (doc?.tipo==='RESOLUCION' && bytes.length>2*1024*1024) invalid('El PDF de una resolución admite hasta 2 MB.');
    const historical = await one(`SELECT 1 FROM public.documento_horario d
      JOIN public.periodo_academico p ON p.id=d.periodo_id WHERE d.documento_id=$1 AND p.estado='FINALIZADO' LIMIT 1`,[id],tx);
    if (historical) conflict('El documento está vinculado a un horario histórico.');
    const row = await one('UPDATE public.documento SET nombre_archivo=$2,contenido_pdf=$3 WHERE id=$1 RETURNING id,nombre_archivo',[id,name,bytes],tx);
    return row || notFound();
  });
};
export const readPdf = async (id) => {
  const row = await one('SELECT nombre_archivo,contenido_pdf FROM public.documento WHERE id=$1',[idOf(id)]);
  if (!row?.contenido_pdf) notFound('El documento todavía no tiene PDF.');
  return row.contenido_pdf;
};

