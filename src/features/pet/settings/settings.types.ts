export type HighDemandRule = "MIN_GAP" | "MAX_PER_DAY";

export interface PetSettings {
  configured: boolean;
  highDemandRule: HighDemandRule | null;
  highDemandGapMinutes: number | null;
  highDemandMaxPerDay: number | null;
}

export interface PetSettingsPayload {
  highDemandRule: HighDemandRule;
  highDemandGapMinutes: number | null;
  highDemandMaxPerDay: number | null;
}

export class PetSettingsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const CAMPOS = ["highDemandRule", "highDemandGapMinutes", "highDemandMaxPerDay"] as const;

function enteroPositivo(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function validarPayload(body: unknown): PetSettingsPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetSettingsError(400, "Payload inválido");
  }
  const p = body as Record<string, unknown>;
  if (Object.keys(p).some(key => !CAMPOS.includes(key as typeof CAMPOS[number]))) {
    throw new PetSettingsError(400, "Campos no permitidos");
  }
  if (!CAMPOS.every(campo => campo in p)) {
    throw new PetSettingsError(400, "Faltan campos obligatorios");
  }
  const rule = p.highDemandRule;
  if (rule !== "MIN_GAP" && rule !== "MAX_PER_DAY") {
    throw new PetSettingsError(400, "highDemandRule inválido");
  }
  const gap = p.highDemandGapMinutes;
  const max = p.highDemandMaxPerDay;
  if (rule === "MIN_GAP") {
    if (gap !== null && !enteroPositivo(gap)) {
      throw new PetSettingsError(400, "highDemandGapMinutes debe ser un entero positivo compatible con INT");
    }
    if (!enteroPositivo(gap)) {
      throw new PetSettingsError(400, "highDemandGapMinutes es obligatorio para MIN_GAP");
    }
    if (max !== null) {
      throw new PetSettingsError(400, "highDemandMaxPerDay debe ser null para MIN_GAP");
    }
    return { highDemandRule: "MIN_GAP", highDemandGapMinutes: gap, highDemandMaxPerDay: null };
  }
  if (gap !== null) {
    throw new PetSettingsError(400, "highDemandGapMinutes debe ser null para MAX_PER_DAY");
  }
  if (max !== null && !enteroPositivo(max)) {
    throw new PetSettingsError(400, "highDemandMaxPerDay debe ser un entero positivo compatible con INT");
  }
  if (!enteroPositivo(max)) {
    throw new PetSettingsError(400, "highDemandMaxPerDay es obligatorio para MAX_PER_DAY");
  }
  return { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: max };
}
