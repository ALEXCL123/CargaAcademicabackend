-- Datos de la aplicación que no están en la instalación base.
ALTER TABLE public.periodo_academico
  ADD COLUMN activo boolean NOT NULL DEFAULT false,
  ADD COLUMN carga_completa boolean NOT NULL DEFAULT false,
  ADD COLUMN encabezado jsonb,
  ADD CONSTRAINT periodo_activo_borrador CHECK (NOT activo OR estado = 'BORRADOR');
CREATE UNIQUE INDEX periodo_activo_unico ON public.periodo_academico(activo) WHERE activo;

ALTER TABLE public.departamento_academico ADD COLUMN activo boolean NOT NULL DEFAULT true;
ALTER TABLE public.plan_estudio ADD COLUMN activo boolean NOT NULL DEFAULT true;
ALTER TABLE public.docente ADD COLUMN nombres text, ADD COLUMN apellidos text;
ALTER TABLE public.docente_periodo
  ADD COLUMN cargo text,
  ADD COLUMN responsabilidades text,
  ADD COLUMN horas_cumplimiento numeric(5,2) CHECK (horas_cumplimiento >= 0);

CREATE TABLE public.usuario_sesion (
  token_hash text PRIMARY KEY,
  usuario_id smallint NOT NULL REFERENCES public.usuario(id),
  vence timestamptz NOT NULL
);
CREATE INDEX usuario_sesion_vence ON public.usuario_sesion(vence);

CREATE TABLE public.asignacion_jp (
  asignacion_id bigint NOT NULL,
  docente_periodo_id bigint NOT NULL,
  periodo_id bigint NOT NULL,
  PRIMARY KEY (asignacion_id, docente_periodo_id),
  FOREIGN KEY (asignacion_id, periodo_id) REFERENCES public.asignacion_carga(id, periodo_id) ON DELETE CASCADE,
  FOREIGN KEY (docente_periodo_id, periodo_id) REFERENCES public.docente_periodo(id, periodo_id)
);

-- Las tutorías nuevas pueden guardarse sin ambiente; las anteriores se conservan.
ALTER TABLE public.sesion_horario
  ALTER COLUMN ambiente_id DROP NOT NULL,
  ADD COLUMN excepcion text,
  ADD CONSTRAINT sesion_clase_con_ambiente CHECK (tipo <> 'CLASE' OR ambiente_id IS NOT NULL);

CREATE TABLE public.ocupacion_docente (
  sesion_id bigint NOT NULL,
  periodo_id bigint NOT NULL,
  docente_id bigint NOT NULL REFERENCES public.docente(id),
  dia smallint NOT NULL,
  rango_minutos int4range NOT NULL,
  PRIMARY KEY (sesion_id, docente_id),
  FOREIGN KEY (sesion_id, periodo_id, dia, rango_minutos)
    REFERENCES public.sesion_horario(id, periodo_id, dia, rango_minutos) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  EXCLUDE USING gist (periodo_id WITH =, docente_id WITH =, dia WITH =, rango_minutos WITH &&)
);

INSERT INTO public.configuracion(id,universidad,facultad,departamento)
VALUES (1, 'Universidad Nacional Micaela Bastidas de Apurímac', 'Educación y Ciencias Sociales', 'Educación y Ciencia Política')
ON CONFLICT DO NOTHING;

INSERT INTO public.departamento_academico(nombre) VALUES ('Educación y Ciencia Política')
ON CONFLICT DO NOTHING;

INSERT INTO public.carrera(codigo,nombre) VALUES
  ('EIIB','Educación Inicial Intercultural Bilingüe'),('CPG','Ciencia Política y Gobernabilidad')
ON CONFLICT DO NOTHING;

