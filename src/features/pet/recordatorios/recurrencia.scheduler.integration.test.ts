import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after,before,test } from "node:test";
import type { Pool,PoolConnection,ResultSetHeader,RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { operarContactosRecurrencia } from "./recurrencia.contactos";
import { seleccionarPaginaRecurrenciaPet } from "./recurrencia.service";
import { createPetRecurrenceDependencies,runPetRecurrenceCycle,type PetRecurrenceEnvironment } from "./recurrencia.scheduler";
import { createPetRecurrenceTransport } from "./recurrencia.transport";
import { evolutionClient } from "../../notifications/infrastructure/evolution.client";
import { reclamarRecurrenciaPet,type ProveedorRecurrenciaPet } from "./recurrencia.processing";

const tag=`REC30SCHED_${randomUUID()}`;
const phone="+5491123456789";
const base="https://example.test";
const clock=async()=>new Date("2026-11-19T13:00:00.000Z");
const ids:number[]=[];
const tables=["locales","clientes","mascotas","mascota_clientes","mascota_servicios","servicios","turnos","pet_recordatorios","pet_recurrencia_contactos"];
let baseline:number[];
interface Fixture{local:number;client:number;service:number;slug:string}
async function rows(sql:string,values:unknown[]=[]){const [result]=await pool.query<RowDataPacket[]>(sql,values);return result;}
async function insert(sql:string,values:unknown[]){const [result]=await pool.query<ResultSetHeader>(sql,values);return result.insertId;}
async function counts(){return Promise.all(tables.map(async table=>Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n)));}
async function fixture(kind="PET_GROOMING"):Promise<Fixture>{
  const slug=`${tag}-${ids.length}`;
  const local=await insert(`INSERT INTO locales (nombre,slug,business_type,activo,suscripcion_estado,suscripcion_vencimiento)
    VALUES (?,?,?,1,'activo','2099-12-31')`,[tag,slug,kind]);ids.push(local);
  const client=await insert("INSERT INTO clientes (local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)",[local,tag,phone,phone]);
  const service=await insert("INSERT INTO servicios (local_id,nombre,activo,duracion,precio) VALUES (?,?,1,NULL,NULL)",[local,tag]);
  if(kind==="PET_GROOMING")await operarContactosRecurrencia({localId:local,aplicar:true,operaciones:[{tipo:"autorizacion",clienteId:client,
    telefonoCanonical:phone,verificadaAt:"2026-11-01T12:00:00.000Z",referenciaVerificacion:tag}]},pool,clock);
  return {local,client,service,slug};
}
async function pet(f:Fixture,date="2026-10-20",online=1){
  const mascota=await insert("INSERT INTO mascotas (local_id,nombre,activo,reserva_online_habilitada) VALUES (?,?,1,?)",[f.local,tag,online]);
  await pool.query("INSERT INTO mascota_clientes (local_id,mascota_id,cliente_id) VALUES (?,?,?)",[f.local,mascota,f.client]);
  await pool.query("INSERT INTO mascota_servicios (local_id,mascota_id,servicio_id,duracion_minutos) VALUES (?,?,?,30)",[f.local,mascota,f.service]);
  const turno=await insert(`INSERT INTO turnos
    (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
     servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
    VALUES (?,?,?,?,?,?,'10:00','10:30','completado',?,?,30,0)`,[f.local,mascota,f.client,tag,phone,date,f.service,tag]);
  return {mascota,turno};
}
function config():PetRecurrenceEnvironment{return {flag:"true",frontendUrl:base};}
function dependencies(provider:ProveedorRecurrenciaPet,locals:number[],db:Pick<Pool,"query"|"getConnection">=pool,reloj=clock){
  const deps=createPetRecurrenceDependencies(provider,db,reloj);
  const discover=deps.listLocalIds;
  // Test containment only: run the real discovery query but never process non-owned Docker data.
  deps.listLocalIds=async()=>(await discover()).filter(id=>locals.includes(id));
  return deps;
}
function fake(onConnection?:()=>void){
  const sends:{instance:string;message:string}[]=[];
  const provider:ProveedorRecurrenciaPet={kind:"pet_receipt",connection:async()=>{onConnection?.();return "open";},
    send:async(_number,message,instance)=>{sends.push({instance,message});return "mocked-pet-receipt";}};
  return {provider,sends};
}
before(async()=>{baseline=await counts();});
after(async()=>{
  try{
    for(const id of ids){
      assert.equal((await rows("SELECT nombre FROM locales WHERE id=?",[id]))[0]?.nombre,tag);
      for(const table of ["turnos","mascota_servicios","mascota_clientes","mascotas","clientes","servicios"]){
        await pool.query(`DELETE FROM ${table} WHERE local_id=?`,[id]);
      }
      await pool.query("DELETE FROM locales WHERE id=? AND nombre=?",[id,tag]);
    }
    for(const id of ids)for(const table of tables.filter(table=>table!=="locales")){
      assert.equal((await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id=?`,[id]))[0].n,0);
    }
    if(baseline)assert.deepEqual(await counts(),baseline,"all scheduler fixture counts restored");
    console.info("REC30 scheduler cleanup verified",{fixtures:ids.length,residuals:0});
  }finally{await pool.end();}
});

test("flag apagada no crea claims ni contacta transporte",async()=>{
  const f=await fixture();await pet(f);
  const transport=fake();const deps=dependencies(transport.provider,[f.local]);
  for(const raw of [{...config(),flag:undefined},{...config(),flag:"false"}]){
    assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,0);
  }
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id=?",[f.local]))[0].n,0);
  assert.equal(transport.sends.length,0);
});

test("descubrimiento global PET: envío y recovery por tenant, excluye BEAUTY y preserva APPOINTMENT_REMINDER",async(t)=>{
  const a=await fixture(),b=await fixture(),beauty=await fixture("BEAUTY");
  const due=await pet(a),excluded=await pet(b);await pet(beauty);
  const excludedClaim=await reclamarRecurrenciaPet(b.local,excluded.turno,base,pool,clock);
  assert.ok(excludedClaim);
  await pool.query("UPDATE pet_recordatorios SET claimed_at='2026-11-19 12:50:00.000' WHERE id=? AND local_id=?",[excludedClaim.id,b.local]);
  const old=await insert(`INSERT INTO pet_recordatorios (local_id,tipo,turno_id,cliente_id,cliente_local_id,estado,created_at)
    VALUES (?,'APPOINTMENT_REMINDER',?,?,?,'pending',UTC_TIMESTAMP(3))`,[a.local,due.turno,a.client,a.local]);
  const posts:{path:string;body:unknown}[]=[];
  t.mock.method(evolutionClient,"get",(async()=>({data:{instance:{state:"open"}}})) as typeof evolutionClient.get);
  t.mock.method(evolutionClient,"post",(async(path:string,body:unknown)=>{posts.push({path,body});return {status:201,data:{key:{id:"existing-pet-http-mock"}}};}) as typeof evolutionClient.post);
  const deps=dependencies(createPetRecurrenceTransport(),[a.local,b.local,beauty.local]);
  const raw=config();
  assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,2);
  assert.equal(posts.length,2);assert.equal(posts[0].path,`/message/sendText/${a.local}`);
  assert.equal(posts[1].path,`/message/sendText/${b.local}`);
  const body=posts[0].body as {number:string;textMessage:{text:string}};
  assert.equal(body.number,phone.slice(1));assert.ok(body.textMessage.text.includes(`${base}/${a.slug}`));
  assert.ok(!/token=|\/acceso/.test(body.textMessage.text));
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE id=? AND local_id=?",[old,a.local]))[0].estado,"pending");
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE id=? AND local_id=?",[excludedClaim.id,b.local]))[0].estado,"sent",
    "stale sending is recovered and dispatched only through its own tenant");
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id=?",[beauty.local]))[0].n,0);
  assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,0);assert.equal(posts.length,2);
});

test("nuevo local PET aparece en el siguiente ciclo; local inactivo sigue descubierto para recovery",async()=>{
  const a=await fixture();await pet(a);
  const owned=[a.local],transport=fake(),deps=dependencies(transport.provider,owned),raw=config();
  assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,1);
  const b=await fixture();const due=await pet(b);owned.push(b.local);
  assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,1);
  assert.deepEqual(transport.sends.map(send=>send.instance),[String(a.local),String(b.local)]);
  const stale=await pet(b);
  const claim=await reclamarRecurrenciaPet(b.local,stale.turno,base,pool,clock);assert.ok(claim);
  await pool.query("UPDATE pet_recordatorios SET claimed_at='2026-11-19 12:50:00.000' WHERE id=? AND local_id=?",[claim.id,b.local]);
  await pool.query("UPDATE locales SET activo=0 WHERE id=?",[b.local]);
  assert.deepEqual(await deps.listLocalIds(),owned);
  const result=await runPetRecurrenceCycle(()=>raw,deps);
  assert.equal(result.recovered.skipped,1);assert.equal(result.claimed,0);assert.equal(transport.sends.length,2);
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE local_id=? AND ultimo_turno_completado_id=?",[b.local,due.turno]))[0].estado,"sent");
});

test("D30 exacto del ciclo: nunca D31/D40/D60; reserva posterior a D35 también excluye",async()=>{
  const f=await fixture(),due=await pet(f),reserved=await pet(f);
  for(const date of ["2026-10-19","2026-10-10","2026-09-20"])await pet(f,date);
  await insert(`INSERT INTO turnos (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
    servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
    VALUES (?,?,?,?,?,'2027-01-01','10:00','10:30','activo',?,?,30,0)`,
  [f.local,reserved.mascota,f.client,tag,phone,f.service,tag]);
  const transport=fake();const deps=dependencies(transport.provider,[f.local]);
  assert.equal((await runPetRecurrenceCycle(()=>config(),deps)).claimed,1);
  assert.equal(transport.sends.length,1);
  assert.equal((await rows("SELECT ultimo_turno_completado_id FROM pet_recordatorios WHERE local_id=?",[f.local]))[0].ultimo_turno_completado_id,due.turno);
  const tomorrow=dependencies(transport.provider,[f.local],pool,async()=>new Date("2026-11-20T13:00:00.000Z"));
  assert.equal((await runPetRecurrenceCycle(()=>config(),tomorrow)).claimed,0);
});

test("presupuesto independiente: 25 D30 producen 20 y después 5, sin duplicados",async()=>{
  const f=await fixture();for(let i=0;i<25;i++)await pet(f);
  const transport=fake();const deps=dependencies(transport.provider,[f.local]);
  assert.equal((await runPetRecurrenceCycle(()=>config(),deps)).claimed,20);
  assert.equal((await runPetRecurrenceCycle(()=>config(),deps)).claimed,5);
  assert.equal(transport.sends.length,25);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id=? AND estado='sent'",[f.local]))[0].n,25);
});

test("página de 50 D30 excluidos no oculta al válido posterior",async()=>{
  const f=await fixture();let last=0;
  for(let i=0;i<50;i++)last=(await pet(f,"2026-10-20",0)).turno;
  const good=await pet(f);
  const first=await seleccionarPaginaRecurrenciaPet(f.local,null,pool,clock);
  assert.equal(first.candidatos.length,0);assert.equal(first.cursor,last);assert.equal(first.hayMas,true);
  const second=await seleccionarPaginaRecurrenciaPet(f.local,first.cursor,pool,clock);
  assert.deepEqual(second.candidatos,[{localId:f.local,turnoId:good.turno}]);
  const transport=fake();assert.equal((await runPetRecurrenceCycle(()=>config(),dependencies(transport.provider,[f.local]))).claimed,1);
});

for(const kill of ["flag","url"] as const){
  test(`kill switch ${kill} durante preflight difiere sin enviar`,async()=>{
    const f=await fixture();await pet(f);const raw=config();
    const transport=fake(()=>{if(kill==="flag")raw.flag="false";else raw.frontendUrl="https://changed.test";});
    const deps=dependencies(transport.provider,[f.local]);
    assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,1);assert.equal(transport.sends.length,0);
    assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE local_id=?",[f.local]))[0].estado,"pending");
  });
}

test("flag retirada tras commit de dispatching: unknown terminal sin POST",async()=>{
  const f=await fixture();await pet(f);const raw=config(),transport=fake();
  const db={query:pool.query.bind(pool) as Pool["query"],getConnection:async()=>{
    const tx=await pool.getConnection();let dispatch=false;
    return new Proxy(tx,{get(target,prop){
      if(prop==="query")return (async(sql:string,values?:unknown[])=>{
        if(sql.startsWith("UPDATE pet_recordatorios SET estado=?") && values?.[0]==="dispatching")dispatch=true;
        return target.query(sql,values);
      }) as PoolConnection["query"];
      if(prop==="commit")return async()=>{await target.commit();if(dispatch)raw.flag="false";};
      const value:unknown=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
    }});
  }};
  await runPetRecurrenceCycle(()=>raw,dependencies(transport.provider,[f.local],db));
  assert.equal(transport.sends.length,0);
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE local_id=?",[f.local]))[0].estado,"unknown");
});

test("dos ciclos concurrentes comparten exclusión MySQL, nunca presupuesto/filas del aviso previo",async()=>{
  const f=await fixture();await pet(f);
  const transport=fake(),deps=dependencies(transport.provider,[f.local]);
  const results=await Promise.all([runPetRecurrenceCycle(()=>config(),deps),runPetRecurrenceCycle(()=>config(),deps)]);
  assert.equal(results.reduce((sum,result)=>sum+result.claimed,0),1);assert.equal(transport.sends.length,1);
});
