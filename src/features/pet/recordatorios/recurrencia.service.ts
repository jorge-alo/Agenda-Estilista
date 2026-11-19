import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { validatePetFrontendUrl } from "../session/session.link";
import { publicBookingEnabled } from "../shared/publicBookingAccess";
import { PetSettingsError, validarPayload } from "../settings/settings.types";
import { relojMysqlRecordatorioPet, telefonoUtilizable, type RelojRecordatorioPet } from "./recordatorios.service";
import { contextoRecurrenciaPet, fechasRecurrenciaPet } from "./recurrencia.time";
import { prepararFuenteContactosRecurrencia } from "./recurrencia.contactos";

/** A verified source must bind permission to tenant, client AND current canonical phone. */
export interface ContactoRecurrenciaPet {
  localId: number;
  clienteId: number;
  telefonoCanonical: string;
}

export type AutorizacionRecurrenciaPet = { estado: "baja" } | (ContactoRecurrenciaPet & {
  estado: "autorizada";
  verificadaAt: string;
  referenciaVerificacion: string;
});

/** A source is always explicit permission data, never an inference from booking history. */
export type ResolverAutorizacionRecurrenciaPet = (
  contacto: ContactoRecurrenciaPet,
) => Promise<AutorizacionRecurrenciaPet | null>;

export const MOTIVOS_EXCLUSION_RECURRENCIA = [
  "D30_NO_COINCIDE", "FUERA_DE_VENTANA", "LOCAL_NO_DISPONIBLE", "ENLACE_NO_DISPONIBLE",
  "MASCOTA_NO_DISPONIBLE", "RESPONSABLE_NO_VINCULADO", "TELEFONO_INVALIDO",
  "SERVICIO_NO_DISPONIBLE", "ALTA_EXIGENCIA_SIN_CONFIGURACION", "PROXIMA_RESERVA",
  "CICLO_YA_RECLAMADO", "AUTORIZACION_PENDIENTE", "BAJA", "AUTORIZACION_NO_VERIFICABLE",
] as const;
export type MotivoExclusionRecurrenciaPet = typeof MOTIVOS_EXCLUSION_RECURRENCIA[number];

export interface ResultadoSimulacionRecurrenciaPet {
  turnoId: number;
  mascotaId: number;
  clienteId: number | null;
  d0: string;
  d30: string;
  d35: string;
  motivoExclusion: MotivoExclusionRecurrenciaPet | null;
}

export interface InformeSimulacionRecurrenciaPet {
  simulacion: true;
  localId: number;
  hoyArgentina: string;
  fechaServicioD30: string;
  enVentana: boolean;
  fuenteAutorizaciones: "persistida" | "inyectada";
  examinados: number;
  elegibles: number;
  exclusiones: Record<MotivoExclusionRecurrenciaPet, number>;
  detalles: ResultadoSimulacionRecurrenciaPet[];
  detallesTruncados: boolean;
}

interface CandidatoRow extends RowDataPacket {
  turno_id: number;
  mascota_id: number;
  cliente_id: number | null;
  fecha_servicio: string;
  local_activo: number;
  business_type: string;
  suscripcion_estado: string | null;
  suscripcion_vencimiento: string | null;
  slug: string | null;
  mascota_activa: number | null;
  reserva_online_habilitada: number | null;
  alta_exigencia: number | null;
  responsable_vinculado: number;
  telefono_normalizado: string | null;
  servicio_utilizable: number;
  high_demand_rule: string | null;
  high_demand_gap_minutes: number | null;
  high_demand_max_per_day: number | null;
  proxima_reserva: number;
  recordatorio_estado: string | null;
}

