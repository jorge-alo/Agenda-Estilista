interface ErrorMetadata {
  response?: { status?: unknown };
  code?: unknown;
}

const SAFE_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_BAD_OPTION",
  "ERR_BAD_OPTION_VALUE",
  "ERR_BAD_REQUEST",
  "ERR_BAD_RESPONSE",
  "ERR_CANCELED",
  "ERR_DEPRECATED",
  "ERR_FR_TOO_MANY_REDIRECTS",
  "ERR_INVALID_URL",
  "ERR_NETWORK",
  "ERR_NOT_SUPPORT",
]);

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as ErrorMetadata).response?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function getCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as ErrorMetadata).code;
  return typeof code === "string" && SAFE_TRANSPORT_CODES.has(code) ? code : undefined;
}

function safeInstance(instance: string): string {
  return /^\d{1,10}$/.test(instance) ? instance : "unknown";
}

export function logEvolutionFailure(operation: string, instance: string, error: unknown): void {
  const metadata = {
    provider: "evolution",
    operation,
    instance: safeInstance(instance),
    ...(getStatus(error) === undefined ? {} : { status: getStatus(error) }),
    ...(getCode(error) === undefined ? {} : { code: getCode(error) }),
  };
  console.error("Evolution request failed", metadata);
}
