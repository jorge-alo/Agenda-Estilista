import type { ErrorRequestHandler } from "express";

interface BodyParserErrorMetadata {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isMalformedJson(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const metadata = error as BodyParserErrorMetadata;
  const status = metadata.status ?? metadata.statusCode;
  return metadata.type === "entity.parse.failed" && status === 400;
}

function logSafeFailure(method: string, path: string, status: number, code: string): void {
  console.error("HTTP request failed", { method, path, status, code });
}

export const sanitizedErrorMiddleware: ErrorRequestHandler = (error, req, res, _next) => {
  // Once headers are sent the status/body cannot be replaced. Destroy the response
  // rather than forwarding an untrusted error to Express' default stack logger.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const method = SAFE_METHODS.has(req.method) ? req.method : "OTHER";
  const path = req.path.slice(0, 256); // req.path excludes the query string.

  if (isMalformedJson(error)) {
    logSafeFailure(method, path, 400, "INVALID_JSON");
    res.status(400).json({ code: "INVALID_JSON" });
    return;
  }

  logSafeFailure(method, path, 500, "UNEXPECTED_HTTP_ERROR");
  res.status(500).json({ code: "INTERNAL_SERVER_ERROR" });
};
