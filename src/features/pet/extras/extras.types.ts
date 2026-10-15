export interface Extra {
  id: number;
  nombre: string;
  activo: number;
}

export interface ExtraConfigurado extends Extra {
  duracion_minutos: number;
}

export interface EditarExtraPayload {
  nombre?: string;
  activo?: boolean;
}

export class PetExtraError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function enteroPositivo(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function validarId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !enteroPositivo(Number(value))) {
    throw new PetExtraError(400, "ID inválido");
  }
  return Number(value);
}

function validarCampos(body: unknown, permitidos: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetExtraError(400, "Payload inválido");
  }
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some(key => !permitidos.includes(key))) {
    throw new PetExtraError(400, "Campos no permitidos");
  }
  return payload;
}

function validarNombre(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 100) {
    throw new PetExtraError(400, "nombre debe contener entre 1 y 100 caracteres");
  }
  return value.trim();
}

export function validarCrearExtra(body: unknown): { nombre: string } {
  const payload = validarCampos(body, ["nombre"]);
  return { nombre: validarNombre(payload.nombre) };
}

export function validarEditarExtra(body: unknown): EditarExtraPayload {
  const payload = validarCampos(body, ["nombre", "activo"]);
  if (!Object.keys(payload).length) throw new PetExtraError(400, "No hay campos para actualizar");
  const result: EditarExtraPayload = {};
  if ("nombre" in payload) result.nombre = validarNombre(payload.nombre);
  if ("activo" in payload) {
    if (typeof payload.activo !== "boolean") throw new PetExtraError(400, "activo debe ser boolean");
    result.activo = payload.activo;
  }
  return result;
}

function validarMinutos(value: unknown): number {
  if (!enteroPositivo(value)) {
    throw new PetExtraError(400, "duracionMinutos debe ser un entero positivo compatible con INT");
  }
  return value;
}

export function validarAsociacion(body: unknown): { extraId: number; duracionMinutos: number } {
  const payload = validarCampos(body, ["extraId", "duracionMinutos"]);
  if (!enteroPositivo(payload.extraId)) throw new PetExtraError(400, "extraId inválido");
  return { extraId: payload.extraId, duracionMinutos: validarMinutos(payload.duracionMinutos) };
}

export function validarDuracion(body: unknown): { duracionMinutos: number } {
  const payload = validarCampos(body, ["duracionMinutos"]);
  return { duracionMinutos: validarMinutos(payload.duracionMinutos) };
}
