import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sequelize } from 'sequelize';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { env } from '../src/config/env.js';

const name = 'carga_pruebas_' + randomBytes(5).toString('hex');
const connection = new Sequelize(env.db.name,env.db.user,env.db.password,{
  host:env.db.host, port:env.db.port, dialect:'postgres', logging:false,
});
try {
  await connection.query(`CREATE DATABASE "${name}"`);
} finally { await connection.close(); }
env.db.name=name;
const { default:db }=await import('../src/config/db.js');
const { migrate }=await import('./migrate.js');
const { default:app }=await import('../src/app.js');
const { initializeOperator }=await import('../src/services/auth.service.js');
const { summarizeTeacher }=await import('../src/services/load.service.js');
const { exportLoad }=await import('../src/services/reports.service.js');
console.log('Base aislada de pruebas:',name);
const raw=request(app);
const api=request.agent(app);
const secret=randomBytes(18).toString('base64url');
const check=async (pending,status) => {
  const res=await pending;
  assert.equal(res.status,status,JSON.stringify(res.body));
  return res.body;
};
const post=(url,data,status=201) => check(api.post('/api'+url).send(data),status);
const get=(url) => check(api.get('/api'+url),200);
const put=(url,data,status=200) => check(api.put('/api'+url).send(data),status);
const cat=(key,data,status=201) => post('/catalogos/'+key,data,status);
const list=(key) => get('/catalogos/'+key);
const remove=(url,data,status=204) => check(api.delete('/api'+url).send(data),status);
const createPdf=async (title,width) => {
  const pdf=await PDFDocument.create();
  const page=pdf.addPage([width,500]);
  page.drawText(title,{ x:40,y:430,size:20,font:await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
};

test('Flujo integrado con PostgreSQL, API y archivos',async (t) => {
  t.after(() => db.close());
  const baseline = await readFile(new URL('../migrations/001_esquema.sql', import.meta.url), 'utf8');
  await db.query(baseline);
  await db.query('INSERT INTO public.departamento_academico(nombre) VALUES($1)', { bind: ['Departamento preexistente'] });
  await migrate(db);
  await migrate(db);
  const [[preserved]] = await db.query('SELECT nombre FROM public.departamento_academico WHERE id=1');
  assert.equal(preserved.nombre,'Departamento preexistente');
  const run=async (title,fn) => {
    let failure;
    await t.test(title,async () => {
      try { await fn(); } catch (error) { failure=error; throw error; }
    });
    if (failure) throw failure;
  };
  await run('acceso, usuario único, credenciales, recuperación y revocación',async () => {
    await check(raw.get('/api/health/db'),200);
    await check(raw.get('/api/periodos'),401);
    await initializeOperator('operador_pruebas',secret,'Operador de pruebas');
    const [[account]] = await db.query('SELECT id,nombre_usuario,nombre_completo,activo FROM public.usuario');
    assert.deepEqual(account,{id:1,nombre_usuario:'operador_pruebas',nombre_completo:'Operador de pruebas',activo:true});
    await assert.rejects(initializeOperator('otro_operador',secret),{code:'OPERATOR_EXISTS'});
    await post('/auth/login',{usuario:'operador_pruebas',password:'incorrecta'},401);
    await db.query('UPDATE public.usuario SET activo=false');
    await post('/auth/login',{usuario:'operador_pruebas',password:secret},401);
    await db.query('UPDATE public.usuario SET activo=true');
    const login=await api.post('/api/auth/login').send({usuario:'operador_pruebas',password:secret});
    assert.equal(login.status,200);
    assert.match(login.headers['set-cookie'][0],/HttpOnly.*SameSite=Strict/);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    assert.deepEqual(await get('/auth/me'),{usuario:'operador_pruebas'});
    await post('/auth/logout',{},204);
    await check(raw.get('/api/auth/me').set('Cookie',cookie),401);
    await post('/auth/login',{usuario:'operador_pruebas',password:secret},200);
  });
  let period, other, base, eiib, cpg, dept, planE, planC, gE, gC, room, alternate, teacher, jp, sab, resolution;
  let fusion, directed, offers=[], schedule, proposal, attachmentA, attachmentB;
  await run('catálogos, períodos, horas generadas y relaciones por plan y ciclo',async () => {
    const firstPeriod=await post('/periodos',{nombre:'2041-0'});
    assert.equal(firstPeriod.semestre,0);
    assert.equal(firstPeriod.inicio,null);
    assert.deepEqual((await get('/periodos/'+firstPeriod.id+'/carga')).ofertas,[]);
    period=await post('/periodos',{ nombre:'2038-I' });
    assert.match((await post('/periodos',{nombre:' 2038-i '},409)).message,/ya existe/);
    other=await post('/periodos',{ anio:2038,semestre:2,inicio:'2038-08-01',fin:'2038-12-31' });
    base='/periodos/'+period.id;
    await post(base+'/activar',{},200);
    [eiib,cpg]=(await list('carreras')).items;
    dept=await cat('departamentos',{nombre:'Humanidades'});
    planE=await cat('planes',{ carrera_id:eiib.id,codigo:'PE-2038',nombre:'Plan EIIB',anio:2038 });
    planC=await cat('planes',{ carrera_id:cpg.id,codigo:'PC-2038',nombre:'Plan CPG',anio:2038 });
    gE=await cat('grupos',{periodo_id:period.id,plan_id:planE.id,ciclo:1,seccion:'A'});
    gC=await cat('grupos',{periodo_id:period.id,plan_id:planC.id,ciclo:1,seccion:'B'});
    assert.equal(gE.turno,'MANANA');
    const groupPM=await cat('grupos',{periodo_id:other.id,plan_id:planC.id,ciclo:2,seccion:'UNICA'});
    assert.equal(groupPM.turno,'TARDE');
    room=await cat('ambientes',{codigo:'CENTRAL-101',nombre:'Aula 101',ubicacion:'Central',tipo:'AULA'});
    alternate=await cat('ambientes',{codigo:'CENTRAL-102',nombre:'Aula 102',ubicacion:'Central',tipo:'AULA'});
    const createOffer=async (code,group,plan,hours) => {
      const subject=await cat('asignaturas',{plan_id:plan.id,departamento_id:dept.id,codigo:code,nombre:'Curso '+code,ciclo:group.ciclo,
        creditos:9,teoria:2,practica:hours-2,laboratorio:0});
      assert.equal(subject.horas,hours);
      await cat('ofertas',{periodo_id:other.id,grupo_id:group.id,asignatura_id:subject.id},422);
      return cat('ofertas',{periodo_id:period.id,grupo_id:group.id,asignatura_id:subject.id});
    };
    offers=await Promise.all([createOffer('E01',gE,planE,4),createOffer('C01',gC,planC,4),createOffer('E02',gE,planE,5),
      createOffer('C02',gC,planC,4),createOffer('E03',gE,planE,4),createOffer('C03',gC,planC,5)]);
    const p1=await cat('docentes',{identificacion:'PRUEBA-1',nombres:'Ana',apellidos:'Ejemplo'});
    const p2=await cat('docentes',{identificacion:'PRUEBA-2',nombres:'Rosa',apellidos:'Práctica'});
    const p3=await cat('docentes',{identificacion:'PRUEBA-3',nombres:'Luis',apellidos:'Sabático'});
    assert.equal((await get('/catalogos/docentes?q=Práctica')).total,1);
    const offered = await get('/catalogos/asignaturas?solo_oferta=1&carrera=EIIB&periodo_id='+period.id);
    assert.equal(offered.total,3);
    assert.ok(offered.items.every((item) => item.plan_id===planE.id));
    assert.equal((await get('/catalogos/asignaturas?solo_oferta=1&periodo_id='+other.id)).total,0);
    resolution=await cat('documentos',{tipo:'RESOLUCION',numero:'R-01'});
    teacher=await cat('docentes-periodo',{periodo_id:period.id,docente_id:p1.id,tipo:'NOMBRADO',jornada:40,situacion:'DOCENCIA'});
    jp=await cat('docentes-periodo',{periodo_id:period.id,docente_id:p2.id,carrera_reporte_id:cpg.id,tipo:'JP',jornada:40,situacion:'DOCENCIA',horas_cumplimiento:40});
    sab=await cat('docentes-periodo',{periodo_id:period.id,docente_id:p3.id,carrera_reporte_id:eiib.id,tipo:'CONTRATADO',jornada:40,situacion:'SABATICO',documento_id:resolution.id});
    await cat('actividades-jp',{docente_periodo_id:jp.id,descripcion:'Sala de estimulación',horas:4});
    const staff = await get('/catalogos/docentes?carrera=CPG&tipo=JP&periodo_id='+period.id);
    assert.deepEqual(staff.items.map((item) => item.id),[p2.id]);
    await cat('docentes-periodo',{periodo_id:period.id,docente_id:p1.id,tipo:'NOMBRADO',jornada:40,situacion:'DOCENCIA'},409);
  });
  await run('borrador, mínimo obligatorio, dirigido, fusión, sabático y JP',async () => {
    for (const [jornada,minimo] of [[40,20],[32,16],[16,8],[33,16.5]]) {
      assert.equal(summarizeTeacher({jornada,tipo:'NOMBRADO',activo:true,situacion:'DOCENCIA'},[],[]).minimo,minimo);
    }
    for (const [hours,missing] of [[17,0],[15,1]]) {
      assert.equal(summarizeTeacher({jornada:32,tipo:'NOMBRADO',activo:true,situacion:'DOCENCIA'},[{horas:hours}],[]).faltantes,missing);
    }
    const assign=(ids,modalidad,extras={},status=201) => post(base+'/carga',{docente_periodo_id:teacher.id,oferta_ids:ids,modalidad,...extras},status);
    await assign([offers[0].id],'REGULAR');
    await post(base+'/carga-completa',{},409);
    await assign([offers[1].id],'REGULAR');
    directed=await assign([offers[5].id],'DIRIGIDO');
    await assign([offers[4].id],'REGULAR');
    const fusionBody={asignatura_ids:offers.slice(2,4).map((o) => o.asignatura_id),resolucion_id:resolution.id,horas_compartidas:5};
    await post(base+'/fusiones',fusionBody,422);
    await check(api.put('/api/documentos/'+resolution.id+'/pdf').set('Content-Type','application/pdf').set('X-Filename','resolucion.pdf')
      .send(await createPdf(resolution.numero,420)),200);
    const authorization=await post(base+'/fusiones',fusionBody);
    await post(base+'/fusiones',fusionBody,409);
    fusion=await assign([offers[2].id,offers[3].id],'FUSION',{fusion_id:authorization.id,jp_ids:[jp.id]});
    await assign([offers[0].id],'REGULAR',{},409);
    const load=await get(base+'/carga');
    const summary=load.docentes.find((d) => d.id===teacher.id);
    assert.deepEqual([summary.horas_regulares,summary.horas_dirigidas,summary.horas_asignadas],[17,5,22]);
    assert.equal(load.docentes.find((d) => d.id===sab.id).minimo,null);
    assert.equal(load.docentes.find((d) => d.id===jp.id).horas_cumplimiento,'40.00');
    assert.equal(load.docentes.find((d) => d.id===jp.id).minimo,null);
    assert.equal(load.asignaciones.find((a) => a.id===fusion.id).horas,5);
    await post(base+'/carga-completa',{},200);
  });
  await run('franjas, cruces, intervalos adyacentes, tutorías y dependencias',async () => {
    const draft={tipo:'CLASE',asignacion_id:fusion.id,ambiente_id:room.id,dia:1,inicio:7,fin:9};
    const add=(data,status=201) => post(base+'/horario',{...draft,...data},status);
    const first=await add({});
    await add({asignacion_id:directed.id,ambiente_id:alternate.id},409);
    await add({asignacion_id:directed.id,inicio:9,fin:11});
    await add({inicio:8,fin:10},409);
    await add({inicio:9,fin:10,asignacion_id:fusion.id},409);
    await add({dia:6},422);
    await add({inicio:12,fin:14},422);
    await add({inicio:15,fin:17},422);
    await add({dia:2,inicio:7,fin:9});
    await add({dia:3,inicio:7,fin:8},409);
    const tutor=await post(base+'/horario',{tipo:'TUTORIA',grupo_id:gE.id,dia:4,inicio:14,fin:18});
    assert.equal(tutor.ambiente_id,null);
    assert.equal(tutor.docente_id,null);
    await post(base+'/horario',{tipo:'TUTORIA',grupo_id:gC.id,dia:1,inicio:8,fin:9},409);
    await post(base+'/horario',{tipo:'TUTORIA',grupo_id:gE.id,dia:3,inicio:14,fin:18},422);
    await remove(base+'/carga/'+fusion.id,{},409);
    await put(base+'/horario/'+first.id,{...draft,dia:5});
    schedule=await get(base+'/horario');
    assert.equal(schedule.sesiones.find((s) => s.id===first.id).grupos.length,2);
    assert.equal(schedule.sesiones.find((s) => s.id===first.id).docentes.length,2);
  });
  await run('generación conjunta, propuestas parciales y aplicación atómica',async () => {
    const partial=await post(base+'/propuesta',{alcance:'EIIB'},200);
    assert.equal(partial.estado,'PARCIAL');
    assert.ok(partial.causas.some((c) => c.id===fusion.id));
    proposal=await post(base+'/propuesta',{alcance:'TODAS'},200);
    assert.equal(proposal.estado,'COMPLETA',JSON.stringify(proposal.pendientes));
    assert.deepEqual((await get(base+'/horario')).sesiones,schedule.sesiones);
    const duplicated={...proposal,sesiones:[...proposal.sesiones,proposal.sesiones[0]]};
    await post(base+'/aplicar-propuesta',duplicated,409);
    assert.deepEqual((await get(base+'/horario')).sesiones,schedule.sesiones);
    const changed = proposal.sesiones.find((s) => s.tipo==='CLASE' && s.ambiente_id===room.id);
    assert.ok(changed);
    changed.ambiente_id=alternate.id;
    await post(base+'/aplicar-propuesta',proposal,200);
    await post(base+'/aplicar-propuesta',proposal,409);
    schedule=await get(base+'/horario');
    assert.ok(schedule.avance.cursos.every((c) => c.pendientes===0));
    assert.equal(schedule.avance.tutorias.length,0);
    assert.ok(schedule.sesiones.some((s) => s.asignacion_id===changed.asignacion_id && s.ambiente_id===alternate.id && s.dia===changed.dia && s.inicio===changed.inicio));
    const fusionDays=schedule.sesiones.filter((s) => s.asignacion_id===fusion.id).map((s) => s.dia);
    assert.deepEqual(fusionDays,[1,3,5]);
  });
  await run('previsualización, Excel de tres hojas, PDF y orden de anexos',async () => {
    attachmentA=await cat('documentos',{tipo:'CARTA',numero:'A-02'});
    attachmentB=await cat('documentos',{tipo:'RESOLUCION',numero:'R-02'});
    for (const [doc,width] of [[attachmentA,400],[attachmentB,450]]) {
      await check(api.put('/api/documentos/'+doc.id+'/pdf').set('Content-Type','application/pdf').set('X-Filename','anexo.pdf')
        .send(await createPdf(doc.numero,width)),200);
      await cat('documentos-horario',{periodo_id:period.id,carrera_id:eiib.id,documento_id:doc.id,orden:width===400 ? 1 : 2});
    }
    const preview=await get(base+'/reportes/carga');
    assert.equal(preview.hojas.length,3);
    const excel=await api.get('/api'+base+'/reportes/carga.xlsx').buffer(true).parse((res,callback) => {
      const data=[]; res.on('data',(part) => data.push(part)); res.on('end',() => callback(null,Buffer.concat(data)));
    });
    assert.equal(excel.status,200);
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(excel.body);
    assert.deepEqual(book.worksheets.map((s) => s.name),['Docentes ordinarios','Educación Inicial','Ciencia Política']);
    assert.equal(book.worksheets[0].getCell('M6').result,22);
    assert.equal(book.worksheets[1].getCell('G6').value,'AÑO SABÁTICO');
    assert.equal(book.worksheets[2].getCell('N6').value,40);
    const report=await get(base+'/reportes/horario/EIIB');
    assert.ok(report.grupos[0].sesiones.some((s) => s.tipo==='TUTORIA' && !s.participantes.length && !s.ambiente_codigo));
    const pdf=await api.post('/api'+base+'/reportes/horario/EIIB/pdf').send({documentos:[attachmentB.id,attachmentA.id]});
    assert.equal(pdf.status,200);
    const combined=await PDFDocument.load(pdf.body);
    assert.deepEqual(combined.getPages().slice(0,3).map((p) => p.getWidth()),[450,400,842]);
    const only=await api.post('/api'+base+'/reportes/horario/EIIB/pdf').send({});
    assert.equal(only.status,200);
    assert.equal((await PDFDocument.load(only.body)).getPageCount(),combined.getPageCount()-2);
    const politics=await api.post('/api'+base+'/reportes/horario/CPG/pdf').send({});
    assert.equal(politics.status,200);
    assert.equal((await PDFDocument.load(politics.body)).getPage(0).getWidth(),842);
    const dir=await mkdtemp(join(tmpdir(),'carga-reportes-'));
    await Promise.all([writeFile(join(dir,'carga.xlsx'),excel.body),writeFile(join(dir,'horario.pdf'),only.body),writeFile(join(dir,'horario-cpg.pdf'),politics.body)]);
    console.log('Reportes de verificación:',dir);
  });
  await run('ficha por semestre y oferta copiada',async () => {
    const staff={nombre_completo:'Persona de prueba',activo:true,tipo:'CONTRATADO',jornada:32,categoria:'DC-B1',condicion:'Dedicación parcial',
      situacion:'DOCENCIA',carrera_referencia_id:eiib.id,carrera_reporte_id:eiib.id,cargo:'Coordinación',
      referencia_sustento:'Acta de prueba',regla_minimo_pendiente:true,observaciones:'Ficha del primero',horas_referencia:17};
    const staffPeriod='/periodos/'+other.id;
    const next=await post('/periodos',{anio:2040,semestre:1,inicio:'2040-03-01',fin:'2040-07-31'});
    const nextPeriod='/periodos/'+next.id;
    const saved=await post(staffPeriod+'/personal',staff);
    await put(nextPeriod+'/personal/'+saved.persona.id,{...staff,jornada:16,categoria:'DC-B2',observaciones:'Ficha del segundo'});
    await put(staffPeriod+'/personal/'+saved.persona.id,{nombre_completo:staff.nombre_completo,tipo:staff.tipo,jornada:staff.jornada,
      categoria:staff.categoria,condicion:staff.condicion,situacion:staff.situacion,carrera_referencia_id:eiib.id,carrera_reporte_id:eiib.id,
      regla_minimo_pendiente:true,observaciones:staff.observaciones});
    const first=(await get(staffPeriod+'/carga')).docentes.find((d) => d.docente_id===saved.persona.id);
    const second=(await get(nextPeriod+'/carga')).docentes.find((d) => d.docente_id===saved.persona.id);
    assert.deepEqual([first.jornada,first.categoria,first.observaciones,first.minimo,first.referencia_sustento,first.horas_referencia],
      [32,'DC-B1','Ficha del primero',16,'Acta de prueba','17.00']);
    assert.deepEqual([second.jornada,second.categoria,second.minimo],[16,'DC-B2',8]);
    const groupIX=await cat('grupos',{periodo_id:next.id,plan_id:planE.id,ciclo:9,seccion:'A'});
    const proposalIX=await post(nextPeriod+'/propuesta',{alcance:'EIIB'},200);
    const tutorIX=proposalIX.sesiones.find((s) => s.tipo==='TUTORIA' && s.grupo_id===groupIX.id);
    assert.deepEqual([tutorIX.dia,tutorIX.inicio,tutorIX.fin,tutorIX.ambiente_id,tutorIX.docente_id],[4,9,13,null,null]);
    await check(api.get('/api'+base+'/revision'),404);
    const withoutCopy=await post('/periodos',{nombre:'2039-II'});
    const termCourses=async (id) => (await get('/catalogos/asignaturas?solo_oferta=1&activos=1&periodo_id='+id)).items;
    assert.deepEqual(await termCourses(withoutCopy.id),[]);
    assert.deepEqual((await get('/periodos/'+withoutCopy.id+'/carga')).ofertas,[]);
    const clone=await post('/periodos',{nombre:'2039-I',copiar_desde:period.id});
    const cloned=await get('/periodos/'+clone.id+'/carga');
    const sourceCourses=await termCourses(period.id);
    assert.deepEqual(await termCourses(clone.id),sourceCourses);
    assert.deepEqual(cloned.ofertas.map((o) => o.asignatura_id).sort(),offers.map((o) => o.asignatura_id).sort());
    assert.ok(cloned.ofertas.every((o) => !offers.some((source) => source.id===o.id || source.grupo_id===o.grupo_id)));
    const removedCourse=cloned.ofertas.find((o) => o.codigo==='C03');
    await put('/periodos/'+clone.id+'/oferta-asignaturas',{asignatura_ids:[removedCourse.asignatura_id],ofertada:false});
    assert.deepEqual(await termCourses(clone.id),sourceCourses.filter((a) => a.id!==removedCourse.asignatura_id));
    assert.deepEqual(await termCourses(period.id),sourceCourses);
    assert.ok((await get(base+'/carga')).ofertas.some((o) => o.asignatura_id===removedCourse.asignatura_id));
    const subject=await cat('asignaturas',{plan_id:planE.id,codigo:'E-NUEVO',nombre:'Materia verificable',ciclo:1,creditos:3,teoria:2,practica:1,laboratorio:0,horas:20});
    const group=cloned.grupos.find((g) => g.carrera==='EIIB');
    const cloneBase='/periodos/'+clone.id;
    assert.equal((await post(cloneBase+'/ofertar',{grupo_id:group.id,asignatura_ids:[subject.id]},200)).agregadas,1);
    assert.equal((await post(cloneBase+'/ofertar',{grupo_id:group.id,filtradas:true,q:'E-NUEVO',carrera:'EIIB'},200)).existentes,1);
    const member=await put(cloneBase+'/personal/'+saved.persona.id,{...staff,regla_minimo_pendiente:false});
    const offer=(await get(cloneBase+'/carga')).ofertas.find((o) => o.asignatura_id===subject.id);
    const assignment={docente_periodo_id:member.ficha.id,oferta_ids:[offer.id],modalidad:'REGULAR'};
    const added=await post(cloneBase+'/carga',assignment);
    assert.equal((await get(cloneBase+'/carga')).docentes[0].horas_asignadas,3);
    await put(cloneBase+'/carga/'+added.id,{...assignment,modalidad:'DIRIGIDO',observaciones:'Editada'});
    assert.equal((await get(cloneBase+'/carga')).docentes[0].horas_dirigidas,3);
    await remove(cloneBase+'/carga/'+added.id,{});
    const refreshed=await get(cloneBase+'/carga');
    assert.equal(refreshed.docentes[0].horas_asignadas,0);
    assert.ok(refreshed.pendientes.some((issue) => issue.tipo==='OFERTA' && issue.id===offer.id));
    assert.equal(cloned.grupos.length,2);
    assert.deepEqual(cloned.asignaciones,[]);
    assert.deepEqual(cloned.docentes,[]);
    assert.deepEqual((await get('/periodos/'+clone.id+'/horario')).sesiones,[]);
    const secondMember=await post(cloneBase+'/personal',{...staff,nombre_completo:'Segunda persona de prueba'});
    const rooms=(await list('ambientes')).items;
    const exclusive=await cat('ambientes',{codigo:'E-EXCLUSIVA',nombre:'Aula de Inicial',ubicacion:'Central',tipo:'AULA',carrera_id:eiib.id});
    const assignOffer=(code,person) => post(cloneBase+'/carga',{docente_periodo_id:person.ficha.id,
      oferta_ids:[cloned.ofertas.find((o) => o.codigo===code).id],modalidad:'REGULAR'});
    const firstCourse=await assignOffer('E01',member);
    const sameTeacher=await assignOffer('C01',member);
    const otherGroup=await assignOffer('C02',secondMember);
    const sameGroup=await assignOffer('E03',secondMember);
    const block={tipo:'CLASE',asignacion_id:firstCourse.id,ambiente_id:rooms[0].id,dia:1,inicio:7,fin:9};
    await post(cloneBase+'/horario',block);
    const clash=(a,r) => post(cloneBase+'/horario',{...block,asignacion_id:a.id,ambiente_id:r.id},409);
    assert.match((await clash(sameTeacher,rooms[1])).message,/docente o JP/);
    assert.match((await clash(otherGroup,rooms[0])).message,/ambiente/);
    assert.match((await clash(sameGroup,rooms[1])).message,/grupo/);
    assert.match((await post(cloneBase+'/horario',{...block,asignacion_id:otherGroup.id,ambiente_id:exclusive.id},422)).message,/ambiente activo compatible/);
  });
  await run('malla pendiente, carga regular y aviso por exceso de horario',async () => {
    const p=await post('/periodos',{nombre:'2042-II'});
    const prefix='/periodos/'+p.id;
    const fields={periodo_id:p.id,carrera_id:eiib.id,plan:'Nueva 2042',codigo:'test-malla',nombre:'Prueba de malla',
      ciclo:3,creditos:2.5,teoria:3,practica:1,ofertada:true};
    const subject=await post('/catalogos/asignaturas/ficha',fields);
    assert.equal(subject.horas,null);
    await post('/catalogos/asignaturas/ficha',fields,409);
    const load=await get(prefix+'/carga');
    assert.equal(load.grupos[0].seccion,'UNICO');
    const offer=load.ofertas.find((o) => o.asignatura_id===subject.id);
    const teacher=await post(prefix+'/personal',{nombre_completo:'Docente malla',tipo:'NOMBRADO',jornada:32,
      carrera_referencia_id:eiib.id,situacion:'DOCENCIA',regla_minimo_pendiente:false});
    const assignment={docente_periodo_id:teacher.ficha.id,oferta_ids:[offer.id],modalidad:'REGULAR',horas_asignadas:20};
    await post(prefix+'/carga',assignment,422);
    const completed=await put('/catalogos/asignaturas/ficha/'+subject.id,{...fields,practica:2,laboratorio:0,horas:20});
    assert.equal(completed.horas,5);
    const assigned=await post(prefix+'/carga',assignment);
    assert.equal(assigned.horas_semanales,5);
    assert.equal((await put(prefix+'/carga/'+assigned.id,assignment)).horas_semanales,5);
    const slot={tipo:'CLASE',asignacion_id:assigned.id,ambiente_id:room.id,inicio:7};
    await post(prefix+'/horario',{...slot,dia:1,fin:9});
    await post(prefix+'/horario',{...slot,dia:3,fin:9});
    await post(prefix+'/horario',{...slot,dia:5,fin:8});
    const previous=(await get(prefix+'/horario')).sesiones;
    const [group]=load.grupos;
    const updatedGroup=await put('/catalogos/grupos/'+group.id,{periodo_id:p.id,plan_id:group.plan_id,ciclo:String(group.ciclo),seccion:''});
    assert.deepEqual([updatedGroup.id,updatedGroup.ciclo,updatedGroup.seccion],[group.id,3,'UNICA']);
    assert.equal((await get(prefix+'/carga')).asignaciones[0].id,assigned.id);
    assert.deepEqual((await get(prefix+'/horario')).sesiones,previous);
    await put('/catalogos/asignaturas/ficha/'+subject.id,{...fields,laboratorio:0});
    const corrected=await get(prefix+'/carga');
    assert.equal(corrected.asignaciones[0].horas,4);
    assert.equal(corrected.asignaciones[0].horas_semanales,4);
    assert.ok(corrected.avisos.some((a) => a.tipo==='HORARIO_EXCESO'));
    const schedule=await get(prefix+'/horario');
    assert.deepEqual(schedule.sesiones,previous);
    assert.deepEqual(schedule.avance.cursos[0],{id:assigned.id,requeridas:4,programadas:5,pendientes:0,exceso:1});
    const toggle={asignatura_ids:[subject.id],ofertada:false};
    await put(prefix+'/oferta-asignaturas',toggle,409);
    await remove(prefix+'/carga/'+assigned.id,{retirar_sesiones:true});
    await put(prefix+'/oferta-asignaturas',toggle);
    assert.deepEqual((await get(prefix+'/carga')).ofertas,[]);
    const draft=await post('/catalogos/asignaturas/ficha',{...fields,codigo:'ciclo-pendiente',ciclo:null,laboratorio:0,ofertada:false});
    assert.equal(draft.ciclo,null);
    await put(prefix+'/oferta-asignaturas',{asignatura_ids:[subject.id,draft.id],ofertada:true});
    assert.equal((await get(prefix+'/carga')).ofertas.length,1);
  });
  await run('cuadro compartido, créditos numéricos y total de una fusión',async () => {
    const term=await post('/periodos',{nombre:'2043-I'});
    const reportBase='/periodos/'+term.id;
    const ordinario={nombres:'Mg. Luis',apellidos:'Pérez',identificacion:'00000001',tipo:'NOMBRADO',jornada:40,
      categoria:'Principal',codigo_personal:'N-1',carrera_referencia_id:eiib.id,situacion:'DOCENCIA',observaciones:'Cargo y Resolución de prueba'};
    const teacher=await post(reportBase+'/personal',ordinario);
    await put(reportBase+'/personal/'+teacher.persona.id,{...ordinario,apellidos:'Pérez Quispe',identificacion:'00000002',
      categoria:'PrincTC40 Hrs',codigo_personal:'N'});
    const saved=await get('/catalogos/docentes/'+teacher.persona.id);
    assert.deepEqual([saved.nombres,saved.apellidos,saved.identificacion,saved.nombre_completo],
      ['Mg. Luis','Pérez Quispe','00000002','Mg. Luis Pérez Quispe']);
    const [ficha]= (await get(reportBase+'/carga')).docentes;
    assert.deepEqual([ficha.categoria,ficha.codigo_personal,ficha.condicion],['PrincTC40 Hrs','N',null]);
    const create=async (code,name,credits,cycle) => {
      const subject=await post('/catalogos/asignaturas/ficha',{periodo_id:term.id,carrera_id:eiib.id,plan:planE.codigo, codigo:code,
        nombre:name,ciclo:cycle,creditos:credits,teoria:3,practica:2,laboratorio:0,ofertada:true});
      return (await get(reportBase+'/carga')).ofertas.find((o) => o.asignatura_id===subject.id);
    };
    const first=await create('EI703','Matemática andina',4,3);
    const second=await create('AEI22','Matemática creativa lúdica pedagógica',3.5,2);
    const third=await create('AEI82','Didáctica en ciencia y tecnología',4,8);
    const assign=(offers,extra={}) => ({docente_periodo_id:teacher.ficha.id,modalidad:'REGULAR',oferta_ids:offers.map((o) => o.id),...extra});
    const firstAssignment=await post(reportBase+'/carga',assign([first],{horas_asignadas:20}));
    assert.equal(firstAssignment.horas_semanales,5);
    const secondAssignment=await post(reportBase+'/carga',assign([second]));
    const thirdAssignment=await post(reportBase+'/carga',assign([third]));
    const checkReport=async (hours,total) => {
      const preview=await get(reportBase+'/reportes/carga');
      const person=preview.hojas[0].docentes[0];
      assert.deepEqual([person.nombre_completo,person.categoria,person.codigo_personal],['Mg. Luis Pérez Quispe','PrincTC40 Hrs','N']);
      assert.deepEqual(person.filas.map((r) => r.horas),hours);
      assert.equal(person.total,total);
      const excel=await api.get('/api'+reportBase+'/reportes/carga.xlsx').buffer(true).parse((res,done) => {
        const parts=[]; res.on('data',(data) => parts.push(data)); res.on('end',() => done(null,Buffer.concat(parts)));
      });
      assert.equal(excel.status,200);
      const book=new ExcelJS.Workbook();
      await book.xlsx.load(excel.body);
      const sheet=book.worksheets[0];
      assert.deepEqual(sheet.getRow(5).values.slice(1),preview.encabezados);
      assert.deepEqual(['B5','C5','B6','C6','D6'].map((c) => sheet.getCell(c).value),
        ['Cat.','COD.','PrincTC40 Hrs','N','Mg. Luis Pérez Quispe']);
      assert.equal(sheet.getCell('M6').result,total);
      assert.deepEqual(hours.map((_,i) => sheet.getCell('L'+(i+6)).value),hours);
      assert.equal(sheet.getCell('M'+(5+hours.length)).master.address,'M6');
      return { person,sheet,bytes:excel.body };
    };
    const original=await checkReport([5,5,5],15);
    assert.equal(original.sheet.getCell('H6').value,4);
    assert.equal(original.sheet.getCell('H7').value,3.5);
    assert.equal(original.sheet.getCell('F6').value,'III');
    assert.equal(original.sheet.getCell('F8').value,'VIII');
    assert.match(original.sheet.getCell('O6').value,/Resolución/);
    const regular=await put(reportBase+'/carga/'+thirdAssignment.id,assign([third],{horas_asignadas:20}));
    assert.equal(regular.horas_semanales,5);
    await checkReport([5,5,5],15);
    await put(reportBase+'/carga/'+thirdAssignment.id,assign([third],{modalidad:'DIRIGIDO',horas_asignadas:6}));
    const directedReport=await checkReport([5,5,6],16);
    assert.equal(directedReport.sheet.getCell('F8').value,'DIRIGIDO');
    await remove(reportBase+'/carga/'+secondAssignment.id,{});
    await checkReport([5,6],11);
    await remove(reportBase+'/carga/'+firstAssignment.id,{});
    const authorized=await post(reportBase+'/fusiones',{asignatura_ids:[first.asignatura_id,second.asignatura_id],
      resolucion_id:resolution.id,horas_compartidas:5});
    await db.query("UPDATE public.fusion SET nombre='FUSIÓN EI703' WHERE id=$1",{ bind:[authorized.id] });
    await post(reportBase+'/carga',assign([first,second],{modalidad:'FUSION',fusion_id:authorized.id}));
    const fused=await checkReport([6,5],11);
    assert.deepEqual(fused.person.filas.map((r) => r.grupo),['DIRIGIDO','III\nFUSION\nEI703']);
    assert.equal(fused.sheet.getCell('M6').formula,'SUM(L6,L7)');
    const dir=await mkdtemp(join(tmpdir(),'carga-cuadro-'));
    await Promise.all([writeFile(join(dir,'tres-asignaciones.xlsx'),original.bytes),writeFile(join(dir,'fusion.xlsx'),fused.bytes)]);
    console.log('Cuadros de verificación:',dir);
  });
  await run('cambiar nombramiento conserva la ficha, la carga y el horario',async () => {
    const term=await post('/periodos',{nombre:'2044-I'});
    const url='/periodos/'+term.id;
    const profile={nombres:'Mg. Rosa',apellidos:'Vega Soto',identificacion:'00000004',tipo:'CONTRATADO',jornada:32,categoria:'DCB1',
      codigo_personal:'C 32 Hrs',carrera_referencia_id:eiib.id,carrera_reporte_id:eiib.id,
      situacion:'DOCENCIA',observaciones:'Resolución de prueba'};
    const teacher=await post(url+'/personal',{...profile,nombres:'Rosa',apellidos:'Vega',identificacion:'00000003',categoria:'DCB2',codigo_personal:'C',jornada:24});
    assert.deepEqual([teacher.ficha.condicion,teacher.ficha.jornada],[null,24]);
    await db.query('UPDATE public.docente_periodo SET condicion=$1 WHERE id=$2',{bind:['Tiempo parcial',teacher.ficha.id]});
    const path=url+'/personal/'+teacher.persona.id;
    await put(path,profile);
    const saved=await get('/catalogos/docentes/'+teacher.persona.id);
    assert.deepEqual([saved.nombres,saved.apellidos,saved.identificacion,saved.nombre_completo],
      ['Mg. Rosa','Vega Soto','00000004','Mg. Rosa Vega Soto']);
    const [contract]= (await get(url+'/carga')).docentes;
    assert.deepEqual([contract.categoria,contract.codigo_personal,contract.condicion],['DCB1','C 32 Hrs','Tiempo parcial']);
    assert.deepEqual([contract.jornada,contract.minimo],[32,16]);
    const course=await post('/catalogos/asignaturas/ficha',{periodo_id:term.id,carrera_id:eiib.id,plan:planE.codigo,codigo:'NOM2044',
      nombre:'Curso de prueba de nombramiento',ciclo:3,creditos:4,teoria:3,practica:2,laboratorio:0,ofertada:true});
    const offer=(await get(url+'/carga')).ofertas.find((o) => o.asignatura_id===course.id);
    const assignment=await post(url+'/carga',{docente_periodo_id:teacher.ficha.id,oferta_ids:[offer.id],modalidad:'REGULAR'});
    await post(url+'/horario',{tipo:'CLASE',asignacion_id:assignment.id,ambiente_id:room.id,dia:1,inicio:7,fin:9});
    const original=await get(url+'/horario');
    const contractBook=new ExcelJS.Workbook();
    await contractBook.xlsx.load(await exportLoad(term.id));
    const contractSheet=contractBook.getWorksheet('Educación Inicial');
    assert.deepEqual(['D5','E5','D6','E6','F6'].map((c) => contractSheet.getCell(c).value),
      ['Cat.','COD.','DCB1','C 32 Hrs','Mg. Rosa Vega Soto']);
    const named=await put(path,{...profile,tipo:'NOMBRADO'});
    assert.equal(named.ficha.id,teacher.ficha.id);
    assert.equal(named.ficha.tipo,'NOMBRADO');
    assert.equal(named.ficha.carrera_reporte_id,null);
    const preserved=await get(url+'/horario');
    assert.deepEqual(preserved.asignaciones,original.asignaciones);
    assert.deepEqual(preserved.sesiones,original.sesiones);
    assert.equal(preserved.docentes.find((d) => d.id===teacher.ficha.id).horas_asignadas,5);
    const book=new ExcelJS.Workbook();
    const excel=await api.get('/api'+url+'/reportes/carga.xlsx').buffer(true).parse((res,done) => {
      const chunks=[]; res.on('data',(chunk) => chunks.push(chunk)); res.on('end',() => done(null,Buffer.concat(chunks)));
    });
    assert.equal(excel.status,200);
    await book.xlsx.load(excel.body);
    assert.equal(book.getWorksheet('Docentes ordinarios').getCell('D6').value,'Mg. Rosa Vega Soto');
    for (const data of [{tipo:'JP'},{situacion:'SABATICO'},{situacion:'SIN_DOCENCIA'}]) {
      const rejected=await put(path,{...profile,tipo:'NOMBRADO',...data},409);
      assert.match(rejected.message,/asignaciones o actividades vinculadas/);
    }
    const contracted=await put(path,profile);
    assert.equal(contracted.ficha.id,teacher.ficha.id);
    assert.equal(contracted.ficha.tipo,'CONTRATADO');
    assert.deepEqual((await get(url+'/horario')).sesiones,original.sesiones);
  });
  await run('docencia externa por semestre se programa fuera de la carga local',async () => {
    const departments=(await get('/catalogos/departamentos?ambito=externo')).items;
    const basic=departments.find((d) => d.nombre==='Ciencias Básicas');
    assert.ok(basic?.activo);
    assert.ok(!departments.some((d) => d.nombre==='Educación y Ciencia Política'));
    const url='/catalogos/docentes-externos';
    const externalPeriod=await post('/periodos',{nombre:'2026-II'});
    const nextPeriod=await post('/periodos',{nombre:'2027-I'});
    const term='/periodos/'+externalPeriod.id;
    const initial={nombres:'Mg. Luis',apellidos:'Prueba Externa',identificacion:'00000871',departamento_id:basic.id,
      periodo_id:externalPeriod.id,carrera_id:cpg.id};
    await post(url,{...initial,carrera_id:''},422);
    const saved=await post(url,initial);
    assert.match((await post(url,{...initial,identificacion:' 00000871 '},409)).message,/persona registrada con ese DNI/);
    const edited=await put(url+'/'+saved.id,{...initial,apellidos:'Prueba Externa Editada'});
    assert.deepEqual([edited.id,edited.nombre_completo,edited.departamento_id],[saved.id,'Mg. Luis Prueba Externa Editada',basic.id]);
    const filtered=async (id) => (await get(url+'?q=Prueba%20Externa&departamento_id='+basic.id+'&periodo_id='+id)).items;
    assert.deepEqual((await filtered(externalPeriod.id)).map((d) => [d.id,d.carrera_id]),[[saved.id,cpg.id]]);
    assert.deepEqual((await filtered(nextPeriod.id)).map((d) => [d.id,d.carrera_id]),[[saved.id,null]]);
    await put(url+'/'+saved.id,{...initial,apellidos:edited.apellidos,periodo_id:nextPeriod.id,carrera_id:eiib.id});
    assert.deepEqual((await filtered(nextPeriod.id)).map((d) => [d.id,d.carrera_id]),[[saved.id,eiib.id]]);
    assert.deepEqual((await filtered(externalPeriod.id)).map((d) => [d.id,d.carrera_id]),[[saved.id,cpg.id]]);
    const withoutDni=await post(url,{...initial,nombres:'Ana',apellidos:'Sin Documento',identificacion:''});
    assert.equal(withoutDni.identificacion,null);
    const [profiles]=await db.query('SELECT id,periodo_id,tipo,jornada_semanal FROM public.docente_periodo WHERE docente_id=$1 ORDER BY periodo_id',{bind:[saved.id]});
    assert.deepEqual(profiles.map((p) => [p.tipo,p.jornada_semanal]),[['EXTERNO',null],['EXTERNO',null]]);
    assert.ok(!(await list('docentes')).items.some((d) => d.id===saved.id));
    await put(term+'/personal/'+saved.id,{...initial,tipo:'NOMBRADO',jornada:32,situacion:'DOCENCIA',carrera_referencia_id:eiib.id},404);
    for (const seccion of ['A','B']) await cat('grupos',{periodo_id:externalPeriod.id,plan_id:planC.id,ciclo:3,seccion});
    for (const [career,plan,code] of [[cpg,planC,'CPG-EXT'],[eiib,planE,'EIIB-EXT']]) {
      await post('/catalogos/asignaturas/ficha',{periodo_id:externalPeriod.id,carrera_id:career.id,plan:plan.codigo,codigo:code,
        nombre:'Curso para vincular '+code,ciclo:3,teoria:1,practica:1,laboratorio:0,ofertada:true});
    }
    const before=await get(term+'/carga');
    const valid=before.ofertas.find((o) => o.codigo==='CPG-EXT' && o.seccion==='B');
    const otherGroup=before.ofertas.find((o) => o.codigo==='CPG-EXT' && o.seccion==='A');
    const invalid=before.ofertas.find((o) => o.codigo==='EIIB-EXT');
    const choice={docente_periodo_id:profiles[0].id,oferta_ids:[valid.id]};
    const externalPath=term+'/horario/clases-externas';
    assert.match((await post(externalPath,{...choice,oferta_ids:[invalid.id]},422)).message,/deben pertenecer a la carrera/);
    await post(term+'/carga',{...choice,modalidad:'REGULAR'},422);
    await put(url+'/'+saved.id,{...initial,apellidos:'Cambio que no se guarda',oferta_id:invalid.id},422);
    assert.equal((await filtered(externalPeriod.id))[0].apellidos,edited.apellidos);
    const details={...initial,apellidos:edited.apellidos};
    await put(url+'/'+saved.id,{...details,oferta_id:otherGroup.id});
    const [firstLink]=(await filtered(externalPeriod.id))[0].clases;
    await put(url+'/'+saved.id,{...details,asignacion_id:firstLink.asignacion_id,oferta_id:valid.id});
    const [linked]=(await filtered(externalPeriod.id))[0].clases;
    assert.equal(linked.asignacion_id,firstLink.asignacion_id);
    assert.deepEqual([linked.oferta_id,linked.grupo_id,linked.codigo],[valid.id,valid.grupo_id,'CPG-EXT']);
    const assignment={id:linked.asignacion_id};
    const another={...initial,nombres:'Rosa',apellidos:'Prueba Grupo A',identificacion:'00000901'};
    await post(url,{...another,oferta_id:valid.id},409);
    const registered=await post(url,{...another,oferta_id:otherGroup.id});
    const reloaded=(await get(url+'?periodo_id='+externalPeriod.id)).items.find((person) => person.id===registered.id);
    assert.deepEqual(reloaded.clases.map((a) => [a.oferta_id,a.grupo_id]),[[otherGroup.id,otherGroup.grupo_id]]);
    const nextChoice={...choice,docente_periodo_id:profiles[1].id};
    await post(externalPath,nextChoice,422);
    await put(url+'/'+saved.id,{...initial,apellidos:edited.apellidos,carrera_id:eiib.id},409);
    const proposal=await post(term+'/propuesta',{alcance:'CPG'},200);
    const sessions=proposal.sesiones.filter((s) => s.asignacion_id===assignment.id);
    assert.ok(sessions.length);
    assert.ok(sessions.every((s) => s.docente_id===saved.id && s.grupos.includes(valid.grupo_id)));
    assert.equal(sessions.reduce((hours,s) => hours+s.fin-s.inicio,0),2);
    await post(term+'/aplicar-propuesta',proposal,200);
    const schedule=await get(term+'/horario');
    assert.ok(schedule.sesiones.some((s) => s.asignacion_id===assignment.id && s.docente_id===saved.id));
    assert.ok(schedule.sesiones.some((s) => s.docente_id===registered.id && s.grupos.includes(otherGroup.grupo_id)));
    const after=await get(term+'/carga');
    assert.deepEqual(after.docentes,before.docentes);
    assert.deepEqual(after.asignaciones,before.asignaciones);
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(await exportLoad(externalPeriod.id));
    for (const [index,sheet] of book.worksheets.entries()) {
      sheet.eachRow((row) => assert.notEqual(row.getCell([4,6,5][index]).value,edited.nombre_completo));
    }
  });
  await run('el vínculo externo de Estadística General entra en ambos alcances de Educación Inicial',async () => {
    const term=(await get('/periodos')).find((p) => p.anio===2026 && p.semestre===2);
    const url='/periodos/'+term.id;
    const subject=await post('/catalogos/asignaturas/ficha',{periodo_id:term.id,carrera_id:eiib.id,plan:planE.codigo,
      codigo:'AGG10',nombre:'Estadística General',ciclo:3,teoria:2,practica:2,laboratorio:0,ofertada:true});
    const offer=(await get(url+'/carga')).ofertas.find((o) => o.asignatura_id===subject.id);
    assert.deepEqual([offer.carrera,offer.ciclo,offer.seccion,offer.horas],['EIIB',3,'UNICO',4]);
    const basic=(await list('departamentos')).items.find((d) => d.nombre==='Ciencias Básicas');
    const teacher=await post('/catalogos/docentes-externos',{nombres:'Franklin',apellidos:'Cuchillo Valverde',
      periodo_id:term.id,carrera_id:eiib.id,departamento_id:basic.id,oferta_id:offer.id});
    const schedule=await get(url+'/horario');
    const id=schedule.ofertas.find((item) => item.id===offer.id).asignacion_id;
    for (const scope of ['TODAS','EIIB']) {
      const proposal=await post(url+'/propuesta',{alcance:scope},200);
      const sessions=proposal.sesiones.filter((s) => s.asignacion_id===id);
      assert.equal(sessions.reduce((hours,s) => hours+s.fin-s.inicio,0),4);
      assert.ok(sessions.every((s) => s.docente_id===teacher.id && s.grupos.includes(offer.grupo_id) && s.ambiente_id));
      for (const session of sessions) {
        assert.ok(!proposal.sesiones.some((other) => other!==session && other.dia===session.dia && other.inicio<session.fin && session.inicio<other.fin &&
          (other.docentes.includes(teacher.id) || other.grupos.some((group) => session.grupos.includes(group)) || other.ambiente_id===session.ambiente_id)));
      }
    }
    const politics=await post(url+'/propuesta',{alcance:'CPG'},200);
    assert.ok(!politics.avance.some((a) => a.id===id));
    assert.ok(!(await get(url+'/carga')).asignaciones.some((a) => a.id===id));
  });
  await run('El cuadro y Excel 2026-II emiten una fila por fusión',async () => {
    const term=(await get('/periodos')).find((p) => p.anio===2026 && p.semestre===2);
    const url='/periodos/'+term.id;
    const teacher=await post(url+'/personal',{nombres:'Mg. Docente',apellidos:'De prueba',tipo:'CONTRATADO',jornada:32,
      categoria:'DCB1',codigo_personal:'C 32 Hrs',situacion:'DOCENCIA',carrera_referencia_id:eiib.id,carrera_reporte_id:eiib.id});
    const courses=[['AEI42','Planificación curricular para el nivel inicial',10],['EI501','Teoría del Diseño Curricular II',5],
      ['EI804','Actividades',8],['AEI53','Fundamentación y diseño de materiales curriculares',5],
      ['AEI43','Didáctica y estrategias de enseñanza',4],['EI302','Didáctica de la Estimulación I',3]];
    for (const [codigo,nombre,ciclo] of courses) {
      await post('/catalogos/asignaturas/ficha',{periodo_id:term.id,carrera_id:eiib.id,plan:planE.codigo,codigo,nombre,ciclo,
        creditos:4,teoria:2,practica:4,laboratorio:0,ofertada:true});
    }
    const load=await get(url+'/carga');
    const byCode=(codigo) => load.ofertas.find((o) => o.codigo===codigo);
    const [aei,ei,directed,regular,principal,reference]=courses.map(([code]) => byCode(code));
    const fusion=await post(url+'/fusiones',{asignatura_ids:[aei.asignatura_id,ei.asignatura_id],
      resolucion_id:resolution.id,horas_compartidas:6});
    const assignment={docente_periodo_id:teacher.ficha.id};
    await post(url+'/carga',{...assignment,oferta_ids:[regular.id],modalidad:'REGULAR'});
    await post(url+'/carga',{...assignment,oferta_ids:[aei.id,ei.id],modalidad:'FUSION',fusion_id:fusion.id});
    await post(url+'/carga',{...assignment,oferta_ids:[directed.id],modalidad:'DIRIGIDO',horas_asignadas:2});
    const fusionTeacher=await post(url+'/personal',{nombres:'Mg. Prueba',apellidos:'Fusión',tipo:'CONTRATADO',jornada:32,
      situacion:'DOCENCIA',carrera_referencia_id:eiib.id,carrera_reporte_id:eiib.id});
    const fourHours=await post(url+'/fusiones',{asignatura_ids:[principal.asignatura_id,reference.asignatura_id],
      resolucion_id:resolution.id,horas_compartidas:4});
    await post(url+'/carga',{docente_periodo_id:fusionTeacher.ficha.id,oferta_ids:[principal.id,reference.id],
      modalidad:'FUSION',fusion_id:fourHours.id});
    const preview=await get(url+'/reportes/carga');
    const previewTeacher=preview.hojas.find((sheet) => sheet.nombre==='Educación Inicial').docentes.find((d) => d.id===fusionTeacher.ficha.id);
    assert.deepEqual(previewTeacher.filas.map((r) => [r.codigo,r.grupo,r.horas]),[['AEI43','III\nFUSION\nEI302',4]]);
    assert.equal(previewTeacher.total,4);
    const config={universidad:'Universidad Nacional Micaela Bastidas de Apurímac',facultad:'Educación y Ciencias Sociales',departamento:'Educación y Ciencia Política'};
    await put('/configuracion',config);
    const bytes=await exportLoad(term.id);
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    const [ordinary,initial,politics]=book.worksheets;
    assert.deepEqual(ordinary.model.merges.filter((m) => /^A[1-4]:/.test(m)),['A1:O1','A2:O2','A3:O3','A4:O4']);
    assert.deepEqual(initial.model.merges.filter((m) => /^B[1-4]:/.test(m)),['B1:P1','B2:P2','B3:P3','B4:P4']);
    assert.deepEqual(politics.model.merges,['A1:P1','A2:P2']);
    assert.equal(ordinary.getCell('A1').value,ordinary.getCell('A2').value);
    assert.equal(ordinary.getCell('A3').value,'CARGA ACADÉMICA SEMESTRE ACADÉMICO 2026-II');
    assert.match(ordinary.getCell('A4').value,/^DOCENTES ORDINARIOS/);
    const initialTitles=[1,2,3,4].map((row) => initial.getCell('B'+row));
    assert.deepEqual(initialTitles.map((cell) => cell.value),[
      'UNIVERSIDAD NACIONAL MICAELA BASTIDAS DE APURÍMAC',
      'FACULTAD DE EDUCACIÓN Y CIENCIAS SOCIALES - DEPARTAMENTO DE EDUCACIÓN Y CIENCIA POLÍTICA',
      'PROPUESTA DE LA CARGA ACADEMICA DE DOCENTES DE LA ESCUELA PROFESIONAL DE EDUCACION INICIAL INTERCULTURAL BILINGÜE PRIMERA Y SEGUNDA INFANCIA',
      'SEMESTRE ACADÉMICO 2026-II',
    ]);
    assert.ok(initialTitles.every((cell) => cell.alignment.horizontal==='center'));
    assert.match(politics.getCell('A3').value,/CIENCIA POLITICA Y GOBERNABILIDAD/);
    assert.equal(politics.getCell('A4').value,'CARGA ACADÉMICA SEMESTRE 2026-II');
    assert.equal(politics.getCell('P4').alignment.horizontal,'centerContinuous');
    assert.deepEqual([6,7,8,9].map((n) => ['G','H','I','N'].map((c) => initial.getCell(c+n).value)),[
      [regular.codigo,'V',regular.nombre,6],[aei.codigo,'V\nFUSION\nEI501',aei.nombre,6],
      [directed.codigo,'DIRIGIDO',directed.nombre,2],[principal.codigo,'III\nFUSION\nEI302',principal.nombre,4],
    ]);
    assert.equal(initial.rowCount,9);
    const { wrapText,horizontal }=initial.getCell('H9').alignment;
    assert.deepEqual([wrapText,horizontal],[true,'center']);
    assert.ok(initial.getRow(9).height>=54);
    assert.deepEqual(initial.getCell('O6').value,{formula:'SUM(N6,N7,N8)',result:14});
    assert.deepEqual(initial.getCell('O9').value,{formula:'SUM(N9)',result:4});
    const dir=await mkdtemp(join(tmpdir(),'carga-excel-original-'));
    const sample=join(dir,'carga-academica-prueba-2026-II.xlsx');
    await writeFile(sample,bytes);
    console.log('Excel de prueba 2026-II:',sample);
  });
  await run('período cerrado e histórico preservado al editar el catálogo',async () => {
    await post(base+'/cerrar',{},200);
    const before=await get(base+'/reportes/carga');
    await put('/configuracion',{ universidad:'Universidad de prueba', facultad:'Facultad de prueba', departamento:'Departamento de prueba' });
    const edited=await get('/catalogos/docentes/'+teacher.docente_id);
    await put('/catalogos/docentes/'+edited.id,{...edited,nombres:'Nombre actualizado'});
    assert.deepEqual(await get(base+'/reportes/carga'),before);
    await remove(base+'/horario/'+schedule.sesiones[0].id,{},409);
  });
  await run('eliminación definitiva de EI501 confirma el impacto y limpia las referencias',async () => {
    const term=(await get('/periodos')).find((p) => p.anio===2026 && p.semestre===2);
    const url='/periodos/'+term.id;
    const before=await get(url+'/carga');
    const target=before.ofertas.find((offer) => offer.codigo==='EI501');
    const partner=before.ofertas.find((offer) => offer.codigo==='AEI42');
    const fusionAssignment=before.asignaciones.find((a) => a.id===target.asignacion_id);
    const historical=await post('/periodos',{nombre:'2048-II',copiar_desde:term.id});
    const pastUrl='/periodos/'+historical.id;
    const previous=await get(pastUrl+'/carga');
    const pastOffer=previous.ofertas.find((offer) => offer.asignatura_id===target.asignatura_id);
    const pastTeacher=await post(pastUrl+'/personal',{nombre_completo:'Docente de semestre cerrado',tipo:'NOMBRADO',jornada:32,
      situacion:'DOCENCIA',carrera_referencia_id:eiib.id});
    const pastAssignment=await post(pastUrl+'/carga',{docente_periodo_id:pastTeacher.ficha.id,oferta_ids:[pastOffer.id],modalidad:'REGULAR'});
    const block={tipo:'CLASE',ambiente_id:room.id,dia:1,inicio:14,fin:16};
    await post(pastUrl+'/horario',{...block,asignacion_id:pastAssignment.id});
    const closed={carga:await get(pastUrl+'/carga'),horario:await get(pastUrl+'/horario'),institucion:await get('/configuracion')};
    closed.carga.periodo.estado='CERRADO';
    closed.horario.periodo.estado='CERRADO';
    await db.query("UPDATE public.periodo_academico SET estado='FINALIZADO',encabezado=$2 WHERE id=$1",{bind:[historical.id,JSON.stringify(closed)]});
    const path='/catalogos/asignaturas/'+target.asignatura_id;
    const impactPath=path+'/impacto-eliminacion';
    const preview=await get(impactPath);
    assert.equal(preview.asignatura.codigo,'EI501');
    assert.deepEqual(preview.periodos.map((p) => p.id),[term.id,historical.id]);
    assert.deepEqual(preview.fusiones.map((f) => f.id),[fusionAssignment.fusion_id]);
    assert.deepEqual(preview.ofertasLiberadas.map((o) => o.codigo),['AEI42']);
    assert.equal((await get(path)).id,target.asignatura_id);
    assert.deepEqual(await get(url+'/carga'),before);
    const added=await post(url+'/horario',{...block,asignacion_id:fusionAssignment.id});
    await remove(path,{revision:preview.revision},409);
    assert.equal((await get(path)).id,target.asignatura_id);
    const confirmed=await get(impactPath);
    assert.equal(confirmed.bloques.length,2);
    await remove(path,{revision:confirmed.revision});
    const [[removed]]=await db.query(`SELECT EXISTS (SELECT 1 FROM public.asignatura WHERE id=$1) materia,
      EXISTS(SELECT 1 FROM public.fusion WHERE id=$2) fusion,
      EXISTS(SELECT 1 FROM public.ocupacion_docente WHERE sesion_id=$3) ocupacion_docente,
      EXISTS(SELECT 1 FROM public.ocupacion_grupo WHERE sesion_id=$3) ocupacion_grupo`,
    {bind:[target.asignatura_id,fusionAssignment.fusion_id,added.id]});
    assert.deepEqual(Object.values(removed),[false,false,false,false]);
    for (const period of [term,historical]) {
      const periodUrl='/periodos/'+period.id;
      const load=await get(periodUrl+'/carga');
      assert.ok(!load.ofertas.some((o) => o.asignatura_id===target.asignatura_id));
      assert.ok(!load.pendientes.some((issue) => issue.asignatura_id===target.asignatura_id));
      const timetable=await get(periodUrl+'/horario');
      assert.ok(!timetable.sesiones.some((s) => confirmed.bloques.some((b) => b.id===s.id)));
      const excel=new ExcelJS.Workbook();
      await excel.xlsx.load(await exportLoad(period.id));
      for(const sheet of excel.worksheets) sheet.eachRow((row) => row.eachCell((cell) => assert.ok(!cell.text.includes('EI501'))));
    }
    const remaining=await get(url+'/carga');
    assert.equal(remaining.ofertas.find((o) => o.id===partner.id).asignacion_id,null);
    assert.equal(remaining.docentes.find((d) => d.id===fusionAssignment.docente_periodo_id).horas_asignadas,8);
    assert.equal((await get('/catalogos/asignaturas/'+partner.asignatura_id)).id,partner.asignatura_id);
  });
});
