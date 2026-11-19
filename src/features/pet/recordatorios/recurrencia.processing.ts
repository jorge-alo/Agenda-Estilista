import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { evolutionNumberFromE164, validatePetFrontendUrl } from "../session/session.link";
import { relojMysqlRecordatorioPet, type RelojRecordatorioPet } from "./recordatorios.service";
import { fechaHoraSqlUtc } from "./recordatorios.time";
import { contextoRecurrenciaPet } from "./recurrencia.time";
import { evaluarCicloRecurrenciaPet, type MotivoExclusionRecurrenciaPet } from "./recurrencia.service";
import { buildPetRecurrenceReminder, reciboRecurrenciaSimulado } from "./recurrencia.message";

export const PET_RECURRENCE_STALE_MS = 180_000;
export interface ReclamoRecurrenciaPet {
  id: number; localId: number; mascotaId: number; ultimoTurnoId: number;
  clienteId: number | null; claimKey: string;
}
/** Raw Evolution responses remain supported for fault simulations. No default provider. */
export interface EvolutionRecurrenciaSimulada {
  simulated: true;
  connection(instance: string): Promise<"open" | "closed" | "unavailable">;
  send(number: string, message: string, instance: string): Promise<unknown>;
}
/** Already validated receipt contract of the existing PET transport. */
export interface EvolutionRecurrenciaPet {
  kind: "pet_receipt";
  connection(instance: string): Promise<"open" | "closed" | "unavailable">;
  send(number: string, message: string, instance: string): Promise<string|null>;
}
export type ProveedorRecurrenciaPet = EvolutionRecurrenciaSimulada | EvolutionRecurrenciaPet;
type Db = Pick<Pool, "getConnection" | "query">;
type Resultado = "pending" | "skipped" | "sent" | "unknown" | "not_owned";
type Row = RowDataPacket & { id: number; mascota_id: number; ultimo_turno_completado_id: number;
  cliente_id: number | null; estado: string; claim_key: string };
const IDENTITY = "id=? AND local_id=? AND tipo='RECURRENCE_DAY_30' AND mascota_id=? AND ultimo_turno_completado_id=?";
const projection = "id,mascota_id,ultimo_turno_completado_id,cliente_id,estado,DATE_FORMAT(claimed_at,'%Y-%m-%d %H:%i:%s.%f') AS claim_key";
function params(owner: ReclamoRecurrenciaPet) { return [owner.id,owner.localId,owner.mascotaId,owner.ultimoTurnoId]; }
function validId(id: number) { return Number.isSafeInteger(id) && id > 0; }
function ownerFrom(row: Row, localId: number): ReclamoRecurrenciaPet {
  return { id: row.id, localId, mascotaId: row.mascota_id, ultimoTurnoId: row.ultimo_turno_completado_id,
    clienteId: row.cliente_id, claimKey: row.claim_key };
}
function log(owner: ReclamoRecurrenciaPet, to: string, reason: string) {
  console.info("PET recurrence transition", { id: owner.id, localId: owner.localId, mascotaId: owner.mascotaId,
    ultimoTurnoId: owner.ultimoTurnoId, tipo: "RECURRENCE_DAY_30", to, reason });
}

async function transaction<T>(db: Db, action: (tx: PoolConnection) => Promise<T>): Promise<T> {
  const tx = await db.getConnection();
  let active = false;
  let destroyed = false;
  try {
    // Per-transaction, NOT a leaked session setting. Discovery reads cannot pin a stale RR snapshot.
    await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await tx.beginTransaction(); active = true;
    const result = await action(tx);
    await tx.commit(); active = false;
    return result;
  } catch (error) {
    if (active) {
      try { await tx.rollback(); } catch { tx.destroy(); destroyed = true; }
    }
    throw error;
  } finally { if (!destroyed) tx.release(); }
}

