import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { Pool,PoolConnection,ResultSetHeader,RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import publicLocalRouter from "../../publicLocal/publicLocal.routes";
import { evolutionClient } from "../../notifications/infrastructure/evolution.client";
import { operarContactosRecurrencia } from "./recurrencia.contactos";
import { contextoRecurrenciaPet,sumarDiasCalendarioPet } from "./recurrencia.time";
import { relojMysqlRecordatorioPet,type RelojRecordatorioPet } from "./recordatorios.service";
import { reclamarRecurrenciaPet,procesarRecurrenciaPet } from "./recurrencia.processing";
import { createPetRecurrenceTransport } from "./recurrencia.transport";
import { createPetRecurrenceDependencies,runPetRecurrenceCycle,startPetRecurrenceScheduler,
  type PetRecurrenceEnvironment } from "./recurrencia.scheduler";

const testInstant="2026-11-19T13:05:00.000Z"; // 10:05 ART, injected ONLY inside this test module.
const frontend="https://app.agendaok.com.ar";
const phone="+5491123456789";
const tables=["locales","clientes","mascotas","mascota_clientes","mascota_servicios","servicios","turnos","pet_recordatorios","pet_recurrencia_contactos"];
interface Fixture {local:number;client:number;service:number;slug:string}
interface Event {stage:string;instant?:string}
async function rows(sql:string,values:unknown[]=[]){const [result]=await pool.query<RowDataPacket[]>(sql,values);return result;}
async function insert(sql:string,values:unknown[]=[]){const [result]=await pool.query<ResultSetHeader>(sql,values);return result.insertId;}
async function counts(){return Promise.all(tables.map(async table=>Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n)));}

