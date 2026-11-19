import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePetRecurrenceConfig,runPetRecurrenceCycle,startPetRecurrenceScheduler,
  PET_RECURRENCE_BATCH_SIZE,PET_RECURRENCE_CRON,PET_RECURRENCE_TIMEZONE,
  type PetRecurrenceCycleDependencies,type PetRecurrenceEnvironment } from "./recurrencia.scheduler";
import { createPetRecurrenceTransport } from "./recurrencia.transport";
import { getPetWhatsAppConnectionState,sendPetWhatsAppWithReceipt } from "../../notifications/infrastructure/whatsapp.provider";
import { evolutionClient } from "../../notifications/infrastructure/evolution.client";

const config=(ids="1"):PetRecurrenceEnvironment=>({flag:"true",pilotLocalIds:ids,frontendUrl:"https://example.test/"});
const at="2026-11-19T13:00:00.000Z";
function owner(localId:number,turnoId:number){return {id:turnoId,localId,ultimoTurnoId:turnoId,mascotaId:turnoId,clienteId:1,claimKey:"2026-11-19 13:00:00.000000"};}
function dependencies():PetRecurrenceCycleDependencies {
  return {now:async()=>new Date(at),recover:async()=>({pending:0,skipped:0,unknown:0}),
    page:async()=>({candidatos:[],cursor:null,hayMas:false}),claim:async(local,id)=>owner(local,id),process:async()=>"sent"};
}

test("flag estricta y allowlist vacía: cero DB/procesamiento y cero registro",async()=>{
  const deps=dependencies();deps.now=async()=>assert.fail("disabled must not access DB");
  for(const flag of [undefined,"","false","TRUE","1","yes"]) {
    const raw={...config(),flag};
    assert.equal(parsePetRecurrenceConfig(raw),null);
    assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,0);
    assert.equal(startPetRecurrenceScheduler(()=>raw,()=>assert.fail("no timer")),false);
  }
  for(const pilotLocalIds of [undefined,"","   "]) {
    const raw={...config(),pilotLocalIds};
    assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,0);
    assert.equal(startPetRecurrenceScheduler(()=>raw,()=>assert.fail("no timer")),false);
  }
});

test("allowlist solo IDs INT positivos explícitos; error en una entrada invalida toda la configuración",async(t)=>{
  assert.deepEqual(parsePetRecurrenceConfig(config(" 2,1,2 "))?.localIds,[2,1]);
  const logs:unknown[][]=[];t.mock.method(console,"error",(...args:unknown[])=>logs.push(args));
  for(const list of ["0","-1","01","1,","1,,2","1.5","1e2","2147483648","1,secret-value",Array(101).fill("1").join(",")]) {
    assert.throws(()=>parsePetRecurrenceConfig(config(list)));
    await assert.rejects(runPetRecurrenceCycle(()=>config(list),dependencies()));
    assert.equal(startPetRecurrenceScheduler(()=>config(list),()=>assert.fail("invalid cannot register")),false);
  }
  assert.ok(!JSON.stringify(logs).includes("secret-value"));
});

test("URL pública inválida no se convierte en dominio por defecto ni permite registro",()=>{
  for(const frontendUrl of [undefined,"http://example.test","https://user:private@example.test","https://example.test/?token=private"]) {
    assert.throws(()=>parsePetRecurrenceConfig({...config(),frontendUrl}));
  }
});

test("fuera de [10,12) no hay recovery, selección ni procesamiento",async()=>{
  for(const instant of ["2026-11-19T12:59:59.999Z","2026-11-19T15:00:00.000Z"]) {
    const deps=dependencies();deps.now=async()=>new Date(instant);
    deps.recover=async()=>assert.fail("no recovery outside window");
    deps.page=async()=>assert.fail("no page outside window");
    assert.equal((await runPetRecurrenceCycle(()=>config(),deps)).claimed,0);
  }
});

