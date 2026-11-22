import { HttpError } from '../utils/HttpError.js';

export const notFound = (req, res, next) => {
  next(new HttpError(404, 'NOT_FOUND', 'La ruta solicitada no existe.'));
};

export const errorHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);

  const pg = error.original?.code;
  if (pg === '23505') error = new HttpError(409, 'DUPLICATE', 'Ya existe un registro con esos datos.');
  if (pg === '23503') error = new HttpError(409, 'REFERENCE_CONFLICT', 'El registro está vinculado a otros datos o la referencia seleccionada no existe.');
  if (pg === '23P01') error = new HttpError(409, 'SCHEDULE_OVERLAP', 'El grupo, docente o ambiente ya está ocupado.');
  if (['23514','22003','22P02'].includes(pg)) error = new HttpError(422, 'INVALID_DATA', 'Revisa los datos y las referencias seleccionadas.');
  if (pg === '42P01' || pg === '3F000') error = new HttpError(503, 'SCHEMA_REQUIRED', 'Ejecuta las migraciones del backend para preparar la base.');
  const isPublic = error instanceof HttpError;
  const isInvalidJson = error.type === 'entity.parse.failed';
  const isTooLarge = error.type === 'entity.too.large';
  const status = isPublic ? error.status : isInvalidJson ? 400 : isTooLarge ? 413 : 500;
  const code = isPublic ? error.code : isInvalidJson ? 'INVALID_JSON' : isTooLarge ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR';
  const message = isPublic
    ? error.message
    : isInvalidJson
      ? 'El cuerpo de la solicitud no contiene un JSON válido.'
      : isTooLarge
        ? 'La solicitud supera el tamaño permitido.'
        : 'Ocurrió un error interno en el servidor.';

  // Nunca registrar el objeto de error: puede contener credenciales del driver.
  if (status >= 500) console.error(`[API] ${code}`);

  return res.status(status).json({
    ok: false,
    code,
    message,
    timestamp: new Date().toISOString(),
  });
};