/** Pure SELECT, scoped to ONE explicit tenant; no <=, catch-up range or fallback recipient. */
const SQL_BASE = `SELECT t.id AS turno_id, t.mascota_id, t.cliente_id,
    DATE_FORMAT(t.fecha, '%Y-%m-%d') AS fecha_servicio,
    l.activo AS local_activo, l.business_type, l.suscripcion_estado,
    DATE_FORMAT(l.suscripcion_vencimiento, '%Y-%m-%d') AS suscripcion_vencimiento, l.slug,
    m.activo AS mascota_activa, m.reserva_online_habilitada, m.alta_exigencia,
    c.telefono_normalizado,
    EXISTS (SELECT 1 FROM mascota_clientes mc
      WHERE mc.local_id = t.local_id AND mc.mascota_id = t.mascota_id
        AND mc.cliente_id = t.cliente_id) AS responsable_vinculado,
    EXISTS (SELECT 1 FROM mascota_servicios ms
      JOIN servicios s ON s.id = ms.servicio_id AND s.local_id = ms.local_id
      WHERE ms.local_id = t.local_id AND ms.mascota_id = t.mascota_id
        AND s.activo = 1 AND ms.duracion_minutos > 0) AS servicio_utilizable,
    ps.high_demand_rule, ps.high_demand_gap_minutes, ps.high_demand_max_per_day,
    EXISTS (SELECT 1 FROM turnos futuro
      WHERE futuro.local_id = t.local_id AND futuro.mascota_id = t.mascota_id
        AND futuro.estado IN ('activo', 'pendiente_pago')
        AND (futuro.fecha > ? OR (futuro.fecha = ? AND futuro.hora_fin > ?))) AS proxima_reserva,
    pr.estado AS recordatorio_estado
  FROM turnos t
  JOIN locales l ON l.id = t.local_id AND l.business_type = 'PET_GROOMING'
  LEFT JOIN mascotas m ON m.id = t.mascota_id AND m.local_id = t.local_id
  LEFT JOIN clientes c ON c.id = t.cliente_id AND c.local_id = t.local_id
  LEFT JOIN pet_settings ps ON ps.local_id = t.local_id
  LEFT JOIN pet_recordatorios pr ON pr.local_id = t.local_id AND pr.tipo = 'RECURRENCE_DAY_30'
    AND pr.mascota_id = t.mascota_id AND pr.ultimo_turno_completado_id = t.id
  WHERE t.local_id = ? AND t.mascota_id IS NOT NULL AND t.estado = 'completado'
    AND t.fecha = ?
    AND NOT EXISTS (SELECT 1 FROM turnos posterior
      WHERE posterior.local_id = t.local_id AND posterior.mascota_id = t.mascota_id
        AND posterior.estado = 'completado'
        AND (posterior.fecha > t.fecha
          OR (posterior.fecha = t.fecha AND posterior.hora > t.hora)
           OR (posterior.fecha = t.fecha AND posterior.hora = t.hora AND posterior.id > t.id)))`;
const SQL_CANDIDATOS = `${SQL_BASE} AND t.id > ? ORDER BY t.id LIMIT 50`;

function exclusionTecnica(
  row: CandidatoRow, contexto: ReturnType<typeof contextoRecurrenciaPet>,
  cicloBloqueado = false,
): MotivoExclusionRecurrenciaPet | null {
  // Defense in depth: a future selector change must not turn this into overdue outreach.
  if (row.fecha_servicio !== contexto.fechaServicioD30) return "D30_NO_COINCIDE";
  if (!contexto.enVentana) return "FUERA_DE_VENTANA";
  if (!publicBookingEnabled({ activo: row.local_activo, business_type: row.business_type,
    suscripcion_estado: row.suscripcion_estado, suscripcion_vencimiento: row.suscripcion_vencimiento },
  contexto.hoyArgentina)) return "LOCAL_NO_DISPONIBLE";
  if (!row.slug?.trim()) return "ENLACE_NO_DISPONIBLE";
  if (row.mascota_activa !== 1 || row.reserva_online_habilitada !== 1) return "MASCOTA_NO_DISPONIBLE";
  if (row.cliente_id === null || row.responsable_vinculado !== 1) return "RESPONSABLE_NO_VINCULADO";
  if (!telefonoUtilizable(row.telefono_normalizado)) return "TELEFONO_INVALIDO";
  if (row.servicio_utilizable !== 1) return "SERVICIO_NO_DISPONIBLE";
  if (row.alta_exigencia !== 0 && row.alta_exigencia !== 1) return "MASCOTA_NO_DISPONIBLE";
  if (row.alta_exigencia === 1) {
    try {
      validarPayload({ highDemandRule: row.high_demand_rule,
        highDemandGapMinutes: row.high_demand_gap_minutes, highDemandMaxPerDay: row.high_demand_max_per_day });
    } catch (error) {
      if (error instanceof PetSettingsError) return "ALTA_EXIGENCIA_SIN_CONFIGURACION";
      throw error;
    }
  }
  if (row.proxima_reserva === 1) return "PROXIMA_RESERVA";
  if (!cicloBloqueado && row.recordatorio_estado !== null && row.recordatorio_estado !== "pending") return "CICLO_YA_RECLAMADO";
  return null;
}

