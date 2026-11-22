-- Estructura base de public para instalaciones vacías.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.ambiente (
    id bigint NOT NULL,
    codigo character varying(40) NOT NULL,
    nombre character varying(140) NOT NULL,
    ubicacion character varying(180),
    tipo character varying(15) DEFAULT 'AULA'::character varying NOT NULL,
    carrera_exclusiva_id bigint,
    activo boolean DEFAULT true NOT NULL,
    CONSTRAINT ambiente_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['AULA'::character varying, 'LABORATORIO'::character varying, 'SALA'::character varying])::text[])))
);

ALTER TABLE public.ambiente ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ambiente_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.asignacion_carga (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    docente_periodo_id bigint NOT NULL,
    docente_id bigint NOT NULL,
    rol character varying(7) NOT NULL,
    modalidad character varying(15) DEFAULT 'REGULAR'::character varying NOT NULL,
    fusion_id bigint,
    horas_semanales smallint,
    descripcion_actividad text,
    observaciones text,
    CONSTRAINT asignacion_carga_check CHECK ((((modalidad)::text = 'FUSION'::text) = (fusion_id IS NOT NULL))),
    CONSTRAINT asignacion_carga_check1 CHECK ((((rol)::text = 'JP'::text) OR (horas_semanales IS NOT NULL))),
    CONSTRAINT asignacion_carga_check2 CHECK ((((modalidad)::text <> 'ACTIVIDAD_JP'::text) OR (((rol)::text = 'JP'::text) AND (btrim(COALESCE(descripcion_actividad, ''::text)) <> ''::text)))),
    CONSTRAINT asignacion_carga_horas_semanales_check CHECK ((horas_semanales > 0)),
    CONSTRAINT asignacion_carga_modalidad_check CHECK (((modalidad)::text = ANY ((ARRAY['REGULAR'::character varying, 'DIRIGIDO'::character varying, 'FUSION'::character varying, 'ACTIVIDAD_JP'::character varying])::text[]))),
    CONSTRAINT asignacion_carga_rol_check CHECK (((rol)::text = ANY ((ARRAY['DOCENTE'::character varying, 'JP'::character varying])::text[])))
);

ALTER TABLE public.asignacion_carga ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.asignacion_carga_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.asignacion_oferta (
    asignacion_id bigint NOT NULL,
    oferta_id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    rol character varying(7) NOT NULL,
    CONSTRAINT asignacion_oferta_rol_check CHECK (((rol)::text = ANY ((ARRAY['DOCENTE'::character varying, 'JP'::character varying])::text[])))
);

CREATE TABLE public.asignatura (
    id bigint NOT NULL,
    plan_id bigint NOT NULL,
    departamento_id bigint,
    codigo character varying(40) NOT NULL,
    nombre character varying(240) NOT NULL,
    ciclo smallint NOT NULL,
    creditos numeric(5,2),
    horas_teoria smallint,
    horas_practica smallint,
    horas_laboratorio smallint,
    horas_computables smallint,
    requisito_texto character varying(200),
    activa boolean DEFAULT true NOT NULL,
    CONSTRAINT asignatura_ciclo_check CHECK (((ciclo >= 1) AND (ciclo <= 10))),
    CONSTRAINT asignatura_creditos_check CHECK ((creditos >= (0)::numeric)),
    CONSTRAINT asignatura_horas_computables_check CHECK ((horas_computables > 0)),
    CONSTRAINT asignatura_horas_laboratorio_check CHECK ((horas_laboratorio >= 0)),
    CONSTRAINT asignatura_horas_practica_check CHECK ((horas_practica >= 0)),
    CONSTRAINT asignatura_horas_teoria_check CHECK ((horas_teoria >= 0))
);

ALTER TABLE public.asignatura ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.asignatura_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.carrera (
    id bigint NOT NULL,
    codigo character varying(20) NOT NULL,
    nombre character varying(220) NOT NULL,
    activa boolean DEFAULT true NOT NULL
);

