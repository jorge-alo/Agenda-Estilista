import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { operarContactosRecurrencia } from "./recurrencia.contactos";
import { cambiarPreferenciaD30, leerPreferenciaD30 } from "./recurrencia.preferencias";
import { reclamarRecurrenciaPet, procesarRecurrenciaPet, recuperarRecurrenciaPet,
  type ReclamoRecurrenciaPet, type EvolutionRecurrenciaSimulada } from "./recurrencia.processing";

const tag = `REC30PROC_${randomUUID()}`;
const phone = "+5491123456789";
const frontendUrl = "https://example.test/base/";
const baseTime = "2026-11-19T13:00:00.000Z";
const baseClock = async () => new Date(baseTime);
const ids: number[] = [];
const tables = ["locales","clientes","mascotas","mascota_clientes","mascota_servicios","servicios","turnos","pet_recordatorios","pet_recurrencia_contactos"];
let baseline: number[];
interface Fixture {localId:number;clienteId:number;mascotaId:number;turnoId:number;serviceId:number;slug:string}
async function rows(sql:string,values:unknown[]=[]) { const [result]=await pool.query<RowDataPacket[]>(sql,values); return result; }
async function insert(sql:string,values:unknown[]) { const [result]=await pool.query<ResultSetHeader>(sql,values); return result.insertId; }
async function counts() { return Promise.all(tables.map(async table => Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n))); }
async function fixture(authorize=true,date="2026-10-20"):Promise<Fixture> {
  const slug = `${tag}-${ids.length}`;
  const localId=await insert(`INSERT INTO locales (nombre,slug,business_type,activo,suscripcion_estado,suscripcion_vencimiento)
    VALUES (?,?,'PET_GROOMING',1,'activo','2099-12-31')`,[tag,slug]);
  ids.push(localId);
  const clienteId=await insert("INSERT INTO clientes (local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)",[localId,tag,phone,phone]);
  const mascotaId=await insert("INSERT INTO mascotas (local_id,nombre,activo,reserva_online_habilitada) VALUES (?,?,1,1)",[localId,"Luna fixture"]);
  const serviceId=await insert("INSERT INTO servicios (local_id,nombre,activo,duracion,precio) VALUES (?,?,1,NULL,NULL)",[localId,tag]);
  await pool.query("INSERT INTO mascota_clientes (local_id,mascota_id,cliente_id) VALUES (?,?,?)",[localId,mascotaId,clienteId]);
  await pool.query("INSERT INTO mascota_servicios (local_id,mascota_id,servicio_id,duracion_minutos) VALUES (?,?,?,30)",[localId,mascotaId,serviceId]);
  const turnoId=await insert(`INSERT INTO turnos
    (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
     servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
    VALUES (?,?,?,?,?,?,'10:00','10:30','completado',?,?,30,0)`,[localId,mascotaId,clienteId,tag,phone,date,serviceId,tag]);
  const f={localId,clienteId,mascotaId,turnoId,serviceId,slug};
  if(authorize) await grant(f);
  return f;
}
async function grant(f:Fixture) {
  await operarContactosRecurrencia({localId:f.localId,aplicar:true,operaciones:[{tipo:"autorizacion",clienteId:f.clienteId,
    telefonoCanonical:phone,verificadaAt:"2026-11-01T12:00:00.000Z",referenciaVerificacion:tag}]},pool,baseClock);
}
async function optOut(f:Fixture) {
  await operarContactosRecurrencia({localId:f.localId,aplicar:true,
    operaciones:[{tipo:"baja",telefonoCanonical:phone,referenciaBaja:tag}]},pool,baseClock);
}
async function claim(f:Fixture, clock=baseClock) {
  const owner=await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,clock);
  assert.ok(owner); return owner;
}
async function checkbox(f: Fixture, habilitada: boolean) {
  const actual = await leerPreferenciaD30(pool, f.localId, f.clienteId);
  return cambiarPreferenciaD30(f.localId, f.clienteId, 17, { habilitada, revision: actual.revision,
    telefono: phone, operacionId: randomUUID() });
}
test('preferencia operativa: envio D30 deduplicado; baja/reactivacion no reinician un ciclo sent', async () => {
  const f = await fixture(false);
  await checkbox(f, true);
  const owner = await claim(f);
  const transport = fake();
  await process(owner, transport.provider);
  assert.equal(transport.sends.length, 1);
  await checkbox(f, false);
  await checkbox(f, true);
  assert.equal(await reclamarRecurrenciaPet(f.localId, f.turnoId, frontendUrl, pool, baseClock), null);
  assert.equal((await reminder(owner)).estado, 'sent');
});
test('baja por checkbox durante preflight impide POST y reactivacion no reinicia skipped', async () => {
  const f = await fixture(false);
  await checkbox(f, true);
  const owner = await claim(f);
  const transport = fake({ connection: async () => { await checkbox(f, false); return 'open'; } });
  await process(owner, transport.provider);
  assert.equal(transport.sends.length, 0);
  assert.equal((await reminder(owner)).estado, 'skipped');
  await checkbox(f, true);
  assert.equal(await reclamarRecurrenciaPet(f.localId, f.turnoId, frontendUrl, pool, baseClock), null);
});
async function reminder(owner:ReclamoRecurrenciaPet) {
  return (await rows("SELECT *,DATE_FORMAT(claimed_at,'%Y-%m-%d %H:%i:%s.%f') AS claim_key FROM pet_recordatorios WHERE id=? AND local_id=?",[owner.id,owner.localId]))[0];
}
function fake(options:{connection?:()=>Promise<"open"|"closed"|"unavailable">;send?:()=>Promise<unknown>}={}) {
  const sends:{number:string;message:string;instance:string}[]=[];
  const provider:EvolutionRecurrenciaSimulada={ simulated:true,
    connection:async () => options.connection ? options.connection() : "open",
    send:async (number,message,instance) => { sends.push({number,message,instance});
      return options.send ? options.send() : {status:201,data:{key:{id:"simulated-receipt"}}}; },
  };
  return {provider,sends};
}
async function process(owner:ReclamoRecurrenciaPet, provider:EvolutionRecurrenciaSimulada,clock=baseClock,db:Pick<Pool,"query"|"getConnection">=pool) {
  return procesarRecurrenciaPet(owner,{frontendUrl,provider},db,clock);
}
async function futureBooking(f:Fixture,beforeCommit?:()=>Promise<void>) {
  const tx=await pool.getConnection();
  try {
    await tx.beginTransaction();
    await tx.query("SELECT id FROM locales WHERE id=? FOR UPDATE",[f.localId]);
    const [created]=await tx.query<ResultSetHeader>(`INSERT INTO turnos
      (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
       servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
      VALUES (?,?,?,?,?,'2027-01-01','10:00','10:30','activo',?,?,30,0)`,
    [f.localId,f.mascotaId,f.clienteId,tag,phone,f.serviceId,tag]);
    if(beforeCommit)await beforeCommit();
    await tx.commit(); return created.insertId;
  } catch(error) {await tx.rollback();throw error;} finally {tx.release();}
}
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; }