/** Shared rules for a caller holding local/context locks; NOT itself a send authorization. */
export async function evaluarCicloRecurrenciaPet(
  reader: Pick<PoolConnection, "query">, localId: number, turnoId: number, ahoraUtc: Date,
) {
  const contexto = contextoRecurrenciaPet(ahoraUtc);
  const [rows] = await reader.query<CandidatoRow[]>(`${SQL_BASE} AND t.id = ?`,
    [contexto.hoyArgentina, contexto.hoyArgentina, contexto.horaArgentina, localId, contexto.fechaServicioD30, turnoId]);
  const row = rows[0];
  if (!row) return { row: null, motivo: "D30_NO_COINCIDE" as MotivoExclusionRecurrenciaPet };
  const motivo = exclusionTecnica(row, contexto, true)
    ?? await exclusionAutorizacion(row, localId, ahoraUtc, await prepararFuenteContactosRecurrencia(reader, localId));
  return { row, motivo };
}

export interface PaginaRecurrenciaPet {
  candidatos: {localId:number;turnoId:number}[];
  cursor: number|null;
  hayMas: boolean;
}

/** Bounded raw keyset page for the worker; never reuse the truncated simulation report. */
export async function seleccionarPaginaRecurrenciaPet(
  localId:number, cursor:number|null=null, db:Pick<Pool,"getConnection">=pool,
  reloj:RelojRecordatorioPet=relojMysqlRecordatorioPet,
):Promise<PaginaRecurrenciaPet> {
  if (!Number.isSafeInteger(localId) || localId < 1
    || cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new Error("PET_RECURRENCE_CURSOR_INVALID");
  const connection=await db.getConnection();
  let active=false;
  try {
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");active=true;
    const now=await reloj(connection);
    const context=contextoRecurrenciaPet(now);
    if (!context.enVentana) return {candidatos:[],cursor:null,hayMas:false};
    const resolver=await prepararFuenteContactosRecurrencia(connection,localId);
    const [rows]=await connection.query<CandidatoRow[]>(`${SQL_BASE}
      AND t.id > ? AND (pr.estado IS NULL OR pr.estado='pending') ORDER BY t.id LIMIT 50`,
    [context.hoyArgentina,context.hoyArgentina,context.horaArgentina,localId,context.fechaServicioD30,cursor??0]);
    const candidatos:PaginaRecurrenciaPet["candidatos"]=[];
    for (const row of rows) {
      const reason=exclusionTecnica(row,context) ?? await exclusionAutorizacion(row,localId,now,resolver);
      if (!reason) candidatos.push({localId,turnoId:row.turno_id});
    }
    return {candidatos,cursor:rows[rows.length-1]?.turno_id??null,hayMas:rows.length===50};
  } finally {
    try {if(active)await connection.rollback();} catch(error){connection.destroy();throw error;}
    connection.release();
  }
}

async function exclusionAutorizacion(
  row: CandidatoRow, localId: number, ahoraUtc: Date, resolver?: ResolverAutorizacionRecurrenciaPet,
): Promise<MotivoExclusionRecurrenciaPet | null> {
  if (!resolver) return "AUTORIZACION_PENDIENTE";
  const contacto = { localId, clienteId: row.cliente_id!, telefonoCanonical: row.telefono_normalizado! };
  try {
    const permiso = await resolver(contacto);
    if (permiso === null) return "AUTORIZACION_PENDIENTE";
    if (permiso.estado === "baja") return "BAJA";
    const verificada = new Date(permiso.verificadaAt);
    if (permiso.estado !== "autorizada" || permiso.localId !== localId
      || permiso.clienteId !== contacto.clienteId || permiso.telefonoCanonical !== contacto.telefonoCanonical
      || !permiso.referenciaVerificacion?.trim() || !Number.isFinite(verificada.getTime())
      || verificada.toISOString() !== permiso.verificadaAt || verificada > ahoraUtc) {
      return "AUTORIZACION_NO_VERIFICABLE";
    }
    return null;
  } catch {
    // Fail closed without propagating phone, evidence, SQL or upstream error content.
    return "AUTORIZACION_NO_VERIFICABLE";
  }
}

/**
 * Read-only snapshot, NOT an authorization to dispatch a message.
 * No claims, provider imports, tokens, scheduler or consent writes.
 */
export async function simularRecurrenciaPet(
  opciones: { localId: number; frontendUrl: string; resolverAutorizacion?: ResolverAutorizacionRecurrenciaPet },
  db: Pick<Pool, "getConnection"> = pool,
  reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<InformeSimulacionRecurrenciaPet> {
  if (!Number.isSafeInteger(opciones.localId) || opciones.localId < 1) throw new Error("PET_RECURRENCE_LOCAL_INVALID");
  // Reuse public access URL validation; never assume a domain or create credentials.
  validatePetFrontendUrl(opciones.frontendUrl, "production");
  const connection = await db.getConnection();
  let started = false;
  try {
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    started = true;
    const ahoraUtc = await reloj(connection);
    const contexto = contextoRecurrenciaPet(ahoraUtc);
    const resolver = opciones.resolverAutorizacion
      ?? await prepararFuenteContactosRecurrencia(connection, opciones.localId);
    const report: InformeSimulacionRecurrenciaPet = {
      simulacion: true, localId: opciones.localId, hoyArgentina: contexto.hoyArgentina,
      fechaServicioD30: contexto.fechaServicioD30, enVentana: contexto.enVentana,
      fuenteAutorizaciones: opciones.resolverAutorizacion ? "inyectada" : "persistida",
      examinados: 0, elegibles: 0,
      exclusiones: Object.fromEntries(MOTIVOS_EXCLUSION_RECURRENCIA.map(reason => [reason, 0])) as InformeSimulacionRecurrenciaPet["exclusiones"],
      detalles: [], detallesTruncados: false,
    };
    let ultimoId = 0;
    for (;;) {
      const [rows] = await connection.query<CandidatoRow[]>(SQL_CANDIDATOS,
        [contexto.hoyArgentina, contexto.hoyArgentina, contexto.horaArgentina,
          opciones.localId, contexto.fechaServicioD30, ultimoId]);
      for (const row of rows) {
        const motivoExclusion = exclusionTecnica(row, contexto)
          ?? await exclusionAutorizacion(row, opciones.localId, ahoraUtc, resolver);
        report.examinados++;
        if (motivoExclusion) report.exclusiones[motivoExclusion]++;
        else report.elegibles++;
        if (report.detalles.length < 100) report.detalles.push({ turnoId: row.turno_id,
          mascotaId: row.mascota_id, clienteId: row.cliente_id,
          ...fechasRecurrenciaPet(row.fecha_servicio), motivoExclusion });
        else report.detallesTruncados = true;
      }
      if (rows.length < 50) return report;
      ultimoId = rows[rows.length - 1].turno_id;
    }
  } finally {
    try { if (started) await connection.rollback(); }
    catch (error) {
      connection.destroy(); // Never return an abandoned read-only transaction to the shared pool.
      throw error;
    }
    connection.release();
  }
}
