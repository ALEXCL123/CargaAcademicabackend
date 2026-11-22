ALTER TABLE public.docente_periodo
  DROP CONSTRAINT docente_periodo_tipo_check,
  ALTER COLUMN jornada_semanal DROP NOT NULL,
  ADD CONSTRAINT docente_periodo_tipo_check CHECK (tipo IN ('NOMBRADO','CONTRATADO','JP','EXTERNO')),
  ADD CONSTRAINT docente_periodo_jornada_por_tipo_check CHECK (
    (tipo = 'EXTERNO' AND carrera_referencia_id IS NOT NULL AND jornada_semanal IS NULL)
    OR (tipo <> 'EXTERNO' AND jornada_semanal IS NOT NULL)
  );