test("recovery antes de páginas; keyset avanza por 50 excluidos hasta un candidato posterior",async()=>{
  const deps=dependencies(),events:string[]=[];
  deps.recover=async id=>{events.push(`recover:${id}`);return {pending:1,skipped:0,unknown:1};};
  deps.page=async(id,cursor)=>{events.push(`page:${cursor}`);return cursor===null
    ?{candidatos:[],cursor:50,hayMas:true}:{candidatos:[{localId:id,turnoId:51}],cursor:51,hayMas:false};};
  deps.claim=async(id,turno)=>{events.push(`claim:${turno}`);return owner(id,turno);};
  deps.process=async()=>{events.push("process");return "sent";};
  const result=await runPetRecurrenceCycle(()=>config(),deps);
  assert.equal(result.claimed,1);assert.deepEqual(result.recovered,{pending:1,skipped:0,unknown:1});
  assert.deepEqual(events,["recover:1","page:null","page:50","claim:51","process"]);
});

test("presupuesto propio de 20 reclamos, round-robin y rotación entre más de 20 locales",async()=>{
  const deps=dependencies(),claims:number[]=[];
  const ids=Array.from({length:25},(_,i)=>i+1).join(",");
  deps.page=async id=>({candidatos:[{localId:id,turnoId:id}],cursor:id,hayMas:false});
  deps.claim=async(id,turno)=>{claims.push(id);return owner(id,turno);};
  const first=await runPetRecurrenceCycle(()=>config(ids),deps);
  assert.equal(first.claimed,PET_RECURRENCE_BATCH_SIZE);assert.equal(first.nextOffset,20);
  const second=await runPetRecurrenceCycle(()=>config(ids),deps,first.nextOffset);
  assert.equal(second.claimed,20);assert.equal(new Set(claims).size,25);
  assert.deepEqual(claims.slice(20,25),[21,22,23,24,25]);
});

test("pending difiere solo ese local; el siguiente conserva su presupuesto",async()=>{
  const deps=dependencies(),processed:number[]=[];
  deps.page=async id=>({candidatos:Array.from({length:30},(_,i)=>({localId:id,turnoId:id*100+i})),cursor:1000,hayMas:false});
  deps.process=async work=>{processed.push(work.localId);return work.localId===1?"pending":"sent";};
  const result=await runPetRecurrenceCycle(()=>config("1,2"),deps);
  assert.equal(result.claimed,20);assert.equal(processed.filter(id=>id===1).length,1);
  assert.equal(processed.filter(id=>id===2).length,19);
});

test("un claim perdido no consume cupo; error de item no aborta candidatos siguientes",async(t)=>{
  t.mock.method(console,"warn",()=>{});
  const deps=dependencies();let processed=0;
  deps.page=async id=>({candidatos:[1,2,3].map(turnoId=>({localId:id,turnoId})),cursor:3,hayMas:false});
  deps.claim=async(id,turno)=>turno===1?null:owner(id,turno);
  deps.process=async work=>{if(work.id===2)throw new Error("private error");processed++;return "sent";};
  const result=await runPetRecurrenceCycle(()=>config(),deps);
  assert.equal(result.claimed,2);assert.equal(result.itemErrors,1);assert.equal(processed,1);
});

test("candidatos/claims de otro local se rechazan antes de process",async()=>{
  const deps=dependencies(),claimed:number[]=[];
  deps.page=async()=>({candidatos:[{localId:99,turnoId:1},{localId:1,turnoId:2}],cursor:2,hayMas:false});
  deps.claim=async(id,turno)=>{claimed.push(id);return owner(99,turno);};
  deps.process=async()=>assert.fail("foreign owner cannot reach provider");
  const result=await runPetRecurrenceCycle(()=>config(),deps);
  assert.deepEqual(claimed,[1]);assert.equal(result.itemErrors,2);
});

test("flag/allowlist se revalidan al cambiar durante el ciclo",async()=>{
  for(const removed of [true,false]) {
    const raw=config(),deps=dependencies();
    deps.page=async id=>{if(removed)raw.pilotLocalIds="";else raw.flag="false";
      return {candidatos:[{localId:id,turnoId:1}],cursor:1,hayMas:false};};
    deps.claim=async()=>assert.fail("disabled cohort cannot claim");
    assert.equal((await runPetRecurrenceCycle(()=>raw,deps)).claimed,0);
  }
});