ALTER TABLE public.carrera ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.carrera_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.configuracion (
    id smallint DEFAULT 1 NOT NULL,
    universidad character varying(180) NOT NULL,
    facultad character varying(180) NOT NULL,
    departamento character varying(180) NOT NULL,
    CONSTRAINT configuracion_id_check CHECK ((id = 1))
);

CREATE TABLE public.departamento_academico (
    id bigint NOT NULL,
    nombre character varying(180) NOT NULL
);

ALTER TABLE public.departamento_academico ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.departamento_academico_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.docente (
    id bigint NOT NULL,
    nombre_completo character varying(200) NOT NULL,
    documento_identidad character varying(20),
    departamento_id bigint,
    activo boolean DEFAULT true NOT NULL,
    CONSTRAINT docente_nombre_completo_check CHECK ((btrim((nombre_completo)::text) <> ''::text))
);

ALTER TABLE public.docente ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.docente_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.docente_periodo (
    id bigint NOT NULL,
    docente_id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    tipo character varying(12) NOT NULL,
    categoria character varying(80),
    condicion character varying(80),
    jornada_semanal smallint NOT NULL,
    rol character varying(7) GENERATED ALWAYS AS (
CASE
    WHEN ((tipo)::text = 'JP'::text) THEN 'JP'::text
    ELSE 'DOCENTE'::text
END) STORED,
    situacion character varying(15) DEFAULT 'ACTIVO'::character varying NOT NULL,
    carrera_reporte_id bigint,
    minimo_lectivo_excepcional numeric(5,2),
    regla_minimo_pendiente boolean DEFAULT false NOT NULL,
    resolucion_situacion_id bigint,
    observaciones text,
    CONSTRAINT docente_periodo_check CHECK (((minimo_lectivo_excepcional IS NULL) OR (minimo_lectivo_excepcional <= (jornada_semanal)::numeric))),
    CONSTRAINT docente_periodo_jornada_semanal_check CHECK (((jornada_semanal >= 1) AND (jornada_semanal <= 80))),
    CONSTRAINT docente_periodo_minimo_lectivo_excepcional_check CHECK ((minimo_lectivo_excepcional >= (0)::numeric)),
    CONSTRAINT docente_periodo_situacion_check CHECK (((situacion)::text = ANY ((ARRAY['ACTIVO'::character varying, 'SABATICO'::character varying, 'SIN_DOCENCIA'::character varying])::text[]))),
    CONSTRAINT docente_periodo_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['NOMBRADO'::character varying, 'CONTRATADO'::character varying, 'JP'::character varying])::text[])))
);

ALTER TABLE public.docente_periodo ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.docente_periodo_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.documento (
    id bigint NOT NULL,
    tipo character varying(15) NOT NULL,
    numero character varying(160) NOT NULL,
    fecha date,
    nombre_archivo character varying(255),
    contenido_pdf bytea,
    observaciones text,
    creado_en timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT documento_check CHECK (((contenido_pdf IS NULL) OR (nombre_archivo IS NOT NULL))),
    CONSTRAINT documento_numero_check CHECK ((btrim((numero)::text) <> ''::text)),
    CONSTRAINT documento_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['RESOLUCION'::character varying, 'CARTA'::character varying, 'INFORME'::character varying, 'OTRO'::character varying])::text[])))
);

CREATE TABLE public.documento_horario (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    carrera_id bigint NOT NULL,
    documento_id bigint NOT NULL,
    orden smallint DEFAULT 1 NOT NULL,
    incluir_en_pdf boolean DEFAULT true NOT NULL,
    CONSTRAINT documento_horario_orden_check CHECK ((orden > 0))
);

ALTER TABLE public.documento_horario ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.documento_horario_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.documento ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.documento_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.fusion (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    resolucion_id bigint,
    nombre character varying(200) NOT NULL,
    horas_compartidas smallint,
    habilitada boolean DEFAULT false NOT NULL,
    observaciones text,
    CONSTRAINT fusion_check CHECK (((NOT habilitada) OR ((resolucion_id IS NOT NULL) AND (horas_compartidas IS NOT NULL)))),
    CONSTRAINT fusion_horas_compartidas_check CHECK ((horas_compartidas > 0))
);

