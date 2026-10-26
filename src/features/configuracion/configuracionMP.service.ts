import { pool } from "../../config/db";

const MP_USER_URL = "https://api.mercadolibre.com/users/me";
const MP_VALIDATION_TIMEOUT_MS = 8000;

export class MercadoPagoValidationUnavailableError extends Error {
  constructor() { super("No se pudo verificar la credencial con Mercado Pago"); }
}

export const validarTokenMP = async (token: string): Promise<boolean> => {
  try {
    const response = await fetch(MP_USER_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(MP_VALIDATION_TIMEOUT_MS),
      redirect: "error",
    });
    // Solo el status HTTP de esta respuesta autenticada establece la clasificación.
    if (response.status === 401 || response.status === 403) return false;
    if (response.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
      throw new MercadoPagoValidationUnavailableError();
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MercadoPagoValidationUnavailableError();
    }
    const id: unknown = (body as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new MercadoPagoValidationUnavailableError();
    }
    return true;
  } catch {
    // Ni errores locales con status/statusCode ni el body remoto autentican una credencial.
    // No transportar el error original: podría contener headers o el token.
    throw new MercadoPagoValidationUnavailableError();
  }
};

export const guardarTokenMP = async (localId: number, token: string) => {
  await pool.query(
    "UPDATE locales SET mp_access_token = ? WHERE id = ?",
    [token, localId]
  );
};

export const obtenerEstadoMP = async (localId: number) => {
  const [rows]: any = await pool.query(
    "SELECT mp_access_token FROM locales WHERE id = ?",
    [localId]
  );

  const token: unknown = rows[0]?.mp_access_token;
  const configurado = typeof token === "string" && token.trim().length > 0;

  return {
    configurado,
    // Un valor corto o malformado no debe poder revelarse íntegramente.
    token_preview: configurado && token.startsWith("APP_USR-") && token.length >= 16
      ? `****${token.slice(-4)}` : null,
  };
};
