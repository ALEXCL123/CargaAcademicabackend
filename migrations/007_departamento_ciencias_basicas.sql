INSERT INTO public.departamento_academico (nombre)
VALUES ('Ciencias Básicas')
ON CONFLICT (nombre) DO NOTHING;