async function waitForLock(session:()=>number) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {
    if(session()) {
      const [row]=await rows(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?`,[session()]);
      if(Number(row.n)>0)return;
    }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail("final authorization did not wait on the concurrent local writer");
}

before(async()=>{
  assert.equal((await rows("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_recurrencia_contactos'"))[0].n,1);
  baseline=await counts();
});
after(async()=>{
  try {
    for(const id of ids) {
      const [local]=await rows("SELECT nombre FROM locales WHERE id=?",[id]);
      if(!local) continue;
      assert.equal(local.nombre,tag);
      for(const table of ["turnos","mascota_servicios","mascota_clientes","mascotas","clientes","servicios"]) {
        await pool.query(`DELETE FROM ${table} WHERE local_id=?`,[id]);
      }
      await pool.query("DELETE FROM locales WHERE id=? AND nombre=?",[id,tag]);
    }
    for(const id of ids) for(const table of tables.filter(name=>name!=="locales")) {
      assert.equal((await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id=?`,[id]))[0].n,0);
    }
    if(baseline) assert.deepEqual(await counts(),baseline,"all fixture table counts restored");
    console.info("REC30 processor cleanup verified",{fixtures:ids.length,residuals:0});
  } finally {await pool.end();}
});

test("reclamo concurrente de dos workers: una identidad y un solo ganador",async()=>{
  const f=await fixture();
  const owners=await Promise.all([reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),
    reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock)]);
  assert.equal(owners.filter(Boolean).length,1);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id=?",[f.localId]))[0].n,1);
});