/** Local X serializes bookings, transitions and opt-outs; pet X freezes service-link writers. */
async function lockContext(tx: PoolConnection, localId: number, turnoId: number) {
  const [locals] = await tx.query<RowDataPacket[]>("SELECT id FROM locales WHERE id=? FOR UPDATE",[localId]);
  if (!locals.length) return null;
  const [turns] = await tx.query<(RowDataPacket & { mascota_id: number; cliente_id: number | null })[]>(
    "SELECT mascota_id,cliente_id FROM turnos WHERE local_id=? AND id=? FOR UPDATE",[localId,turnoId]);
  const turn = turns[0];
  if (!turn?.mascota_id) return null;
  const [pets] = await tx.query<(RowDataPacket & {nombre:string})[]>(
    "SELECT nombre FROM mascotas WHERE local_id=? AND id=? FOR UPDATE",[localId,turn.mascota_id]);
  if (turn.cliente_id !== null) {
    const [clients] = await tx.query<(RowDataPacket & {telefono_normalizado:string|null})[]>(
      "SELECT telefono_normalizado FROM clientes WHERE local_id=? AND id=? FOR SHARE",[localId,turn.cliente_id]);
    await tx.query("SELECT cliente_id FROM mascota_clientes WHERE local_id=? AND mascota_id=? AND cliente_id=? FOR SHARE",
      [localId,turn.mascota_id,turn.cliente_id]);
    if (clients[0]?.telefono_normalizado) await tx.query(
      "SELECT estado FROM pet_recurrencia_contactos WHERE local_id=? AND telefono_normalizado=? FOR SHARE",
      [localId,clients[0].telefono_normalizado]);
  }
  const [services] = await tx.query<(RowDataPacket & {servicio_id:number})[]>(
    "SELECT servicio_id FROM mascota_servicios WHERE local_id=? AND mascota_id=? ORDER BY servicio_id",[localId,turn.mascota_id]);
  for (const service of services) {
    await tx.query("SELECT activo FROM servicios WHERE local_id=? AND id=? FOR SHARE",[localId,service.servicio_id]);
    await tx.query("SELECT duracion_minutos FROM mascota_servicios WHERE local_id=? AND mascota_id=? AND servicio_id=? FOR SHARE",
      [localId,turn.mascota_id,service.servicio_id]);
  }
  await tx.query("SELECT local_id FROM pet_settings WHERE local_id=? FOR SHARE",[localId]);
  return { ...turn, nombre: pets[0]?.nombre ?? "" };
}

