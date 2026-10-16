import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { calcularDuracionTotal, calcularSlotsDisponibles, horaAMinutos, minutosAHora } from "./disponibilidad.engine";
import type { AvailabilityBlock, AvailableInterval, HighDemandSettings, MinuteInterval } from "./disponibilidad.types";

const INT_MAX = 2147483647;
const TIME_ZONE = "America/Argentina/Buenos_Aires";

export class DisponibilidadPetError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConsultaDisponibilidadPet {
  mascotaId: number;
  servicioId: number;
  fecha: string;
  extraIds: number[];
}

export interface RespuestaDisponibilidadPet {
  fecha: string;
  duracionMinutos: number;
  slots: Array<{ horaInicio: string; horaFin: string }>;
}

interface MascotaRow extends RowDataPacket {
  id: number;
  activo: number;
  alta_exigencia: number;
}

interface ServicioRow extends RowDataPacket {
  id: number;
  activo: number | null;
}

interface DuracionRow extends RowDataPacket {
  duracion_minutos: number;
}

interface ExtraRow extends RowDataPacket {
  id: number;
  activo: number;
  duracion_minutos: number | null;
}

interface SettingsRow extends RowDataPacket {
  high_demand_rule: "MIN_GAP" | "MAX_PER_DAY";
  high_demand_gap_minutes: number | null;
  high_demand_max_per_day: number | null;
}

interface HorarioRow extends RowDataPacket {
  hora_inicio: string;
  hora_fin: string;
}

interface BloqueoRow extends RowDataPacket {
  es_dia_completo: number | null;
  hora_inicio: string | null;
  hora_fin: string | null;
}

interface TurnoPetRow extends RowDataPacket {
  hora: string;
  hora_fin: string | null;
  estado: "activo" | "pendiente_pago" | "cancelado" | "completado" | null;
  alta_exigencia_snapshot: number | null;
}

interface ContextoTemporalArgentina {
  fecha: string;
  minimumStartMinutes: number;
}

function errorIntegridad(message: string): DisponibilidadPetError {
  return new DisponibilidadPetError(500, "PET_AVAILABILITY_INTEGRITY_ERROR", message);
}

function numeroEnteroPositivo(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > INT_MAX) {
    throw errorIntegridad(`Valor almacenado inválido para ${label}`);
  }
  return value;
}

