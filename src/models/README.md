# Modelos del catálogo

Los modelos Sequelize de `catalogs.js` mapean las tablas instaladas en
`public`. Cuando la API y la base usan nombres distintos, `field` conserva el
nombre de la columna de PostgreSQL. Las actividades JP se guardan en
`public.asignacion_carga` con modalidad `ACTIVIDAD_JP`.

Las operaciones de carga y horarios usan consultas parametrizadas en la
misma conexión Sequelize. Las migraciones residen en `backend/migrations`.

