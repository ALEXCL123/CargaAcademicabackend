import { DataTypes } from 'sequelize';
import db from '../config/db.js';

const t = { type: DataTypes.TEXT };
const i = { type: DataTypes.SMALLINT };
const b = { type: DataTypes.BOOLEAN };
const fk = { type: DataTypes.BIGINT };
const date = { type: DataTypes.DATEONLY };
const num = { type: DataTypes.DECIMAL(5, 2) };
const field = (definition, name) => ({ ...definition, field: name });
const model = (name, fields, { tableName = name, defaultScope } = {}) => db.define(name, {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  ...Object.fromEntries(Object.entries(fields).map(([key, definition]) => [key, { ...definition }])),
}, { tableName, defaultScope });
const active = field(b, 'activa');

export const models = {
  configuracion: model('configuracion', {
    id: { type: DataTypes.SMALLINT, primaryKey: true }, universidad: t, facultad: t, departamento: t,
  }),
  periodo_academico: model('periodo_academico', {
    anio: i, semestre: field(i, 'numero'), inicio: field(date, 'fecha_inicio'), fin: field(date, 'fecha_fin'),
    estado: t, activo: b, carga_completa: b, encabezado: { type: DataTypes.JSONB },
  }),
  departamento_academico: model('departamento_academico', { nombre: t, activo: b }),
  carrera: model('carrera', { codigo: t, nombre: t, activo: active }),
  plan_estudio: model('plan_estudio', {
    carrera_id: fk, codigo: t, nombre: t, anio: i, documento_id: field(fk, 'resolucion_id'), activo: b,
  }),
  asignatura: model('asignatura', {
    plan_id: fk, departamento_id: fk, codigo: t, nombre: t, ciclo: i, creditos: num,
    teoria: field(i, 'horas_teoria'), practica: field(i, 'horas_practica'), laboratorio: field(i, 'horas_laboratorio'),
    horas: field(i, 'horas_computables'), requisito: field(t, 'requisito_texto'), activo: active,
  }),
  docente: model('docente', {
    identificacion: field(t, 'documento_identidad'), nombre_completo: t, nombres: t, apellidos: t, departamento_id: fk, activo: b,
  }),
  docente_periodo: model('docente_periodo', {
    periodo_id: fk, docente_id: fk, carrera_reporte_id: fk, tipo: t, categoria: t, codigo_personal: t, condicion: t,
    jornada: field(i, 'jornada_semanal'), situacion: t, cargo: t, responsabilidades: t, observaciones: t,
    documento_id: field(fk, 'resolucion_situacion_id'), horas_cumplimiento: num,
    carrera_referencia_id: fk, minimo_lectivo_excepcional: num, regla_minimo_pendiente: b, referencia_sustento: t, horas_referencia: num,
  }),
  actividad_jp: model('actividad_jp', {
    docente_periodo_id: fk, docente_id: fk, periodo_id: fk, rol: t, modalidad: t,
    descripcion: field(t, 'descripcion_actividad'), horas: field(i, 'horas_semanales'), observaciones: t,
  }, { tableName: 'asignacion_carga', defaultScope: { where: { modalidad: 'ACTIVIDAD_JP' } } }),
  ambiente: model('ambiente', { codigo: t, nombre: t, ubicacion: t, tipo: t, carrera_id: field(fk, 'carrera_exclusiva_id'), activo: b }),
  grupo_academico: model('grupo_academico', { periodo_id: fk, plan_id: fk, ciclo: i, seccion: t, turno: t }),
  oferta_curso: model('oferta_curso', { periodo_id: fk, grupo_id: fk, asignatura_id: fk }),
  documento: model('documento', { tipo: t, numero: t, fecha: date, observaciones: t, nombre_archivo: t, contenido_pdf: { type: DataTypes.BLOB } }),
  documento_horario: model('documento_horario', { periodo_id: fk, carrera_id: fk, documento_id: fk, orden: i }),
};