CREATE TABLE public.fusion_asignatura (
    fusion_id bigint NOT NULL,
    asignatura_id bigint NOT NULL
);

ALTER TABLE public.fusion ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.fusion_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.grupo_academico (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    plan_id bigint NOT NULL,
    ciclo smallint NOT NULL,
    seccion character varying(30) DEFAULT 'UNICO'::character varying NOT NULL,
    turno character varying(8) NOT NULL,
    aula_referencia_id bigint,
    CONSTRAINT grupo_academico_ciclo_check CHECK (((ciclo >= 1) AND (ciclo <= 10))),
    CONSTRAINT grupo_academico_turno_check CHECK (((turno)::text = ANY ((ARRAY['MANANA'::character varying, 'TARDE'::character varying])::text[])))
);

ALTER TABLE public.grupo_academico ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.grupo_academico_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.ocupacion_grupo (
    sesion_id bigint NOT NULL,
    grupo_id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    dia smallint NOT NULL,
    rango_minutos int4range NOT NULL
);

CREATE TABLE public.oferta_curso (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    asignatura_id bigint NOT NULL,
    grupo_id bigint NOT NULL
);

ALTER TABLE public.oferta_curso ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.oferta_curso_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.periodo_academico (
    id bigint NOT NULL,
    anio smallint NOT NULL,
    numero smallint NOT NULL,
    nombre character varying(8) GENERATED ALWAYS AS ((((anio)::text || '-'::text) ||
CASE numero
    WHEN 1 THEN 'I'::text
    ELSE 'II'::text
END)) STORED,
    fecha_inicio date,
    fecha_fin date,
    estado character varying(12) DEFAULT 'BORRADOR'::character varying NOT NULL,
    CONSTRAINT periodo_academico_anio_check CHECK (((anio >= 2000) AND (anio <= 2200))),
    CONSTRAINT periodo_academico_check CHECK (((fecha_fin IS NULL) OR (fecha_inicio IS NULL) OR (fecha_fin >= fecha_inicio))),
    CONSTRAINT periodo_academico_estado_check CHECK (((estado)::text = ANY ((ARRAY['BORRADOR'::character varying, 'FINALIZADO'::character varying])::text[]))),
    CONSTRAINT periodo_academico_numero_check CHECK ((numero = ANY (ARRAY[1, 2])))
);

ALTER TABLE public.periodo_academico ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.periodo_academico_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.plan_estudio (
    id bigint NOT NULL,
    carrera_id bigint NOT NULL,
    codigo character varying(40) NOT NULL,
    nombre character varying(150) NOT NULL,
    anio smallint,
    resolucion_id bigint,
    CONSTRAINT plan_estudio_anio_check CHECK (((anio >= 1900) AND (anio <= 2200)))
);

ALTER TABLE public.plan_estudio ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.plan_estudio_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.sesion_horario (
    id bigint NOT NULL,
    periodo_id bigint NOT NULL,
    tipo character varying(15) DEFAULT 'CLASE'::character varying NOT NULL,
    asignacion_id bigint,
    grupo_tutoria_id bigint,
    docente_id bigint,
    ambiente_id bigint NOT NULL,
    dia smallint NOT NULL,
    hora_inicio time without time zone NOT NULL,
    hora_fin time without time zone NOT NULL,
    rango_minutos int4range GENERATED ALWAYS AS (int4range(((EXTRACT(epoch FROM hora_inicio) / (60)::numeric))::integer, ((EXTRACT(epoch FROM hora_fin) / (60)::numeric))::integer, '[)'::text)) STORED,
    excepcion_duracion boolean DEFAULT false NOT NULL,
    observaciones text,
    CONSTRAINT sesion_dia_valido CHECK (((dia >= 1) AND (dia <= 7))),
    CONSTRAINT sesion_horario_check CHECK (((((tipo)::text = 'TUTORIA'::text) AND (asignacion_id IS NULL) AND (grupo_tutoria_id IS NOT NULL) AND (docente_id IS NULL)) OR (((tipo)::text = ANY ((ARRAY['CLASE'::character varying, 'ACTIVIDAD_JP'::character varying])::text[])) AND (asignacion_id IS NOT NULL) AND (grupo_tutoria_id IS NULL) AND (docente_id IS NOT NULL)))),
    CONSTRAINT sesion_horario_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['CLASE'::character varying, 'TUTORIA'::character varying, 'ACTIVIDAD_JP'::character varying])::text[]))),
    CONSTRAINT sesion_orden_horas CHECK ((hora_fin > hora_inicio)),
    CONSTRAINT sesion_precision_minutos CHECK (((EXTRACT(second FROM hora_inicio) = (0)::numeric) AND (EXTRACT(second FROM hora_fin) = (0)::numeric)))
);

