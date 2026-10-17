export type ClientPhoneDuplicateKey = "canonical" | "legacy" | null;

// mysql2 only provides the constraint name in sqlMessage for ER_DUP_ENTRY.
// Match the exact key name and fail closed for unknown/ambiguous MySQL errors.
export function clientPhoneDuplicateKey(error: unknown): ClientPhoneDuplicateKey {
  if (!error || typeof error !== "object") return null;
  const dbError = error as { code?: unknown; errno?: unknown; sqlState?: unknown; sqlMessage?: unknown };
  if (dbError.code !== "ER_DUP_ENTRY" || dbError.errno !== 1062 || dbError.sqlState !== "23000" || typeof dbError.sqlMessage !== "string") {
    return null;
  }
  const key = dbError.sqlMessage.match(/for key '((?:[a-zA-Z0-9_]+\.)?[a-zA-Z0-9_]+)'$/i)?.[1]?.split(".").pop();
  if (key === "uq_clientes_telefono_normalizado_local") return "canonical";
  if (key === "unique_cliente_local") return "legacy";
  return null;
}

export class ClientPhoneConflictError extends Error {
  readonly code = "CLIENT_PHONE_CONFLICT";

  constructor() {
    super("No se pudo resolver la identidad telefónica del cliente");
  }
}
