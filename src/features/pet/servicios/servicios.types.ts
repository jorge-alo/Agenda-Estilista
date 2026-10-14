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
