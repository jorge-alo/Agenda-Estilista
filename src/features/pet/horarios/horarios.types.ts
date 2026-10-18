export interface Horario {
  id: number;
  dia_semana: number;
  hora_inicio: string;
  hora_fin: string;
  activo: number;
}

export interface HorarioPayload {
  diaSemana?: number;
  horaInicio?: string;
  horaFin?: string;
  activo?: boolean;
}

export class HorarioError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function validarId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 2147483647) {
    throw new HorarioError(400, "ID inválido");
  }
  return Number(value);
}

function hora(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(value)) {
    throw new HorarioError(400, "Hora inválida: usar HH:mm");
  }
  return `${value.slice(0, 5)}:00`;
}

export function validarIntervalo(inicio: string, fin: string): void {
  if (inicio >= fin) throw new HorarioError(400, "horaInicio debe ser menor que horaFin dentro del mismo día");
}

export function validarPayload(body: unknown, crear: boolean): HorarioPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HorarioError(400, "Payload inválido");
  const p = body as Record<string, unknown>;
  const campos = crear ? ["diaSemana", "horaInicio", "horaFin"] : ["diaSemana", "horaInicio", "horaFin", "activo"];
  if (!Object.keys(p).length || Object.keys(p).some(key => !campos.includes(key))) throw new HorarioError(400, "Campos inválidos");
  const result: HorarioPayload = {};
  if (crear || "diaSemana" in p) {
    if (typeof p.diaSemana !== "number" || !Number.isInteger(p.diaSemana) || p.diaSemana < 0 || p.diaSemana > 6) throw new HorarioError(400, "diaSemana debe ser entero entre 0 y 6");
    result.diaSemana = p.diaSemana;
  }
  if (crear || "horaInicio" in p) result.horaInicio = hora(p.horaInicio);
  if (crear || "horaFin" in p) result.horaFin = hora(p.horaFin);
  if ("activo" in p) {
    if (typeof p.activo !== "boolean") throw new HorarioError(400, "activo debe ser boolean");
    result.activo = p.activo;
  }
  if (result.horaInicio !== undefined && result.horaFin !== undefined) validarIntervalo(result.horaInicio, result.horaFin);
  return result;
}