function partesArgentina(ahora: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(ahora)
    .filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

/** Produces Argentina-local date and a minute ceiling without using the host timezone. */
export function contextoTemporalArgentina(ahora: Date = new Date()): ContextoTemporalArgentina {
  const parts = partesArgentina(ahora);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const minimumStartMinutes = Number(parts.hour) * 60 + minute + (second > 0 ? 1 : 0);
  return {
    fecha: `${parts.year}-${parts.month}-${parts.day}`,
    minimumStartMinutes,
  };
}

function parsearHoraDb(value: string | null, campo: string): number {
  if (typeof value !== "string") throw errorIntegridad(`${campo} PET está vacío o no es TIME`);
  try {
    return horaAMinutos(value);
  } catch {
    throw errorIntegridad(`${campo} PET no puede normalizarse a minutos enteros`);
  }
}

function intervaloDb(start: string | null, end: string | null, campo: string): MinuteInterval {
  const startMinutes = parsearHoraDb(start, `${campo}.hora_inicio`);
  const endMinutes = parsearHoraDb(end, `${campo}.hora_fin`);
  if (startMinutes >= endMinutes) throw errorIntegridad(`${campo} PET debe terminar después de comenzar`);
  return { startMinutes, endMinutes };
}

function traducirSettings(row: SettingsRow): HighDemandSettings {
  if (row.high_demand_rule === "MIN_GAP") {
    if (row.high_demand_gap_minutes === null) throw errorIntegridad("pet_settings MIN_GAP carece de gap");
    return { rule: "MIN_GAP", gapMinutes: numeroEnteroPositivo(row.high_demand_gap_minutes, "high_demand_gap_minutes") };
  }
  if (row.high_demand_rule === "MAX_PER_DAY") {
    if (row.high_demand_max_per_day === null) throw errorIntegridad("pet_settings MAX_PER_DAY carece de máximo");
    return { rule: "MAX_PER_DAY", maxPerDay: numeroEnteroPositivo(row.high_demand_max_per_day, "high_demand_max_per_day") };
  }
  throw errorIntegridad("Regla almacenada desconocida en pet_settings");
}

async function obtenerHorarios(localId: number, diaSemana: number): Promise<MinuteInterval[]> {
  const [rows] = await pool.query<HorarioRow[]>(
    `SELECT hora_inicio, hora_fin
     FROM horarios_local
     WHERE local_id = ? AND dia_semana = ? AND activo = 1
     ORDER BY hora_inicio, id`,
    [localId, diaSemana],
  );
  return rows.map((row, index) => intervaloDb(row.hora_inicio, row.hora_fin, `horarios_local[${index}]`));
}

async function obtenerBloqueos(localId: number, fecha: string): Promise<AvailabilityBlock[]> {
  const [rows] = await pool.query<BloqueoRow[]>(
    `SELECT es_dia_completo, hora_inicio, hora_fin
     FROM bloqueos_local
     WHERE local_id = ? AND fecha = ?
     ORDER BY hora_inicio, id`,
    [localId, fecha],
  );
  return rows.map((row, index) => {
    if (row.es_dia_completo === 1) return { kind: "FULL_DAY" };
    if (row.es_dia_completo !== 0) throw errorIntegridad(`bloqueos_local[${index}].es_dia_completo inválido`);
    return { kind: "PARTIAL", ...intervaloDb(row.hora_inicio, row.hora_fin, `bloqueos_local[${index}]`) };
  });
}

async function obtenerTurnosPet(localId: number, fecha: string): Promise<{
  occupiedIntervals: MinuteInterval[];
  highDemandIntervals: MinuteInterval[];
  highDemandCount: number;
}> {
  const [rows] = await pool.query<TurnoPetRow[]>(
    `SELECT hora, hora_fin, estado, alta_exigencia_snapshot
     FROM turnos
     WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL`,
    [localId, fecha],
  );
  const occupiedIntervals: MinuteInterval[] = [];
  const highDemandIntervals: MinuteInterval[] = [];
  let highDemandCount = 0;

  for (const [index, row] of rows.entries()) {
    if (!["activo", "pendiente_pago", "cancelado", "completado"].includes(row.estado ?? "")) {
      throw errorIntegridad(`turnos PET[${index}] tiene estado inválido`);
    }
    if (row.alta_exigencia_snapshot !== 0 && row.alta_exigencia_snapshot !== 1) {
      throw errorIntegridad(`turnos PET[${index}] carece de snapshot de alta exigencia`);
    }
    if (row.estado === "cancelado") continue;

    // The schema requires hora_fin for every PET row. Keep a runtime guard for legacy/corrupt rows.
    const interval = intervaloDb(row.hora, row.hora_fin, `turnos PET[${index}]`);
    if (row.estado === "activo" || row.estado === "pendiente_pago") occupiedIntervals.push(interval);
    if (row.alta_exigencia_snapshot === 1) {
      highDemandCount += 1;
      highDemandIntervals.push(interval);
    }
  }
  return { occupiedIntervals, highDemandIntervals, highDemandCount };
}

function formatearSlots(slots: AvailableInterval[]): Array<{ horaInicio: string; horaFin: string }> {
  return slots.map(slot => ({
    horaInicio: minutosAHora(slot.startMinutes),
    horaFin: minutosAHora(slot.endMinutes),
  }));
}

export async function obtenerDisponibilidad(
  localId: number,
  consulta: ConsultaDisponibilidadPet,
): Promise<RespuestaDisponibilidadPet> {
  const [mascotas] = await pool.query<MascotaRow[]>(
    "SELECT id, activo, alta_exigencia FROM mascotas WHERE id = ? AND local_id = ?",
    [consulta.mascotaId, localId],
  );
  if (!mascotas.length) throw new DisponibilidadPetError(404, "PET_MASCOTA_NOT_FOUND", "Mascota no encontrada");
  const mascota = mascotas[0];
  if (mascota.activo !== 1) throw new DisponibilidadPetError(409, "PET_MASCOTA_INACTIVA", "La mascota no está activa para nuevas reservas");
  if (mascota.alta_exigencia !== 0 && mascota.alta_exigencia !== 1) throw errorIntegridad("mascotas.alta_exigencia tiene un valor inválido");

  const [servicios] = await pool.query<ServicioRow[]>(
    "SELECT id, activo FROM servicios WHERE id = ? AND local_id = ?",
    [consulta.servicioId, localId],
  );
  if (!servicios.length) throw new DisponibilidadPetError(404, "PET_SERVICIO_NOT_FOUND", "Servicio no encontrado");
  if (servicios[0].activo !== 1) throw new DisponibilidadPetError(409, "PET_SERVICIO_INACTIVO", "El servicio no está activo");

  const [relacionesServicio] = await pool.query<DuracionRow[]>(
    `SELECT duracion_minutos FROM mascota_servicios
     WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?`,
    [localId, consulta.mascotaId, consulta.servicioId],
  );
  if (!relacionesServicio.length) throw new DisponibilidadPetError(409, "PET_SERVICIO_NO_ASOCIADO", "El servicio no está habilitado para esta mascota");

  let duracionesExtras: number[] = [];
  if (consulta.extraIds.length) {
    const placeholders = consulta.extraIds.map(() => "?").join(", ");
    const [extras] = await pool.query<ExtraRow[]>(
      `SELECT e.id, e.activo, me.duracion_minutos
       FROM extras e
       LEFT JOIN mascota_extras me
         ON me.extra_id = e.id AND me.mascota_id = ? AND me.local_id = e.local_id
       WHERE e.local_id = ? AND e.id IN (${placeholders})`,
      [consulta.mascotaId, localId, ...consulta.extraIds],
    );
    if (extras.length !== consulta.extraIds.length) {
      throw new DisponibilidadPetError(404, "PET_EXTRA_NOT_FOUND", "Uno o más extras no existen en este local");
    }
    for (const extra of extras) {
      if (extra.activo !== 1) throw new DisponibilidadPetError(409, "PET_EXTRA_INACTIVO", "Uno o más extras no están activos");
      if (extra.duracion_minutos === null) throw new DisponibilidadPetError(409, "PET_EXTRA_NO_ASOCIADO", "Uno o más extras no están habilitados para esta mascota");
    }
    // MySQL IN does not preserve request order; duration addition is commutative.
    duracionesExtras = extras.map(extra => extra.duracion_minutos as number);
  }

  const duracionMinutos = calcularDuracionTotal(relacionesServicio[0].duracion_minutos, duracionesExtras);
  let settings: HighDemandSettings | null = null;
  if (mascota.alta_exigencia === 1) {
    const [rows] = await pool.query<SettingsRow[]>(
      `SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day
       FROM pet_settings WHERE local_id = ?`,
      [localId],
    );
    if (!rows.length) {
      throw new DisponibilidadPetError(409, "PET_HIGH_DEMAND_SETTINGS_REQUIRED", "El local debe configurar la regla de alta exigencia");
    }
    settings = traducirSettings(rows[0]);
  }

  const temporal = contextoTemporalArgentina();
  if (consulta.fecha < temporal.fecha) {
    return { fecha: consulta.fecha, duracionMinutos, slots: [] };
  }

  const [year, month, day] = consulta.fecha.split("-").map(Number);
  const diaSemana = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const [schedules, blocks, turns] = await Promise.all([
    obtenerHorarios(localId, diaSemana),
    obtenerBloqueos(localId, consulta.fecha),
    obtenerTurnosPet(localId, consulta.fecha),
  ]);

  const minimumStartMinutes = consulta.fecha === temporal.fecha
    ? temporal.minimumStartMinutes
    : null;
  if (minimumStartMinutes !== null && minimumStartMinutes >= 1440) {
    return { fecha: consulta.fecha, duracionMinutos, slots: [] };
  }

  const highDemand = mascota.alta_exigencia === 1
    ? settings?.rule === "MIN_GAP"
      ? { isHighDemand: true, settings, intervals: turns.highDemandIntervals }
      : { isHighDemand: true, settings, count: turns.highDemandCount }
    : { isHighDemand: false, settings: null };

  const slots = calcularSlotsDisponibles({
    schedules,
    blocks,
    durationMinutes: duracionMinutos,
    occupiedIntervals: turns.occupiedIntervals,
    minimumStartMinutes,
    highDemand,
  });

  // This GET is a snapshot only. PET-08B must revalidate under the local lock when creating a turn.
  return { fecha: consulta.fecha, duracionMinutos, slots: formatearSlots(slots) };
}