test("cierre de ventana entre selección y claim bloquea; cursor sin progreso falla cerrado",async()=>{
  for(const advanced of ["2026-11-19T15:00:00.000Z","2026-11-20T13:00:00.000Z"]){
    const deps=dependencies();let late=false;
    deps.now=async()=>new Date(late?advanced:at);
    deps.page=async id=>{late=true;return {candidatos:[{localId:id,turnoId:1}],cursor:1,hayMas:false};};
    deps.claim=async()=>assert.fail("late cannot claim");
    assert.equal((await runPetRecurrenceCycle(()=>config(),deps)).claimed,0);
  }
  for(const cursor of [null,NaN,0,-1]){
    const bad=dependencies();bad.page=async()=>({candidatos:[],cursor,hayMas:true});
    await assert.rejects(runPetRecurrenceCycle(()=>config(),bad),/CURSOR_INVALID/);
  }
});

test("fallos estructurales DB abortan y no se tratan como errores de un turno",async()=>{
  const deps=dependencies();deps.page=async id=>({candidatos:[{localId:id,turnoId:1}],cursor:1,hayMas:false});
  deps.claim=async()=>{throw Object.assign(new Error("private SQL"),{code:"ER_NO_SUCH_TABLE"});};
  await assert.rejects(runPetRecurrenceCycle(()=>config(),deps));
});

test("adaptador reutiliza funciones PET existentes y HTTP se simula, nunca se conecta",async(t)=>{
  const transport=createPetRecurrenceTransport();
  assert.equal(transport.connection,getPetWhatsAppConnectionState);assert.equal(transport.send,sendPetWhatsAppWithReceipt);
  const requests:{path:string;body?:unknown}[]=[];
  t.mock.method(evolutionClient,"get",(async(path:string)=>{requests.push({path});return {data:{instance:{state:"open"}}};}) as typeof evolutionClient.get);
  t.mock.method(evolutionClient,"post",(async(path:string,body:unknown)=>{requests.push({path,body});return {status:201,data:{key:{id:"existing-pet-receipt"}}};}) as typeof evolutionClient.post);
  assert.equal(await transport.connection("123"),"open");
  assert.equal(await transport.send("5491123456789","simulated message","123"),"existing-pet-receipt");
  assert.deepEqual(requests,[{path:"/instance/connectionState/123"},{path:"/message/sendText/123",body:{number:"5491123456789",textMessage:{text:"simulated message"}}}]);
});

test("registro simulado: cron ART exclusivo, sin ejecución inicial, single-flight y kill switch",async(t)=>{
  let callback!:()=>Promise<void>;let schedules=0,cycles=0;
  let instant=at,fail=false;const raw=config();
  let release!:()=>void;let started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const logs:unknown[][]=[];t.mock.method(console,"error",(...args:unknown[])=>logs.push(args));
  const schedule:Parameters<typeof startPetRecurrenceScheduler>[1]=(expression,cb,options)=>{
    schedules++;callback=cb;assert.equal(expression,PET_RECURRENCE_CRON);assert.equal(expression,"*/5 10-11 * * *");
    assert.equal(options.timezone,PET_RECURRENCE_TIMEZONE);return {stop(){}};
  };
  assert.equal(startPetRecurrenceScheduler(()=>raw,schedule,async()=>{
    cycles++;if(fail)throw new Error("private-cycle-error");started();await gate;
  },async()=>new Date(instant)),true);
  assert.equal(cycles,0);assert.equal(schedules,1);
  instant="2026-11-19T15:00:00.000Z";await callback();assert.equal(cycles,0);
  instant=at;raw.flag="false";await callback();assert.equal(cycles,0);
  raw.flag="true";raw.pilotLocalIds="";await callback();assert.equal(cycles,0);
  raw.pilotLocalIds="1";const first=callback();await entered;await callback();assert.equal(cycles,1);
  release();await first;
  raw.pilotLocalIds="private-invalid";await callback();assert.ok(!JSON.stringify(logs).includes("private-invalid"));
  raw.pilotLocalIds="1";fail=true;await callback();assert.equal(cycles,2);
  assert.ok(!JSON.stringify(logs).includes("private-cycle-error"));
  fail=false;await callback();assert.equal(cycles,3,"failure releases the single-flight guard");
  assert.equal(startPetRecurrenceScheduler(()=>raw,schedule),true);assert.equal(schedules,1);
});