ALTER TABLE public.sesion_horario ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sesion_horario_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.usuario (
    id smallint DEFAULT 1 NOT NULL,
    nombre_completo character varying(180) NOT NULL,
    nombre_usuario character varying(60) NOT NULL,
    password_hash text NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    creado_en timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT usuario_id_check CHECK ((id = 1)),
    CONSTRAINT usuario_password_hash_check CHECK ((btrim(password_hash) <> ''::text))
);

ALTER TABLE ONLY public.ambiente
    ADD CONSTRAINT ambiente_codigo_key UNIQUE (codigo);

ALTER TABLE ONLY public.ambiente
    ADD CONSTRAINT ambiente_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_id_periodo_id_docente_id_key UNIQUE (id, periodo_id, docente_id);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_id_periodo_id_key UNIQUE (id, periodo_id);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_id_periodo_id_rol_key UNIQUE (id, periodo_id, rol);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asignacion_oferta
    ADD CONSTRAINT asignacion_oferta_oferta_id_rol_key UNIQUE (oferta_id, rol);

ALTER TABLE ONLY public.asignacion_oferta
    ADD CONSTRAINT asignacion_oferta_pkey PRIMARY KEY (asignacion_id, oferta_id);

ALTER TABLE ONLY public.asignatura
    ADD CONSTRAINT asignatura_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asignatura
    ADD CONSTRAINT asignatura_plan_id_codigo_key UNIQUE (plan_id, codigo);

ALTER TABLE ONLY public.carrera
    ADD CONSTRAINT carrera_codigo_key UNIQUE (codigo);

ALTER TABLE ONLY public.carrera
    ADD CONSTRAINT carrera_nombre_key UNIQUE (nombre);

ALTER TABLE ONLY public.carrera
    ADD CONSTRAINT carrera_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.configuracion
    ADD CONSTRAINT configuracion_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.departamento_academico
    ADD CONSTRAINT departamento_academico_nombre_key UNIQUE (nombre);

