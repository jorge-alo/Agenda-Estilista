export const PET_LOGIN_PURPOSE = "PET_PUBLIC_LOGIN";

export class PetSessionRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function validateSessionPhone(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PetSessionRequestError(400, "PET_SESSION_REQUEST_INVALID_BODY");
  }
  const data = body as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || !Object.prototype.hasOwnProperty.call(data, "telefono") ||
      typeof data.telefono !== "string" || !data.telefono.trim() || data.telefono.length > 50) {
    throw new PetSessionRequestError(400, "PET_SESSION_REQUEST_INVALID_BODY");
  }
  return data.telefono;
}
