import cron from "node-cron";
import type { Pool } from "mysql2/promise";
import { pool } from "../../../config/db";
import { validatePetFrontendUrl } from "../session/session.link";
import { relojMysqlRecordatorioPet, type RelojRecordatorioPet } from "./recordatorios.service";
import { contextoRecurrenciaPet } from "./recurrencia.time";
import { listarLocalesRecurrenciaPet, seleccionarPaginaRecurrenciaPet, type PaginaRecurrenciaPet } from "./recurrencia.service";
import { reclamarRecurrenciaPet, procesarRecurrenciaPet, recuperarRecurrenciaPet,
  type ProveedorRecurrenciaPet, type ReclamoRecurrenciaPet } from "./recurrencia.processing";
import { createPetRecurrenceTransport } from "./recurrencia.transport";

export const PET_RECURRENCE_CRON="*/5 10-11 * * *";
export const PET_RECURRENCE_TIMEZONE="America/Argentina/Buenos_Aires";
export const PET_RECURRENCE_BATCH_SIZE=20;
export interface PetRecurrenceEnvironment {flag?:string;frontendUrl?:string}
export type PetRecurrenceConfigSource=()=>PetRecurrenceEnvironment;
export function readPetRecurrenceEnvironment():PetRecurrenceEnvironment {
  return {flag:process.env.PET_RECURRENCE_ENABLED,frontendUrl:process.env.FRONTEND_URL};
}
export function parsePetRecurrenceConfig(raw:PetRecurrenceEnvironment) {
  if(raw.flag!=="true")return null;
  return {frontendUrl:validatePetFrontendUrl(raw.frontendUrl,"production")};
}
function allowed(source:PetRecurrenceConfigSource,base:string):boolean {
  try {const config=parsePetRecurrenceConfig(source());return !!config && config.frontendUrl===base;}
  catch{return false;}
}
type Recovery=Awaited<ReturnType<typeof recuperarRecurrenciaPet>>;
async function mysqlNow() {
  const connection=await pool.getConnection();
  try{return await relojMysqlRecordatorioPet(connection);}finally{connection.release();}
}
export interface PetRecurrenceCycleDependencies {
  now():Promise<Date>;
  listLocalIds():Promise<number[]>;
  recover(localId:number,frontendUrl:string):Promise<Recovery>;
  page(localId:number,cursor:number|null):Promise<PaginaRecurrenciaPet>;
  claim(localId:number,turnoId:number,frontendUrl:string):Promise<ReclamoRecurrenciaPet|null>;
  process(owner:ReclamoRecurrenciaPet,frontendUrl:string,permitirDespacho:()=>boolean):ReturnType<typeof procesarRecurrenciaPet>;
}
export function createPetRecurrenceDependencies(
  provider:ProveedorRecurrenciaPet=createPetRecurrenceTransport(),
  db:Pick<Pool,"query"|"getConnection">=pool,reloj:RelojRecordatorioPet=relojMysqlRecordatorioPet,
):PetRecurrenceCycleDependencies {
  return {
    now:async()=>{const tx=await db.getConnection();try{return await reloj(tx);}finally{tx.release();}},
    listLocalIds:()=>listarLocalesRecurrenciaPet(db),
    recover:(localId,frontendUrl)=>recuperarRecurrenciaPet({localId,frontendUrl},db,reloj),
    page:(localId,cursor)=>seleccionarPaginaRecurrenciaPet(localId,cursor,db,reloj),
    claim:(localId,turnoId,url)=>reclamarRecurrenciaPet(localId,turnoId,url,db,reloj),
    process:(owner,frontendUrl,permitirDespacho)=>procesarRecurrenciaPet(owner,{frontendUrl,provider,permitirDespacho},db,reloj),
  };
}
function structural(error:unknown) {
  if(!error || typeof error!=="object")return false;
  if("errno" in error || "sqlState" in error)return true;
  return "code" in error && typeof error.code==="string" && (error.code.startsWith("ER_")
    || error.code.startsWith("PROTOCOL_") || ["ECONNREFUSED","ECONNRESET","ETIMEDOUT","EPIPE"].includes(error.code));
}