function target(reason: MotivoExclusionRecurrenciaPet): "pending" | "skipped" {
  return ["PROXIMA_RESERVA","AUTORIZACION_NO_VERIFICABLE"].includes(reason) ? "pending" : "skipped";
}
async function transition(tx: PoolConnection, owner: ReclamoRecurrenciaPet, next: "pending"|"skipped"|"dispatching", at: Date, reason: string) {
  const [result] = await tx.query<ResultSetHeader>(
    `UPDATE pet_recordatorios SET estado=?,claimed_at=? WHERE ${IDENTITY} AND estado='sending' AND claimed_at=?`,
    [next,next === "pending" ? null : fechaHoraSqlUtc(at),...params(owner),owner.claimKey]);
  if (result.affectedRows !== 1) return null;
  log(owner,next,reason);
  if (next !== "dispatching") return owner.claimKey;
  const [rows] = await tx.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios WHERE ${IDENTITY}`,params(owner));
  return rows[0].claim_key;
}

export async function reclamarRecurrenciaPet(
  localId: number, turnoId: number, frontendUrl: string, db: Db = pool, reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<ReclamoRecurrenciaPet|null> {
  if (!validId(localId) || !validId(turnoId)) throw new Error("PET_RECURRENCE_ID_INVALID");
  validatePetFrontendUrl(frontendUrl,"production");
  return transaction(db,async tx => {
    const context = await lockContext(tx,localId,turnoId);
    if (!context) return null;
    const at = await reloj(tx);
    const evaluation = await evaluarCicloRecurrenciaPet(tx,localId,turnoId,at);
    if (evaluation.motivo || !evaluation.row) return null;
    const row = evaluation.row;
    const [existing] = await tx.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios
      WHERE local_id=? AND tipo='RECURRENCE_DAY_30' AND mascota_id=? AND ultimo_turno_completado_id=? FOR UPDATE`,
    [localId,row.mascota_id,turnoId]);
    let id = existing[0]?.id;
    if (id && (existing[0].estado !== "pending" || existing[0].cliente_id !== row.cliente_id)) return null;
    if (!id) {
      const [created] = await tx.query<ResultSetHeader>(`INSERT INTO pet_recordatorios
        (local_id,tipo,mascota_id,ultimo_turno_completado_id,cliente_id,cliente_local_id,estado,created_at)
        VALUES (?,'RECURRENCE_DAY_30',?,?,?,?,'pending',?)`,
      [localId,row.mascota_id,turnoId,row.cliente_id,localId,fechaHoraSqlUtc(at)]);
      id = created.insertId;
    }
    const now = await reloj(tx);
    const final = contextoRecurrenciaPet(now);
    if (!final.enVentana || final.hoyArgentina !== contextoRecurrenciaPet(at).hoyArgentina) return null;
    const [updated] = await tx.query<ResultSetHeader>(`UPDATE pet_recordatorios SET estado='sending',claimed_at=?
      WHERE id=? AND local_id=? AND tipo='RECURRENCE_DAY_30' AND estado='pending'`,[fechaHoraSqlUtc(now),id,localId]);
    if (updated.affectedRows !== 1) return null;
    const [claimed] = await tx.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios
      WHERE id=? AND local_id=? AND tipo='RECURRENCE_DAY_30'`,[id,localId]);
    const owner = ownerFrom(claimed[0],localId);
    log(owner,"sending","claimed");
    return owner;
  });
}

type Validation = {kind:"ready";number:string;message:string;claimKey:string;diaArgentina:string} | {kind:"pending"|"skipped"|"not_owned"};
async function validate(owner: ReclamoRecurrenciaPet, frontendUrl: string, action: "check"|"dispatch"|"defer", db: Db, reloj: RelojRecordatorioPet,
  permitirDespacho:()=>boolean): Promise<Validation> {
  return transaction(db,async tx => {
    const context = await lockContext(tx,owner.localId,owner.ultimoTurnoId);
    const [rows] = await tx.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios
      WHERE ${IDENTITY} AND estado='sending' AND claimed_at=? FOR UPDATE`,[...params(owner),owner.claimKey]);
    if (!rows.length || rows[0].cliente_id !== owner.clienteId) return {kind:"not_owned"};
    const at = await reloj(tx);
    const evaluation = await evaluarCicloRecurrenciaPet(tx,owner.localId,owner.ultimoTurnoId,at);
    const row = evaluation.row;
    const reason = evaluation.motivo ?? (!context || row?.mascota_id !== owner.mascotaId
      || row?.cliente_id !== owner.clienteId ? "RESPONSABLE_NO_VINCULADO" : null);
    if (reason) {
      const next = target(reason);
      return await transition(tx,owner,next,at,reason) ? {kind:next} : {kind:"not_owned"};
    }
    const now = await reloj(tx);
    if (!contextoRecurrenciaPet(now).enVentana || contextoRecurrenciaPet(now).hoyArgentina !== contextoRecurrenciaPet(at).hoyArgentina) {
      return await transition(tx,owner,"skipped",now,"window_expired") ? {kind:"skipped"} : {kind:"not_owned"};
    }
    const message = buildPetRecurrenceReminder({mascotaNombre:context!.nombre,slug:row!.slug!,frontendUrl});
    const number = evolutionNumberFromE164(row!.telefono_normalizado!);
    if (action === "defer") return await transition(tx,owner,"pending",now,"preflight_unavailable") ? {kind:"pending"} : {kind:"not_owned"};
    if (action === "dispatch" && !permitirDespacho()) {
      return await transition(tx,owner,"pending",now,"pilot_disabled") ? {kind:"pending"} : {kind:"not_owned"};
    }
    const claimKey = action === "dispatch" ? await transition(tx,owner,"dispatching",now,"send_authorized") : owner.claimKey;
    return claimKey ? {kind:"ready",number,message,claimKey,diaArgentina:contextoRecurrenciaPet(now).hoyArgentina} : {kind:"not_owned"};
  });
}

async function finish(owner: ReclamoRecurrenciaPet, claimKey: string, receipt: string|null, db: Db, reason?: string): Promise<Resultado> {
  const next = receipt === null ? "unknown" : "sent";
  const [result] = await db.query<ResultSetHeader>(`UPDATE pet_recordatorios SET estado=?,
    accepted_at=${receipt === null ? "NULL" : "UTC_TIMESTAMP(3)"},provider_message_id=?
    WHERE ${IDENTITY} AND estado='dispatching' AND claimed_at=?`,[next,receipt,...params(owner),claimKey]);
  if (result.affectedRows !== 1) return "unknown";
  log(owner,next,reason ?? (receipt === null ? "provider_ambiguous" : "provider_accepted"));
  return next;
}

