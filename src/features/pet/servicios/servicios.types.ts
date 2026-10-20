export interface ServicioCatalogo {
  id: number;
  nombre: string;
  activo: 0 | 1;
}

export interface EditarServicioPayload {
  nombre?: string;
  activo?: boolean;
}

export class PetServicioError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function enteroPositivo(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function validarId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !enteroPositivo(Number(value))) {
    throw new PetServicioError(400, "ID inválido");
  }
  return Number(value);
}

function validarCamposCatalogo(body: unknown, permitidos: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetServicioError(400, "Payload inválido");
  }
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some(key => !permitidos.includes(key))) {
    throw new PetServicioError(400, "Campos no permitidos");
  }
  return payload;
}

function validarNombre(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 100) {
    throw new PetServicioError(400, "nombre debe contener entre 1 y 100 caracteres");
  }
  return value.trim();
}

export function validarCrearServicio(body: unknown): { nombre: string } {
  const payload = validarCamposCatalogo(body, ["nombre"]);
  return { nombre: validarNombre(payload.nombre) };
}

export function validarEditarServicio(body: unknown): EditarServicioPayload {
  const payload = validarCamposCatalogo(body, ["nombre", "activo"]);
  if (!Object.keys(payload).length) throw new PetServicioError(400, "No hay campos para actualizar");
  const result: EditarServicioPayload = {};
  if ("nombre" in payload) result.nombre = validarNombre(payload.nombre);
  if ("activo" in payload) {
    if (typeof payload.activo !== "boolean") throw new PetServicioError(400, "activo debe ser boolean");
    result.activo = payload.activo;
  }
  return result;
}

export function validarDuracion(body: unknown, crear = false): { duracionMinutos: number; servicioId?: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetServicioError(400, "Payload inválido");
  }
  const payload = body as Record<string, unknown>;
  const permitidos = crear ? ["servicioId", "duracionMinutos"] : ["duracionMinutos"];
  if (Object.keys(payload).some(key => !permitidos.includes(key))) {
    throw new PetServicioError(400, "Campos no permitidos");
  }
  if (!enteroPositivo(payload.duracionMinutos)) {
    throw new PetServicioError(400, "duracionMinutos debe ser un entero positivo compatible con INT");
  }
  if (crear && !enteroPositivo(payload.servicioId)) {
    throw new PetServicioError(400, "servicioId debe ser un entero positivo compatible con INT");
  }
  return { duracionMinutos: payload.duracionMinutos, servicioId: crear ? payload.servicioId as number : undefined };
}