ALTER TABLE ONLY public.departamento_academico
    ADD CONSTRAINT departamento_academico_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.docente
    ADD CONSTRAINT docente_documento_identidad_key UNIQUE (documento_identidad);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_docente_id_periodo_id_key UNIQUE (docente_id, periodo_id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_id_periodo_id_docente_id_rol_key UNIQUE (id, periodo_id, docente_id, rol);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_id_periodo_id_key UNIQUE (id, periodo_id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.docente
    ADD CONSTRAINT docente_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_periodo_id_carrera_id_documento_id_key UNIQUE (periodo_id, carrera_id, documento_id);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_periodo_id_carrera_id_orden_key UNIQUE (periodo_id, carrera_id, orden);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.documento
    ADD CONSTRAINT documento_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fusion_asignatura
    ADD CONSTRAINT fusion_asignatura_pkey PRIMARY KEY (fusion_id, asignatura_id);

ALTER TABLE ONLY public.fusion
    ADD CONSTRAINT fusion_id_periodo_id_key UNIQUE (id, periodo_id);

ALTER TABLE ONLY public.fusion
    ADD CONSTRAINT fusion_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_id_periodo_id_key UNIQUE (id, periodo_id);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_periodo_id_plan_id_ciclo_seccion_key UNIQUE (periodo_id, plan_id, ciclo, seccion);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ocupacion_grupo
    ADD CONSTRAINT ocupacion_grupo_pkey PRIMARY KEY (sesion_id, grupo_id);

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_id_periodo_id_key UNIQUE (id, periodo_id);

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_periodo_id_asignatura_id_grupo_id_key UNIQUE (periodo_id, asignatura_id, grupo_id);

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.periodo_academico
    ADD CONSTRAINT periodo_academico_anio_numero_key UNIQUE (anio, numero);

ALTER TABLE ONLY public.periodo_academico
    ADD CONSTRAINT periodo_academico_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plan_estudio
    ADD CONSTRAINT plan_estudio_carrera_id_codigo_key UNIQUE (carrera_id, codigo);

ALTER TABLE ONLY public.plan_estudio
    ADD CONSTRAINT plan_estudio_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_id_periodo_id_dia_rango_minutos_key UNIQUE (id, periodo_id, dia, rango_minutos);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sin_cruce_ambiente EXCLUDE USING gist (periodo_id WITH =, dia WITH =, ambiente_id WITH =, rango_minutos WITH &&);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sin_cruce_docente EXCLUDE USING gist (periodo_id WITH =, dia WITH =, docente_id WITH =, rango_minutos WITH &&) WHERE ((docente_id IS NOT NULL));

ALTER TABLE ONLY public.ocupacion_grupo
    ADD CONSTRAINT sin_cruce_grupo EXCLUDE USING gist (periodo_id WITH =, grupo_id WITH =, dia WITH =, rango_minutos WITH &&);

ALTER TABLE ONLY public.usuario
    ADD CONSTRAINT usuario_nombre_usuario_key UNIQUE (nombre_usuario);

ALTER TABLE ONLY public.usuario
    ADD CONSTRAINT usuario_pkey PRIMARY KEY (id);

CREATE INDEX idx_asignacion_docente_periodo ON public.asignacion_carga USING btree (docente_periodo_id);

CREATE INDEX idx_asignacion_fusion ON public.asignacion_carga USING btree (fusion_id);

CREATE INDEX idx_asignacion_oferta_oferta ON public.asignacion_oferta USING btree (oferta_id);

CREATE INDEX idx_asignatura_departamento ON public.asignatura USING btree (departamento_id);

CREATE INDEX idx_docente_periodo_periodo ON public.docente_periodo USING btree (periodo_id);

CREATE INDEX idx_documento_horario_documento ON public.documento_horario USING btree (documento_id);

CREATE INDEX idx_grupo_plan ON public.grupo_academico USING btree (plan_id);

CREATE INDEX idx_oferta_grupo ON public.oferta_curso USING btree (grupo_id);

CREATE INDEX idx_sesion_asignacion ON public.sesion_horario USING btree (asignacion_id);

CREATE INDEX idx_sesion_tutoria ON public.sesion_horario USING btree (grupo_tutoria_id);

ALTER TABLE ONLY public.ambiente
    ADD CONSTRAINT ambiente_carrera_exclusiva_id_fkey FOREIGN KEY (carrera_exclusiva_id) REFERENCES public.carrera(id);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_docente_periodo_id_periodo_id_docente_id__fkey FOREIGN KEY (docente_periodo_id, periodo_id, docente_id, rol) REFERENCES public.docente_periodo(id, periodo_id, docente_id, rol);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_fusion_id_periodo_id_fkey FOREIGN KEY (fusion_id, periodo_id) REFERENCES public.fusion(id, periodo_id);

ALTER TABLE ONLY public.asignacion_carga
    ADD CONSTRAINT asignacion_carga_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.asignacion_oferta
    ADD CONSTRAINT asignacion_oferta_asignacion_id_periodo_id_rol_fkey FOREIGN KEY (asignacion_id, periodo_id, rol) REFERENCES public.asignacion_carga(id, periodo_id, rol) ON DELETE CASCADE;

ALTER TABLE ONLY public.asignacion_oferta
    ADD CONSTRAINT asignacion_oferta_oferta_id_periodo_id_fkey FOREIGN KEY (oferta_id, periodo_id) REFERENCES public.oferta_curso(id, periodo_id);

ALTER TABLE ONLY public.asignatura
    ADD CONSTRAINT asignatura_departamento_id_fkey FOREIGN KEY (departamento_id) REFERENCES public.departamento_academico(id);

ALTER TABLE ONLY public.asignatura
    ADD CONSTRAINT asignatura_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan_estudio(id);

ALTER TABLE ONLY public.docente
    ADD CONSTRAINT docente_departamento_id_fkey FOREIGN KEY (departamento_id) REFERENCES public.departamento_academico(id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_carrera_reporte_id_fkey FOREIGN KEY (carrera_reporte_id) REFERENCES public.carrera(id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_docente_id_fkey FOREIGN KEY (docente_id) REFERENCES public.docente(id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.docente_periodo
    ADD CONSTRAINT docente_periodo_resolucion_situacion_id_fkey FOREIGN KEY (resolucion_situacion_id) REFERENCES public.documento(id);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_carrera_id_fkey FOREIGN KEY (carrera_id) REFERENCES public.carrera(id);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_documento_id_fkey FOREIGN KEY (documento_id) REFERENCES public.documento(id);

ALTER TABLE ONLY public.documento_horario
    ADD CONSTRAINT documento_horario_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.fusion_asignatura
    ADD CONSTRAINT fusion_asignatura_asignatura_id_fkey FOREIGN KEY (asignatura_id) REFERENCES public.asignatura(id);

ALTER TABLE ONLY public.fusion_asignatura
    ADD CONSTRAINT fusion_asignatura_fusion_id_fkey FOREIGN KEY (fusion_id) REFERENCES public.fusion(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fusion
    ADD CONSTRAINT fusion_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.fusion
    ADD CONSTRAINT fusion_resolucion_id_fkey FOREIGN KEY (resolucion_id) REFERENCES public.documento(id);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_aula_referencia_id_fkey FOREIGN KEY (aula_referencia_id) REFERENCES public.ambiente(id);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.grupo_academico
    ADD CONSTRAINT grupo_academico_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan_estudio(id);

ALTER TABLE ONLY public.ocupacion_grupo
    ADD CONSTRAINT ocupacion_grupo_grupo_id_periodo_id_fkey FOREIGN KEY (grupo_id, periodo_id) REFERENCES public.grupo_academico(id, periodo_id);

ALTER TABLE ONLY public.ocupacion_grupo
    ADD CONSTRAINT ocupacion_grupo_sesion_id_periodo_id_dia_rango_minutos_fkey FOREIGN KEY (sesion_id, periodo_id, dia, rango_minutos) REFERENCES public.sesion_horario(id, periodo_id, dia, rango_minutos) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_asignatura_id_fkey FOREIGN KEY (asignatura_id) REFERENCES public.asignatura(id);

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_grupo_id_periodo_id_fkey FOREIGN KEY (grupo_id, periodo_id) REFERENCES public.grupo_academico(id, periodo_id);

ALTER TABLE ONLY public.oferta_curso
    ADD CONSTRAINT oferta_curso_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);

ALTER TABLE ONLY public.plan_estudio
    ADD CONSTRAINT plan_estudio_carrera_id_fkey FOREIGN KEY (carrera_id) REFERENCES public.carrera(id);

ALTER TABLE ONLY public.plan_estudio
    ADD CONSTRAINT plan_estudio_resolucion_id_fkey FOREIGN KEY (resolucion_id) REFERENCES public.documento(id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_ambiente_id_fkey FOREIGN KEY (ambiente_id) REFERENCES public.ambiente(id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_asignacion_id_periodo_id_docente_id_fkey FOREIGN KEY (asignacion_id, periodo_id, docente_id) REFERENCES public.asignacion_carga(id, periodo_id, docente_id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_docente_id_fkey FOREIGN KEY (docente_id) REFERENCES public.docente(id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_grupo_tutoria_id_periodo_id_fkey FOREIGN KEY (grupo_tutoria_id, periodo_id) REFERENCES public.grupo_academico(id, periodo_id);

ALTER TABLE ONLY public.sesion_horario
    ADD CONSTRAINT sesion_horario_periodo_id_fkey FOREIGN KEY (periodo_id) REFERENCES public.periodo_academico(id);
