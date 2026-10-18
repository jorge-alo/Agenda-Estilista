export interface Bloqueo {
  id: number;
  fecha: string;
  hora_inicio: string | null;
  hora_fin: string | null;
  motivo: string | null;
  es_dia_completo: number;
}

export interface BloqueoPayload {
  fecha?: string;
  esDiaCompleto?: boolean;
  horaInicio?: string | null;
  horaFin?: string | null;
  motivo?: string | null;
}

export class BloqueoError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function validarId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 2147483647) throw new BloqueoError(400, "ID inválido");
  return Number(value);
}

function fechaValida(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new BloqueoError(400, "Fecha inválida: usar YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new BloqueoError(400, "Fecha inexistente");
  return value;
}

function hora(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(value)) throw new BloqueoError(400, "Hora inválida: usar HH:mm");
  return `${value.slice(0, 5)}:00`;
}

export function validarPayload(body: unknown, crear: boolean): BloqueoPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BloqueoError(400, "Payload inválido");
  const p = body as Record<string, unknown>;
  const campos = ["fecha", "esDiaCompleto", "horaInicio", "horaFin", "motivo"];
  if (!Object.keys(p).length || Object.keys(p).some(key => !campos.includes(key))) throw new BloqueoError(400, "Campos inválidos");
  const result: BloqueoPayload = {};
  if (crear || "fecha" in p) result.fecha = fechaValida(p.fecha);
  if (crear || "esDiaCompleto" in p) {
    if (typeof p.esDiaCompleto !== "boolean") throw new BloqueoError(400, "esDiaCompleto debe ser boolean");
    result.esDiaCompleto = p.esDiaCompleto;
  }
  if ("horaInicio" in p) result.horaInicio = hora(p.horaInicio);
  if ("horaFin" in p) result.horaFin = hora(p.horaFin);
  if ("motivo" in p) {
    if (p.motivo !== null && (typeof p.motivo !== "string" || [...p.motivo.trim()].length > 255)) throw new BloqueoError(400, "motivo debe ser texto de hasta 255 caracteres o null");
    result.motivo = typeof p.motivo === "string" ? p.motivo.trim() || null : null;
  }
  if (crear) reconstruir(result);
  return result;
}

export function reconstruir(p: BloqueoPayload, actual?: Bloqueo): Omit<Bloqueo, "id"> {
  const fecha = p.fecha ?? actual?.fecha;
  const completo = p.esDiaCompleto ?? (actual ? actual.es_dia_completo === 1 : undefined);
  if (fecha === undefined || completo === undefined) throw new BloqueoError(400, "Bloqueo incompleto");
  let inicio = p.horaInicio !== undefined ? p.horaInicio : actual?.hora_inicio ?? null;
  let fin = p.horaFin !== undefined ? p.horaFin : actual?.hora_fin ?? null;
  if (completo) {
    if ((p.horaInicio !== undefined && p.horaInicio !== null) || (p.horaFin !== undefined && p.horaFin !== null)) throw new BloqueoError(400, "Día completo no admite horas");
    inicio = null;
    fin = null;
  } else if (inicio === null || fin === null || inicio >= fin) {
    throw new BloqueoError(400, "Bloqueo parcial requiere ambas horas y horaInicio menor que horaFin");
  }
  return { fecha, es_dia_completo: Number(completo), hora_inicio: inicio, hora_fin: fin, motivo: p.motivo !== undefined ? p.motivo : actual?.motivo ?? null };
}

export function validarRango(query: { desde?: unknown; hasta?: unknown }): { desde?: string; hasta?: string } {
  if (query.desde === undefined && query.hasta === undefined) return {};
  if (query.desde === undefined || query.hasta === undefined) throw new BloqueoError(400, "Enviar desde y hasta juntos");
  const desde = fechaValida(query.desde);
  const hasta = fechaValida(query.hasta);
  if (desde > hasta) throw new BloqueoError(400, "Rango de fechas invertido");
  return { desde, hasta };
}