export async function procesarRecurrenciaPet(
  owner: ReclamoRecurrenciaPet, opciones: {frontendUrl:string;provider:ProveedorRecurrenciaPet;permitirDespacho?:()=>boolean},
  db: Db = pool, reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<Resultado> {
  const provider=opciones.provider;
  const simulated=!!provider && "simulated" in provider && provider.simulated === true;
  if (!provider || !(simulated || "kind" in provider && provider.kind === "pet_receipt")
    || typeof provider.connection !== "function" || typeof provider.send !== "function") {
    throw new Error("PET_RECURRENCE_PROVIDER_REQUIRED");
  }
  const permitirDespacho=opciones.permitirDespacho ?? (()=>true);
  validatePetFrontendUrl(opciones.frontendUrl,"production");
  if (![owner.id,owner.localId,owner.mascotaId,owner.ultimoTurnoId].every(validId) || !owner.claimKey) return "not_owned";
  const first = await validate(owner,opciones.frontendUrl,"check",db,reloj,permitirDespacho);
  if (first.kind !== "ready") return first.kind;
  let state: string;
  try { state = await provider.connection(String(owner.localId)); } catch { state = "unavailable"; }
  const final = await validate(owner,opciones.frontendUrl,state === "open" ? "dispatch" : "defer",db,reloj,permitirDespacho);
  if (final.kind !== "ready") return final.kind;
  try {
    // A delayed COMMIT reply must not move the POST to D31 or outside the operational window.
    // Authorization is already committed: any abort from here stays terminal, never pending.
    const connection = await db.getConnection();
    let current: ReturnType<typeof contextoRecurrenciaPet>;
    let owned = false;
    try {
      const [authorized] = await connection.query<RowDataPacket[]>(`SELECT id FROM pet_recordatorios
        WHERE ${IDENTITY} AND estado='dispatching' AND claimed_at=?`,[...params(owner),final.claimKey]);
      owned = authorized.length === 1;
      current = contextoRecurrenciaPet(await reloj(connection));
    } finally { connection.release(); }
    if (!owned) return "unknown"; // Recovery already closed this authorization; no late first POST.
    if (!current.enVentana || current.hoyArgentina !== final.diaArgentina) {
      return await finish(owner,final.claimKey,null,db,"window_closed_after_authorization");
    }
    if (!permitirDespacho()) return await finish(owner,final.claimKey,null,db,"pilot_disabled_after_authorization");
    const response = await provider.send(final.number,final.message,String(owner.localId));
    const receipt=simulated ? reciboRecurrenciaSimulado(response)
      : typeof response === "string" && response.length > 0 && response.length <= 255 ? response : null;
    return await finish(owner,final.claimKey,receipt,db);
  } catch {
    try { return await finish(owner,final.claimKey,null,db); } catch { return "unknown"; }
  }
}

/** Bounded and tenant-scoped. A possibly dispatched claim can ONLY become unknown. */
export async function recuperarRecurrenciaPet(
  opciones: {localId:number;frontendUrl:string}, db: Db = pool, reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
) {
  if (!validId(opciones.localId)) throw new Error("PET_RECURRENCE_ID_INVALID");
  validatePetFrontendUrl(opciones.frontendUrl,"production");
  const connection = await db.getConnection();
  let candidates: Row[];
  try {
    const cutoff = fechaHoraSqlUtc(new Date((await reloj(connection)).getTime()-PET_RECURRENCE_STALE_MS));
    [candidates] = await connection.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios
      WHERE local_id=? AND tipo='RECURRENCE_DAY_30' AND estado IN ('sending','dispatching') AND claimed_at < ?
      ORDER BY id LIMIT 100`,[opciones.localId,cutoff]);
  } finally { connection.release(); }
  const results = {pending:0,skipped:0,unknown:0};
  for (const row of candidates) {
    const owner = ownerFrom(row,opciones.localId);
    const next = await transaction(db,async tx => {
      await lockContext(tx,owner.localId,owner.ultimoTurnoId);
      const now = await reloj(tx);
      const cutoff = fechaHoraSqlUtc(new Date(now.getTime()-PET_RECURRENCE_STALE_MS));
      const [owned] = await tx.query<Row[]>(`SELECT ${projection} FROM pet_recordatorios
        WHERE ${IDENTITY} AND estado=? AND claimed_at=? AND claimed_at < ? FOR UPDATE`,[...params(owner),row.estado,owner.claimKey,cutoff]);
      if (!owned.length) return null;
      if (row.estado === "dispatching") {
        const [updated] = await tx.query<ResultSetHeader>(`UPDATE pet_recordatorios SET estado='unknown'
          WHERE ${IDENTITY} AND estado='dispatching' AND claimed_at=?`,[...params(owner),owner.claimKey]);
        if (updated.affectedRows !== 1) return null;
        log(owner,"unknown","stale_after_authorization");
        return "unknown" as const;
      }
      const evaluation = await evaluarCicloRecurrenciaPet(tx,owner.localId,owner.ultimoTurnoId,await reloj(tx));
      const recipientChanged = evaluation.row?.cliente_id !== owner.clienteId;
      const next = recipientChanged ? "skipped" : evaluation.motivo ? target(evaluation.motivo) : "pending";
      return await transition(tx,owner,next,now,"stale_before_http") ? next : null;
    });
    if (next) results[next]++;
  }
  return results;
}
