export interface PetDepositSettingsWrite {
  pet_deposit_enabled: boolean;
  pet_deposit_amount: string | null;
}

export interface PetDepositSettings extends PetDepositSettingsWrite {
  currency: "ARS";
  mpConfigured: boolean;
}

export class PetDepositSettingsError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function validarPayload(body: unknown): PetDepositSettingsWrite {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetDepositSettingsError(400, "PET_DEPOSIT_INVALID_PAYLOAD");
  }
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || !Object.prototype.hasOwnProperty.call(fields, "pet_deposit_enabled")
    || !Object.prototype.hasOwnProperty.call(fields, "pet_deposit_amount")) {
    throw new PetDepositSettingsError(400, "PET_DEPOSIT_INVALID_PAYLOAD");
  }
  const enabled = fields.pet_deposit_enabled;
  const amount = fields.pet_deposit_amount;
  if (typeof enabled !== "boolean" || (amount !== null
    && (typeof amount !== "string" || !/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(amount)
      || amount === "0.00")) || (enabled && amount === null)) {
    throw new PetDepositSettingsError(400, "PET_DEPOSIT_INVALID_PAYLOAD");
  }
  return { pet_deposit_enabled: enabled, pet_deposit_amount: amount as string | null };
}