test("dos workers procesan el mismo claim: un único POST simulado y transición atómica",{timeout:15000},async()=>{
  const f=await fixture(),owner=await claim(f);
  let preflights=0;
  const barrier=deferred();
  const transport=fake({connection:async()=>{if(++preflights===2)barrier.resolve();await barrier.promise;return "open";},
    send:async()=>{assert.equal((await reminder(owner)).estado,"dispatching");return {status:200,data:{key:{id:"two-workers"}}};}});
  const result=await Promise.all([process(owner,transport.provider),process(owner,transport.provider)]);
  assert.deepEqual(result.sort(),["not_owned","sent"]);
  assert.equal(transport.sends.length,1);
  assert.equal((await reminder(owner)).estado,"sent");
  assert.equal(transport.sends[0].instance,String(f.localId));
  assert.equal(transport.sends[0].number,phone.slice(1));
  assert.ok(transport.sends[0].message.includes(`https://example.test/base/${encodeURIComponent(f.slug)}`));
  assert.ok(transport.sends[0].message.includes("nuestra agenda online"));
  assert.equal(await process(owner,transport.provider),"not_owned");
  assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
});

test("sin autorización o con baja no se crea un claim",async()=>{
  const f=await fixture(false);
  assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
  await optOut(f);
  assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id=?",[f.localId]))[0].n,0);
});

for(const [label,change] of [
  ["baja",async(f:Fixture)=>optOut(f)],
  ["teléfono cambiado",async(f:Fixture)=>{await pool.query("UPDATE clientes SET telefono=?,telefono_normalizado=? WHERE id=? AND local_id=?",["+5491112345678","+5491112345678",f.clienteId,f.localId]);}],
  ["vínculo eliminado",async(f:Fixture)=>{await pool.query("DELETE FROM mascota_clientes WHERE local_id=? AND mascota_id=? AND cliente_id=?",[f.localId,f.mascotaId,f.clienteId]);}],
  ["servicio inactivo",async(f:Fixture)=>{await pool.query("UPDATE servicios SET activo=0 WHERE id=? AND local_id=?",[f.serviceId,f.localId]);}],
  ["mascota sin online",async(f:Fixture)=>{await pool.query("UPDATE mascotas SET reserva_online_habilitada=0 WHERE id=? AND local_id=?",[f.mascotaId,f.localId]);}],
] as const) {
  test(`revalidación final: ${label} durante preflight impide despacho`,async()=>{
    const f=await fixture(),owner=await claim(f);
    const transport=fake({connection:async()=>{await change(f);return "open";}});
    assert.equal(await process(owner,transport.provider),"skipped");
    assert.equal(transport.sends.length,0);
  });
}

test("reserva nueva durante preflight difiere; cancelación permite reclamar el mismo ciclo sin duplicarlo",async()=>{
  const f=await fixture(),owner=await claim(f);
  let booking=0;
  const transport=fake({connection:async()=>{booking=await futureBooking(f);return "open";}});
  assert.equal(await process(owner,transport.provider),"pending");
  assert.equal(transport.sends.length,0);
  assert.equal((await reminder(owner)).claimed_at,null);
  assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
  await pool.query("UPDATE turnos SET estado='cancelado' WHERE local_id=? AND id=?",[f.localId,booking]);
  const retry=await claim(f,async()=>new Date("2026-11-19T13:00:01.000Z"));
  assert.equal(retry.id,owner.id);
  const ok=fake(); assert.equal(await process(retry,ok.provider),"sent"); assert.equal(ok.sends.length,1);
});