/** Round-robin, independent budget; selection is only a snapshot, claim/process revalidate. */
export async function runPetRecurrenceCycle(
  source:PetRecurrenceConfigSource=readPetRecurrenceEnvironment,
  injected?:PetRecurrenceCycleDependencies,startOffset=0,
) {
  const result={claimed:0,itemErrors:0,recovered:{pending:0,skipped:0,unknown:0},nextOffset:startOffset};
  const config=parsePetRecurrenceConfig(source());
  if(!config)return result; // No DB, recovery, provider or dependency factory while disabled.
  const deps=injected??createPetRecurrenceDependencies();
  const context=contextoRecurrenciaPet(await deps.now());
  if(!context.enVentana)return result;
  const localIds=await deps.listLocalIds();
  if(!localIds.length)return result;
  const offset=((startOffset%localIds.length)+localIds.length)%localIds.length;
  const ids=[...localIds.slice(offset),...localIds.slice(0,offset)];
  const states=ids.map(localId=>({localId,cursor:null as number|null,queue:[] as PaginaRecurrenciaPet["candidatos"],done:false,recovered:false,more:true}));
  const inWindow=async()=>{const now=contextoRecurrenciaPet(await deps.now());return now.enVentana && now.hoyArgentina===context.hoyArgentina;};
  cycle: while(result.claimed<PET_RECURRENCE_BATCH_SIZE && states.some(state=>!state.done)) {
    for(const state of states) {
      if(state.done)continue;
      if(!allowed(source,config.frontendUrl)){state.done=true;continue;}
      if(!await inWindow())break cycle;
      result.nextOffset=(localIds.indexOf(state.localId)+1)%localIds.length;
      if(!state.recovered) {
        const recovered=await deps.recover(state.localId,config.frontendUrl);
        for(const key of ["pending","skipped","unknown"] as const)result.recovered[key]+=recovered[key];
        state.recovered=true;
      }
      if(!allowed(source,config.frontendUrl)){state.done=true;continue;}
      if(!await inWindow())break cycle;
      if(!state.queue.length) {
        if(!state.more){state.done=true;continue;}
        const page=await deps.page(state.localId,state.cursor);
        if(page.hayMas && (page.cursor===null || !Number.isSafeInteger(page.cursor)
          || page.cursor<=(state.cursor??0)))throw new Error("PET_RECURRENCE_CURSOR_INVALID");
        state.cursor=page.cursor;state.more=page.hayMas;state.queue=page.candidatos;
        if(!state.queue.length){if(!state.more)state.done=true;continue;}
      }
      const candidate=state.queue.shift()!;
      if(candidate.localId!==state.localId){result.itemErrors++;continue;}
      if(!allowed(source,config.frontendUrl)){state.done=true;continue;}
      if(!await inWindow())break cycle;
      try {
        const owner=await deps.claim(state.localId,candidate.turnoId,config.frontendUrl);
        if(!owner)continue;
        result.claimed++;
        if(owner.localId!==state.localId || owner.ultimoTurnoId!==candidate.turnoId) {
          result.itemErrors++;
        } else if(!allowed(source,config.frontendUrl) || !await inWindow()) {
          // No processing; before HTTP, the lease remains safely recoverable.
          break cycle;
        } else if(await deps.process(owner,config.frontendUrl,()=>allowed(source,config.frontendUrl))==="pending") {
          state.done=true; // Probe disconnected/deferred local once, leave other tenants a turn.
        }
      } catch(error) {
        if(structural(error))throw error;
        result.itemErrors++;
        console.warn("PET recurrence item failed",{localId:state.localId,turnoId:candidate.turnoId,class:"ITEM_FAILURE"});
      }
      if(result.claimed===PET_RECURRENCE_BATCH_SIZE)break cycle;
    }
  }
  return result;
}

type RegisterSchedule=(expression:string,callback:()=>Promise<void>,options:{timezone:string})=>{stop():void};
let registered:ReturnType<RegisterSchedule>|null=null;

/** Registers only: never immediately executes, and the global flag is closed by default. */
export function startPetRecurrenceScheduler(
  source:PetRecurrenceConfigSource=readPetRecurrenceEnvironment,
  schedule:RegisterSchedule=cron.schedule,
  injectedCycle?:()=>Promise<unknown>,
  now:()=>Promise<Date>=mysqlNow,
) {
  try {
    if(!parsePetRecurrenceConfig(source()))return false;
    if(registered)return true;
    let running=false,offset=0;
    const cycle=injectedCycle??(async()=>{
      const result=await runPetRecurrenceCycle(source,undefined,offset);offset=result.nextOffset;
    });
    registered=schedule(PET_RECURRENCE_CRON,async()=>{
      if(running)return;
      running=true;
      try {
        if(!parsePetRecurrenceConfig(source()))return;
        if(!contextoRecurrenciaPet(await now()).enVentana)return;
        await cycle();
      }
      catch {console.error("PET recurrence cycle failed",{class:"CYCLE_FAILURE"});}
      finally {running=false;}
    },{timezone:PET_RECURRENCE_TIMEZONE});
    console.info("PET recurrence scheduler registered",{frequency:"5m",timezone:PET_RECURRENCE_TIMEZONE});
    return true;
  } catch {
    console.error("PET recurrence scheduler not registered",{class:"CONFIGURATION_FAILURE"});
    return false; // Recurrence misconfiguration never blocks server/APPOINTMENT_REMINDER startup.
  }
}
