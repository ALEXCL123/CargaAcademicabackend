-- Un cero explícito representa una actividad sin horas; NULL indica que el dato está pendiente.
UPDATE public.asignatura
SET horas_laboratorio=0
WHERE horas_laboratorio IS NULL AND horas_teoria IS NOT NULL AND horas_practica IS NOT NULL
  AND horas_computables=horas_teoria+horas_practica;

-- La malla de Matemática andina del caso 2026-II confirma que no corresponde laboratorio.
UPDATE public.asignatura s
SET horas_laboratorio=0
WHERE s.codigo='EI703' AND s.nombre='Matemática andina' AND s.ciclo=3
  AND s.horas_teoria=3 AND s.horas_practica=2 AND s.horas_laboratorio IS NULL
  AND EXISTS (
    SELECT 1 FROM public.oferta_curso o JOIN public.periodo_academico p ON p.id=o.periodo_id
    JOIN public.plan_estudio m ON m.id=s.plan_id JOIN public.carrera c ON c.id=m.carrera_id
    WHERE o.asignatura_id=s.id AND p.anio=2026 AND p.numero=2 AND c.codigo='EIIB'
  );

UPDATE public.asignatura
SET horas_computables=NULLIF(horas_teoria+horas_practica+horas_laboratorio,0)
WHERE horas_computables IS DISTINCT FROM NULLIF(horas_teoria+horas_practica+horas_laboratorio,0);

ALTER TABLE public.asignatura ADD CONSTRAINT asignatura_horas_segun_malla
  CHECK (horas_computables IS NOT DISTINCT FROM NULLIF(horas_teoria+horas_practica+horas_laboratorio,0));

WITH malla AS (
  SELECT ac.id, ac.periodo_id, min(s.horas_computables) AS horas
  FROM public.asignacion_carga ac
  JOIN public.periodo_academico p ON p.id=ac.periodo_id AND p.estado='BORRADOR'
  JOIN public.asignacion_oferta ao ON ao.asignacion_id=ac.id
  JOIN public.oferta_curso o ON o.id=ao.oferta_id
  JOIN public.asignatura s ON s.id=o.asignatura_id
  WHERE ac.modalidad='REGULAR'
  GROUP BY ac.id,ac.periodo_id
  HAVING count(*)=1
), corregidas AS (
  UPDATE public.asignacion_carga ac SET horas_semanales=m.horas
  FROM malla m
  WHERE ac.id=m.id AND m.horas IS NOT NULL AND ac.horas_semanales<>m.horas
  RETURNING ac.periodo_id
)
UPDATE public.periodo_academico
SET carga_completa=false
WHERE id IN (SELECT periodo_id FROM corregidas UNION SELECT periodo_id FROM malla WHERE horas IS NULL);