for(const change of ["baja","reserva"] as const) {
  test(`carrera InnoDB: autorización final espera ${change} y lee su commit, sin POST`,{timeout:15000},async()=>{
    const f=await fixture(),owner=await claim(f);
    const entered=deferred(),release=deferred();
    let session=0;
    let writer:Promise<unknown>|undefined;
    const readerDb={query:pool.query.bind(pool) as Pool["query"],getConnection:async()=>{
      const tx=await pool.getConnection();
      const [[row]]=await tx.query<(RowDataPacket&{id:number})[]>("SELECT CONNECTION_ID() AS id");
      session=row.id;return tx;
    }};
    const writerDb={getConnection:async()=>{
      const tx=await pool.getConnection();
      return new Proxy(tx,{get(target,prop){
        if(prop==="commit")return async()=>{entered.resolve();await release.promise;return target.commit();};
        const value:unknown=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
      }});
    }};
    const transport=fake({connection:async()=>{
      writer=change==="baja" ? operarContactosRecurrencia({localId:f.localId,aplicar:true,
        operaciones:[{tipo:"baja",telefonoCanonical:phone,referenciaBaja:tag}]},writerDb,baseClock)
        : futureBooking(f,async()=>{entered.resolve();await release.promise;});
      void writer.catch(()=>undefined);
      await Promise.race([entered.promise,writer.then(()=>assert.fail("writer missed commit barrier"))]);
      return "open";
    }});
    const processing=process(owner,transport.provider,baseClock,readerDb);
    void processing.catch(()=>undefined);
    try {
      await Promise.race([entered.promise,processing.then(()=>assert.fail("processor completed before writer"))]);
      await waitForLock(()=>session);
      assert.equal((await reminder(owner)).estado,"sending");
    } finally {release.resolve();await Promise.allSettled([writer??Promise.resolve(),processing]);}
    await writer;
    assert.equal(await processing,change==="baja"?"skipped":"pending");
    assert.equal(transport.sends.length,0);
  });
}

test("nuevo completado invalida el ciclo anterior durante el preflight",async()=>{
  const f=await fixture(),owner=await claim(f);
  const transport=fake({connection:async()=>{
    const id=await futureBooking(f);
    await pool.query("UPDATE turnos SET fecha='2026-11-01',estado='completado' WHERE id=? AND local_id=?",[id,f.localId]);
    return "open";
  }});
  assert.equal(await process(owner,transport.provider),"skipped"); assert.equal(transport.sends.length,0);
});

for(const state of ["closed","unavailable","throw"] as const) {
  test(`Evolution ${state} antes del POST: pending seguro y recuperación posterior`,async()=>{
    const f=await fixture(),owner=await claim(f);
    const transport=fake({connection:async()=>{if(state==="throw")throw new Error("simulated");return state;}});
    assert.equal(await process(owner,transport.provider),"pending");
    assert.equal(transport.sends.length,0);
    const retry=await claim(f,async()=>new Date("2026-11-19T13:00:01.000Z"));
    const ok=fake(); assert.equal(await process(retry,ok.provider),"sent");
  });
}

for(const response of [null,{status:200,data:{}},{status:500,data:{key:{id:"maybe-accepted"}}},"throw"]) {
  test(`respuesta ambigua/error de Evolution ${JSON.stringify(response)}: unknown sin reenvío`,async()=>{
    const f=await fixture(),owner=await claim(f);
    const transport=fake({send:async()=>{if(response==="throw")throw new Error("timeout-simulated");return response;}});
    assert.equal(await process(owner,transport.provider),"unknown");
    assert.equal((await reminder(owner)).estado,"unknown");
    assert.equal(await process(owner,transport.provider),"not_owned");
    assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
    assert.equal(transport.sends.length,1);
  });
}

test("ventana exacta y día exacto revalidados tras preflight; nunca D31/40/60",async()=>{
  for(const advanced of ["2026-11-19T15:00:00.000Z","2026-11-20T13:00:00.000Z"]) {
    const f=await fixture(),owner=await claim(f);
    let now=baseTime;
    const transport=fake({connection:async()=>{now=advanced;return "open";}});
    assert.equal(await process(owner,transport.provider,async()=>new Date(now)),"skipped");
    assert.equal(transport.sends.length,0);
  }
  for(const date of ["2026-10-19","2026-10-10","2026-09-20"]) {
    const f=await fixture(true,date);
    assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
  }
});

test("recuperación sending: TTL estricto, re-reclamo y worker antiguo sin propiedad",async()=>{
  const f=await fixture(),owner=await claim(f);
  const recover=(instant:string)=>recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,async()=>new Date(instant));
  assert.deepEqual(await recover("2026-11-19T13:03:00.000Z"),{pending:0,skipped:0,unknown:0});
  assert.deepEqual(await recover("2026-11-19T13:03:00.001Z"),{pending:1,skipped:0,unknown:0});
  const retry=await claim(f,async()=>new Date("2026-11-19T13:03:01.000Z"));
  assert.notEqual(retry.claimKey,owner.claimKey);
  const old=fake();assert.equal(await process(owner,old.provider),"not_owned");assert.equal(old.sends.length,0);
  const current=fake();assert.equal(await process(retry,current.provider),"sent");
});