test("E2E Docker: callback scheduler → MySQL → Evolution simulado → persistencia",{timeout:60000},async t=>{
  const tag=`REC30E2E_${randomUUID()}`;
  const locals:number[]=[];
  const baseline=await counts();
  const events:Event[]=[];
  const posts:{path:string;number:string;message:string;receipt:string}[]=[];
  let gets=0,callback!:()=>Promise<void>,virtualTime=new Date(testInstant),mode:"controlled"|"real"="controlled";
  let outcome:"accepted"|"ambiguous"="accepted",dispatchCommitted=false;
  let afterDispatchCommit:(()=>void)|undefined;
  let result:Awaited<ReturnType<typeof runPetRecurrenceCycle>>|null=null;
  const raw:PetRecurrenceEnvironment={flag:"true",pilotLocalIds:"",frontendUrl:frontend}; // in-memory, NOT process.env
  const cycleErrors:unknown[][]=[];
  const originalError=console.error;
  t.mock.method(console,"error",(...args:unknown[])=>{
    if(args[0]==="PET recurrence cycle failed")cycleErrors.push(args);else originalError(...args);
  });
  t.mock.method(evolutionClient,"get",(async(path:string)=>{
    assert.ok(path.startsWith("/instance/connectionState/"));gets++;events.push({stage:"simulated_connection"});
    return {data:{instance:{state:"open"}}};
  }) as typeof evolutionClient.get);
  t.mock.method(evolutionClient,"post",(async(path:string,body:unknown)=>{
    const payload=body as {number:string;textMessage:{text:string}};
    const receipt=`E2E_ACCEPTED_${path.split("/").pop()}`;
    posts.push({path,number:payload.number,message:payload.textMessage.text,receipt});events.push({stage:"simulated_post"});
    return outcome==="accepted"?{status:201,data:{key:{id:receipt}}}:{status:200,data:{}};
  }) as typeof evolutionClient.post);

  const coherentClock:RelojRecordatorioPet=async connection=>{
    const now=mode==="real"?await relojMysqlRecordatorioPet(connection):new Date(virtualTime);
    events.push({stage:dispatchCommitted?"post_commit_clock":"clock",instant:now.toISOString()});
    return now;
  };
  const db:Pick<Pool,"query"|"getConnection">={
    query:(async(sql:string,values?:unknown[])=>{
      if(sql.startsWith("UPDATE pet_recordatorios SET estado=?"))events.push({stage:`persist_${values?.[0]}`});
      return pool.query(sql,values);
    }) as Pool["query"],
    getConnection:async()=>{
      const connection=await pool.getConnection();let dispatch=false;
      return new Proxy(connection,{get(target,prop){
        if(prop==="query")return (async(sql:string,values?:unknown[])=>{
          if(sql.includes("FROM pet_recurrencia_contactos"))events.push({stage:"authorization_read"});
          if(sql.includes("SET estado='sending'"))events.push({stage:"claimed_sending"});
          if(sql.startsWith("UPDATE pet_recordatorios SET estado=?") && values?.[0]==="dispatching"){
            dispatch=true;events.push({stage:"authorize_dispatching"});
          }
          return target.query(sql,values);
        }) as PoolConnection["query"];
        if(prop==="beginTransaction")return async()=>{dispatchCommitted=false;return target.beginTransaction();};
        if(prop==="commit")return async()=>{
          await target.commit();
          if(dispatch){dispatchCommitted=true;events.push({stage:"dispatch_commit"});afterDispatchCommit?.();}
        };
        const value:unknown=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
      }});
    },
  };
  const transport=createPetRecurrenceTransport(); // existing HTTP adapter, methods mocked above
  const actual=createPetRecurrenceDependencies(transport,db,coherentClock);
  const deps={...actual,
    page:async(local:number,cursor:number|null)=>{events.push({stage:"selection"});return actual.page(local,cursor);},
    claim:async(local:number,turno:number,url:string)=>{events.push({stage:"claim"});return actual.claim(local,turno,url);},
    process:async(...args:Parameters<typeof actual.process>)=>{events.push({stage:"process"});return actual.process(...args);},
  };
  const app=express();app.use("/api/public/local",publicLocalRouter);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address && typeof address!=="string");
  const localApi=`http://127.0.0.1:${address.port}`;

  async function fixture(permission:"authorized"|"none"|"baja"="authorized"):Promise<Fixture>{
    const slug=`${tag.toLowerCase()}-${locals.length}`;
    const local=await insert(`INSERT INTO locales (nombre,slug,business_type,activo,suscripcion_estado,suscripcion_vencimiento)
      VALUES (?,?,'PET_GROOMING',1,'activo','2099-12-31')`,[tag,slug]);locals.push(local);
    const client=await insert("INSERT INTO clientes (local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)",[local,tag,phone,phone]);
    const service=await insert("INSERT INTO servicios (local_id,nombre,activo,duracion,precio) VALUES (?,?,1,NULL,NULL)",[local,tag]);
    if(permission!=="none")await operarContactosRecurrencia({localId:local,aplicar:true,operaciones:[{
      tipo:"autorizacion",clienteId:client,telefonoCanonical:phone,verificadaAt:new Date(virtualTime.getTime()-86400000).toISOString(),referenciaVerificacion:tag,
    }]},db,coherentClock);
    if(permission==="baja")await operarContactosRecurrencia({localId:local,aplicar:true,
      operaciones:[{tipo:"baja",telefonoCanonical:phone,referenciaBaja:tag}]},db,coherentClock);
    return {local,client,service,slug};
  }
  async function pet(f:Fixture,age=30,name="Luna"){
    const today=contextoRecurrenciaPet(virtualTime).hoyArgentina;
    const mascota=await insert("INSERT INTO mascotas (local_id,nombre,activo,reserva_online_habilitada) VALUES (?,?,1,1)",[f.local,name]);
    await pool.query("INSERT INTO mascota_clientes (local_id,mascota_id,cliente_id) VALUES (?,?,?)",[f.local,mascota,f.client]);
    await pool.query("INSERT INTO mascota_servicios (local_id,mascota_id,servicio_id,duracion_minutos) VALUES (?,?,?,30)",[f.local,mascota,f.service]);
    const turno=await insert(`INSERT INTO turnos (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,
      estado,servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
      VALUES (?,?,?,?,?,?,'10:00','10:30','completado',?,?,30,0)`,
    [f.local,mascota,f.client,tag,phone,sumarDiasCalendarioPet(today,-age),f.service,tag]);
    return {mascota,turno};
  }
  async function ledger(f:Fixture){return rows("SELECT * FROM pet_recordatorios WHERE local_id=? ORDER BY id",[f.local]);}
  async function tick(f:Fixture,options:{ambiguous?:boolean;parallel?:boolean;afterCommit?:()=>void;real?:boolean}={}){
    raw.pilotLocalIds=String(f.local);outcome=options.ambiguous?"ambiguous":"accepted";
    mode=options.real?"real":"controlled";afterDispatchCommit=options.afterCommit;
    result=null;dispatchCommitted=false;events.length=0;posts.length=0;gets=0;
    const errors=cycleErrors.length;
    if(options.parallel)await Promise.all([callback(),callback()]);else await callback();
    assert.equal(cycleErrors.length,errors,"scheduler must not conceal a failed cycle");
    return result as Awaited<ReturnType<typeof runPetRecurrenceCycle>>|null;
  }
  try{
    // Single registration with fake cron. This is a manual callback, never a live timer.
    let registrations=0;
    const bootstrap=await fixture("none");raw.pilotLocalIds=String(bootstrap.local);
    assert.equal(startPetRecurrenceScheduler(()=>raw,(expression,cb,options)=>{
      registrations++;assert.equal(expression,"*/5 10-11 * * *");
      assert.equal(options.timezone,"America/Argentina/Buenos_Aires");callback=cb;return {stop(){}};
    },async()=>{events.push({stage:"cycle"});result=await runPetRecurrenceCycle(()=>raw,deps);},async()=>{
      events.push({stage:"scheduler_clock"});const connection=await db.getConnection();
      try{return await coherentClock(connection);}finally{connection.release();}
    }),true);
    assert.equal(registrations,1);assert.equal(posts.length,0,"registration must not execute");

    await t.test("D30: texto exacto, URL pública resoluble y receipt persistido con reloj coherente",async()=>{
      const f=await fixture();const due=await pet(f);
      assert.equal((await tick(f))?.claimed,1);assert.equal(gets,1);assert.equal(posts.length,1);
      const expected=`¡Buen día! ☀️🐾 Te escribimos porque ya pasó cerca de un mes desde la última visita de Luna. En esta etapa suele ser ideal realizar el mantenimiento para conservar el manto sano, cómodo y evitar nudos o servicios más largos e incómodos para ellos.\n\nPodés reservar su próximo turno directamente desde nuestra agenda online 📅👇\n${frontend}/${f.slug}\n\nSi necesitás ingresar, elegí “Ya soy cliente” y usá tu celular habitual.\n\nSi preferís no recibir estos recordatorios, avisame por acá.`;
      assert.equal(posts[0].message,expected);assert.equal(posts[0].number,phone.slice(1));
      assert.equal(posts[0].path,`/message/sendText/${f.local}`);
      const url=new URL(posts[0].message.match(/https:\/\/\S+/)![0]);
      assert.equal(url.origin,frontend);assert.equal(url.pathname,`/${f.slug}`);assert.equal(url.search,"");assert.equal(url.hash,"");
      const response=await fetch(`${localApi}/api/public/local${url.pathname}`);
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{nombre:tag,businessType:"PET_GROOMING"});
      const [record]=await ledger(f);assert.equal(record.estado,"sent");assert.equal(record.tipo,"RECURRENCE_DAY_30");
      assert.equal(record.mascota_id,due.mascota);assert.equal(record.ultimo_turno_completado_id,due.turno);
      assert.equal(record.cliente_id,f.client);assert.equal(record.provider_message_id,posts[0].receipt);assert.ok(record.accepted_at);
      for(const stage of ["scheduler_clock","cycle","selection","authorization_read","claimed_sending","process","authorize_dispatching","dispatch_commit","simulated_post","persist_sent"]){
        assert.ok(events.some(event=>event.stage===stage),`missing E2E stage ${stage}`);
      }
      const commit=events.findIndex(event=>event.stage==="dispatch_commit"),post=events.findIndex(event=>event.stage==="simulated_post");
      assert.ok(commit>=0 && post>commit);
      assert.ok(events.slice(commit+1,post).some(event=>event.stage==="post_commit_clock" && event.instant===testInstant));
      assert.ok(events.filter(event=>event.instant).every(event=>event.instant===testInstant),"one logical clock in every layer");
    });

    await t.test("D29/D31/D60 no se seleccionan ni generan claims",async()=>{
      const f=await fixture();for(const age of [29,31,60])await pet(f,age);
      assert.equal((await tick(f))?.claimed,0);assert.equal(gets,0);assert.equal(posts.length,0);assert.equal((await ledger(f)).length,0);
    });
    await t.test("próxima reserva posterior a D35 excluye el recordatorio",async()=>{
      const f=await fixture(),due=await pet(f);
      await insert(`INSERT INTO turnos (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,
        estado,servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
        VALUES (?,?,?,?,?,?,'10:00','10:30','activo',?,?,30,0)`,
      [f.local,due.mascota,f.client,tag,phone,sumarDiasCalendarioPet(contextoRecurrenciaPet(virtualTime).hoyArgentina,10),f.service,tag]);
      assert.equal((await tick(f))?.claimed,0);assert.equal(posts.length,0);assert.equal((await ledger(f)).length,0);
    });
    for(const permission of ["baja","none"] as const){
      await t.test(`${permission}: relación comercial no reemplaza permiso, cero transporte`,async()=>{
        const f=await fixture(permission);await pet(f);
        assert.equal((await tick(f))?.claimed,0);assert.equal(gets,0);assert.equal(posts.length,0);assert.equal((await ledger(f)).length,0);
      });
    }
    await t.test("callbacks duplicados, segundo tick y reclamo repetido: una sola entrega simulada",async()=>{
      const f=await fixture(),due=await pet(f);
      assert.equal((await tick(f,{parallel:true}))?.claimed,1);assert.equal(posts.length,1);
      const initial=await ledger(f);assert.equal(initial.length,1);
      assert.equal((await tick(f))?.claimed,0);assert.equal(posts.length,0);
      assert.equal(await reclamarRecurrenciaPet(f.local,due.turno,frontend,db,coherentClock),null);
      assert.deepEqual(await ledger(f),initial);
    });
    await t.test("proveedor ambiguo: unknown persistido, sin reenvío en la segunda ejecución",async()=>{
      const f=await fixture();await pet(f);
      assert.equal((await tick(f,{ambiguous:true}))?.claimed,1);assert.equal(posts.length,1);
      const [initial]=await ledger(f);assert.equal(initial.estado,"unknown");assert.equal(initial.accepted_at,null);assert.equal(initial.provider_message_id,null);
      assert.equal((await tick(f))?.claimed,0);assert.equal(posts.length,0);assert.deepEqual((await ledger(f))[0],initial);
    });
    await t.test("mismo reloj avanza a 12:00 después del commit: aborta antes del POST",async()=>{
      const f=await fixture();await pet(f);
      await tick(f,{afterCommit:()=>{virtualTime=new Date("2026-11-19T15:00:00.000Z");}});
      assert.equal(posts.length,0);assert.equal((await ledger(f))[0].estado,"unknown");
      assert.ok(events.some(event=>event.stage==="post_commit_clock" && event.instant==="2026-11-19T15:00:00.000Z"));
      virtualTime=new Date(testInstant);afterDispatchCommit=undefined;
    });
    await t.test("reloj real fuera de ventana: scheduler y procesador rechazan despacho",async context=>{
      const connection=await pool.getConnection();let real:Date;
      try{real=await relojMysqlRecordatorioPet(connection);}finally{connection.release();}
      const realContext=contextoRecurrenciaPet(real);
      if(realContext.enVentana){context.skip("actual ART clock is inside window; never modify system/MySQL time");return;}
      // Prime a valid owned claim at 10:05 of the real calendar day, then use REAL defaults.
      virtualTime=new Date(`${realContext.hoyArgentina}T13:05:00.000Z`);mode="controlled";
      const f=await fixture(),due=await pet(f);
      const owner=await reclamarRecurrenciaPet(f.local,due.turno,frontend,db,coherentClock);assert.ok(owner);
      assert.equal(await tick(f,{real:true}),null,"real scheduler must stop before cycle");
      assert.equal(await procesarRecurrenciaPet(owner,{frontendUrl:frontend,provider:transport},db),"skipped");
      assert.equal(gets,0);assert.equal(posts.length,0);assert.equal((await ledger(f))[0].estado,"skipped");
      console.info("REC30 real-clock rejection verified",{hoyArgentina:realContext.hoyArgentina,horaArgentina:realContext.horaArgentina});
      mode="controlled";virtualTime=new Date(testInstant);
    });
  }finally{
    afterDispatchCommit=undefined;
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    try{
      for(const id of locals){
        assert.equal((await rows("SELECT nombre FROM locales WHERE id=?",[id]))[0]?.nombre,tag);
        for(const table of ["turnos","mascota_servicios","mascota_clientes","mascotas","clientes","servicios"]){
          await pool.query(`DELETE FROM ${table} WHERE local_id=?`,[id]);
        }
        await pool.query("DELETE FROM locales WHERE id=? AND nombre=?",[id,tag]);
      }
      for(const id of locals)for(const table of tables.filter(name=>name!=="locales")){
        assert.equal((await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id=?`,[id]))[0].n,0);
      }
      assert.deepEqual(await counts(),baseline,"E2E table counts restored");
      console.info("REC30 E2E cleanup verified",{fixtures:locals.length,residuals:0});
    }finally{await pool.end();}
  }
});
