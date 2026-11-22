ALTER TABLE public.periodo_academico
  DROP CONSTRAINT periodo_academico_numero_check,
  ADD CONSTRAINT periodo_academico_numero_check CHECK (numero IN (0, 1, 2));

ALTER TABLE public.asignatura ALTER COLUMN ciclo DROP NOT NULL;