test("worker dormido en preflight pierde propiedad tras recovery y no despacha",{timeout:15000},async()=>{
  const f=await fixture(),owner=await claim(f);
  const entered=deferred(),release=deferred();
  const transport=fake({connection:async()=>{entered.resolve();await release.promise;return "open";}});
  const pending=process(owner,transport.provider);
  let retry:ReclamoRecurrenciaPet;
  try {
    await entered.promise;
    await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,async()=>new Date("2026-11-19T13:03:00.001Z"));
    retry=await claim(f,async()=>new Date("2026-11-19T13:03:01.000Z"));
  } finally {release.resolve();}
  assert.equal(await pending,"not_owned");assert.equal(transport.sends.length,0);
  const next=fake();assert.equal(await process(retry!,next.provider),"sent");
});

test("dispatching abandonado/in-flight se vuelve unknown y una aceptación tardía no lo reabre",{timeout:15000},async()=>{
  const f=await fixture(),owner=await claim(f);
  const entered=deferred(),release=deferred();
  const transport=fake({send:async()=>{entered.resolve();await release.promise;return {status:200,data:{key:{id:"late"}}};}});
  const pending=process(owner,transport.provider);
  try {
    await entered.promise;
    assert.equal((await reminder(owner)).estado,"dispatching");
    assert.deepEqual(await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,
      async()=>new Date("2026-11-19T13:03:00.001Z")),{pending:0,skipped:0,unknown:1});
  } finally {release.resolve();}
  assert.equal(await pending,"unknown");
  assert.equal((await reminder(owner)).estado,"unknown");
  assert.equal(await process(owner,transport.provider),"not_owned");assert.equal(transport.sends.length,1);
});

test("worker pausado después de commit pero antes del POST no envía tras recovery unknown",{timeout:15000},async()=>{
  const f=await fixture(),owner=await claim(f),transport=fake();
  const entered=deferred(),release=deferred();let connections=0;
  const db={query:pool.query.bind(pool) as Pool["query"],getConnection:async()=>{
    const connection=await pool.getConnection();
    if(++connections===3){entered.resolve();await release.promise;}
    return connection;
  }};
  const processing=process(owner,transport.provider,baseClock,db);
  void processing.catch(()=>undefined);
  try {
    await Promise.race([entered.promise,processing.then(()=>assert.fail("missing pre-POST barrier"))]);
    assert.equal((await reminder(owner)).estado,"dispatching");
    assert.deepEqual(await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,
      async()=>new Date("2026-11-19T13:03:00.001Z")),{pending:0,skipped:0,unknown:1});
  } finally {release.resolve();await Promise.allSettled([processing]);}
  assert.equal(await processing,"unknown");
  assert.equal(transport.sends.length,0);
});

test("fallo al persistir aceptación: no se repite POST; recovery cierra dispatching como unknown",async()=>{
  const f=await fixture(),owner=await claim(f),transport=fake();
  const query=(async(sql:string,values?:unknown[])=>{
    if(sql.startsWith("UPDATE pet_recordatorios SET estado=?"))throw new Error("DB failure after POST");
    return pool.query(sql,values);
  }) as Pool["query"];
  const db={query,getConnection:()=>pool.getConnection()};
  assert.equal(await process(owner,transport.provider,baseClock,db),"unknown");
  assert.equal((await reminder(owner)).estado,"dispatching");
  assert.deepEqual(await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,
    async()=>new Date("2026-11-19T13:03:00.001Z")),{pending:0,skipped:0,unknown:1});
  assert.equal(transport.sends.length,1);
});

