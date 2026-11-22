ALTER TABLE public.docente_periodo
  ADD COLUMN carrera_referencia_id bigint REFERENCES public.carrera(id),
  ADD COLUMN referencia_sustento text,
  ADD COLUMN horas_referencia numeric(6,2) CHECK (horas_referencia >= 0);

CREATE TABLE public.revision_requisito (
  periodo_id bigint NOT NULL REFERENCES public.periodo_academico(id),
  requisito text NOT NULL CHECK (requisito ~ '^RF-(0[1-9]|1[0-9])$'),
  estado text NOT NULL CHECK (estado IN ('PENDIENTE','CONFORME','POR_CORREGIR')),
  PRIMARY KEY (periodo_id,requisito)
);

CREATE TABLE public.revision_nota (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  periodo_id bigint NOT NULL REFERENCES public.periodo_academico(id),
  pantalla text NOT NULL CHECK (pantalla IN ('carga','horario','docentes','asignaturas','fusiones','revision','reportes','notas')),
  requisito text CHECK (requisito ~ '^RF-(0[1-9]|1[0-9])$'),
  texto text NOT NULL CHECK (char_length(btrim(texto)) BETWEEN 1 AND 2000),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revision_nota_periodo ON public.revision_nota(periodo_id,id);

