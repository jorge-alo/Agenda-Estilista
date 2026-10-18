import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { sanitizedErrorMiddleware } from "./sanitizedError.middleware";

const SECRET_BODY_SENTINEL = "SECRET_BODY_SENTINEL";
const SECRET_AUTH_SENTINEL = "SECRET_AUTH_SENTINEL";
let server: Server;
let port: number;
const logCalls: unknown[][] = [];
const originalConsoleError = console.error;

interface HttpResult { status: number; body: string }

function send(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

before(async () => {
  console.error = (...args: unknown[]) => { logCalls.push(args); };
  const app = express();
  app.set("env", "production");
  app.use(express.json({ limit: "1mb" }));
  app.post("/unexpected", (_req, _res, next) => next(new Error("internal failure")));
  app.post("/handled", (_req, res) => res.status(409).json({ code: "DOMAIN_CONFLICT" }));
  app.use(sanitizedErrorMiddleware);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

after(async () => {
  console.error = originalConsoleError;
  server.close();
  await once(server, "close");
});

test("malformed JSON returns generic 400 and neither body nor parser error is logged", async () => {
  const beforeLogs = logCalls.length;
  const body = `{"token":"${SECRET_BODY_SENTINEL}", broken`;
  const response = await send("POST", "/malformed?query=QUERY_SENTINEL", body, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { code: "INVALID_JSON" });
  assert.ok(!response.body.includes(SECRET_BODY_SENTINEL));
  assert.equal(logCalls.length, beforeLogs + 1);
  const safeLog = JSON.stringify(logCalls[logCalls.length - 1]);
  assert.ok(!safeLog.includes(SECRET_BODY_SENTINEL));
  assert.ok(!safeLog.includes("QUERY_SENTINEL"));
  assert.ok(!safeLog.includes("SyntaxError"));
  assert.deepEqual(logCalls[logCalls.length - 1]?.[1], {
    method: "POST", path: "/malformed", status: 400, code: "INVALID_JSON",
  });
});

test("unexpected route error returns generic 500 and logger excludes Authorization, query and error", async () => {
  const beforeLogs = logCalls.length;
  const response = await send("POST", "/unexpected?query=QUERY_AUTH_SENTINEL", "{}", {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SECRET_AUTH_SENTINEL}`,
  });

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { code: "INTERNAL_SERVER_ERROR" });
  assert.equal(logCalls.length, beforeLogs + 1);
  const safeLog = JSON.stringify(logCalls[logCalls.length - 1]);
  assert.ok(!safeLog.includes(SECRET_AUTH_SENTINEL));
  assert.ok(!safeLog.includes("QUERY_AUTH_SENTINEL"));
  assert.ok(!safeLog.includes("internal failure"));
  assert.deepEqual(logCalls[logCalls.length - 1]?.[1], {
    method: "POST", path: "/unexpected", status: 500, code: "UNEXPECTED_HTTP_ERROR",
  });
});

test("domain response stays unchanged and nonexistent route keeps Express default 404", async () => {
  const beforeLogs = logCalls.length;
  const handled = await send("POST", "/handled", "{}", { "Content-Type": "application/json" });
  assert.equal(handled.status, 409);
  assert.deepEqual(JSON.parse(handled.body), { code: "DOMAIN_CONFLICT" });
  assert.equal(logCalls.length, beforeLogs);

  const missing = await send("GET", "/missing?secret=QUERY_SENTINEL");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /Cannot GET \/missing/);
  assert.ok(!missing.body.includes("QUERY_SENTINEL"));
  assert.equal(logCalls.length, beforeLogs);
});
