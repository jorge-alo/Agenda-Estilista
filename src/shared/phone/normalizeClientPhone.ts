import { parsePhoneNumberWithError } from "libphonenumber-js/max";

export class InvalidClientPhoneError extends Error {
  readonly code = "CLIENT_PHONE_INVALID";

  constructor() {
    super("El teléfono no es válido");
    this.name = "InvalidClientPhoneError";
  }
}

export function normalizeClientPhone(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new InvalidClientPhoneError();
  }

  try {
    const phone = parsePhoneNumberWithError(input.trim(), {
      defaultCountry: "AR",
      extract: false,
    });
    if (!phone.isValid()) throw new InvalidClientPhoneError();
    return phone.number;
  } catch (error) {
    if (error instanceof InvalidClientPhoneError) throw error;
    throw new InvalidClientPhoneError();
  }
}