test("commit de dispatching confirmado pero respuesta perdida: no POST y recovery unknown",async()=>{
  const f=await fixture(),owner=await claim(f),transport=fake();
  const db={query:pool.query.bind(pool) as Pool["query"],getConnection:async()=>{
    const tx=await pool.getConnection(); let dispatch=false;
    return new Proxy(tx,{get(target,prop){
      if(prop==="query")return (async(sql:string,values?:unknown[])=>{
        if(sql.startsWith("UPDATE pet_recordatorios SET estado=?") && values?.[0]==="dispatching")dispatch=true;
        return target.query(sql,values);
      }) as PoolConnection["query"];
      if(prop==="commit")return async()=>{await target.commit();if(dispatch)throw new Error("commit response lost");};
      const value:unknown=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
    }});
  }};
  await assert.rejects(process(owner,transport.provider,baseClock,db),/commit response lost/);
  assert.equal(transport.sends.length,0);
  assert.equal((await reminder(owner)).estado,"dispatching");
  assert.deepEqual(await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,
    async()=>new Date("2026-11-19T13:03:00.001Z")),{pending:0,skipped:0,unknown:1});
  assert.equal(await process(owner,transport.provider),"not_owned");
});

for(const afterCommit of ["2026-11-19T15:00:00.000Z","2026-11-20T13:00:00.000Z"]) {
  test(`commit tardío hasta ${afterCommit}: último reloj aborta sin POST ni retry`,async()=>{
    const f=await fixture(),owner=await claim(f),transport=fake();
    let now=baseTime;
    const db={query:pool.query.bind(pool) as Pool["query"],getConnection:async()=>{
      const tx=await pool.getConnection();let dispatch=false;
      return new Proxy(tx,{get(target,prop){
        if(prop==="query")return (async(sql:string,values?:unknown[])=>{
          if(sql.startsWith("UPDATE pet_recordatorios SET estado=?") && values?.[0]==="dispatching")dispatch=true;
          return target.query(sql,values);
        }) as PoolConnection["query"];
        if(prop==="commit")return async()=>{await target.commit();if(dispatch)now=afterCommit;};
        const value:unknown=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
      }});
    }};
    assert.equal(await process(owner,transport.provider,async()=>new Date(now),db),"unknown");
    assert.equal(transport.sends.length,0);
    assert.equal((await reminder(owner)).estado,"unknown");
    assert.equal(await reclamarRecurrenciaPet(f.localId,f.turnoId,frontendUrl,pool,baseClock),null);
  });
}

test("recovery sending con baja o día vencido termina skipped; no hay recuperación retroactiva",async()=>{
  for(const cause of ["baja","expired"] as const) {
    const f=await fixture(),owner=await claim(f);
    if(cause==="baja")await optOut(f);
    const at=cause==="baja" ? "2026-11-19T13:03:00.001Z" : "2026-11-20T13:00:00.000Z";
    assert.deepEqual(await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,async()=>new Date(at)),{pending:0,skipped:1,unknown:0});
    assert.equal((await reminder(owner)).estado,"skipped");
  }
});

test("tenant/tipo aislados: owner ajeno y APPOINTMENT_REMINDER no se procesan ni recuperan",async()=>{
  const f=await fixture(),other=await fixture(),owner=await claim(f),transport=fake();
  assert.equal(await process({...owner,localId:other.localId},transport.provider),"not_owned");
  const appointment=await insert(`INSERT INTO pet_recordatorios
    (local_id,tipo,turno_id,cliente_id,cliente_local_id,estado,created_at,claimed_at)
    VALUES (?,'APPOINTMENT_REMINDER',?,?,?,'sending',?,?)`,
  [f.localId,f.turnoId,f.clienteId,f.localId,"2026-11-19 13:00:00.000","2026-11-19 13:00:00.000"]);
  assert.equal(await process({...owner,id:appointment},transport.provider),"not_owned");
  await recuperarRecurrenciaPet({localId:other.localId,frontendUrl},pool,async()=>new Date("2026-11-19T13:03:00.001Z"));
  assert.equal((await reminder(owner)).estado,"sending");
  await recuperarRecurrenciaPet({localId:f.localId,frontendUrl},pool,async()=>new Date("2026-11-19T13:03:00.001Z"));
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE id=? AND local_id=?",[appointment,f.localId]))[0].estado,"sending");
  assert.equal(transport.sends.length,0);
});

test("no existe transporte por defecto; exige proveedor explícito con contrato reconocido",async()=>{
  await assert.rejects(procesarRecurrenciaPet({id:1,localId:1,mascotaId:1,ultimoTurnoId:1,clienteId:1,claimKey:"x"},
    {frontendUrl,provider:{simulated:false} as unknown as EvolutionRecurrenciaSimulada}),/PROVIDER_REQUIRED/);
});
