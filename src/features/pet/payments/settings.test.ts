import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { before, beforeEach, after, test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import petRouter from "../pet.routes";
import configuracionRouter from "../../configuracion/configuracion.routes";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";

const secret = "PET_DEPOSIT_JWT_SOLO_TEST";
const tokenA = "APP_USR-TOKEN_LOCAL_A_FICTICIO";
const tokenB = "APP_USR-TOKEN_LOCAL_B_FICTICIO";
const replacement = "APP_USR-TOKEN_LOCAL_REEMPLAZADO_FICTICIO";
const base = "/api/pet/admin/payments/settings";
const mpBase = "/api/configuracion/mercadopago";
const enabled = { pet_deposit_enabled: true, pet_deposit_amount: "5000.00" };
const disabled = { pet_deposit_enabled: false, pet_deposit_amount: null };
const locales: number[] = [];
let server: Server;
let port: number;

type HttpResult = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
async function http(method: string, path = base, body?: unknown, localId: number | null = locales[0], role = "admin", jwtLocal?: unknown): Promise<HttpResult> {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, rol: role, localId: jwtLocal ?? localId }, secret, { expiresIn: "1m" });
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { response += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response, headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function json(result: HttpResult): Record<string, unknown> { return JSON.parse(result.body) as Record<string, unknown>; }
async function row(localId: number) {
  const [rows] = await pool.query<(RowDataPacket & { pet_deposit_enabled: number; pet_deposit_amount: string | null; mp_access_token: string | null })[]>(
    "SELECT pet_deposit_enabled, pet_deposit_amount, mp_access_token FROM locales WHERE id = ?", [localId]);
  return rows[0];
}

before(async () => {
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    const [result] = await pool.query<ResultSetHeader>(
      "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", ["Fixture deposit settings", randomUUID(), business]);
    locales.push(result.insertId);
  }
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", petRouter);
  app.use("/api/configuracion", configuracionRouter);
  app.use(sanitizedErrorMiddleware);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret, MP_ACCESS_TOKEN: "APP_USR-GLOBAL_NO_USAR_FICTICIO" });
  for (const id of locales) {
    await pool.query("UPDATE locales SET pet_deposit_enabled = 0, pet_deposit_amount = NULL, mp_access_token = NULL WHERE id = ?", [id]);
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    for (const id of locales) await pool.query("DELETE FROM locales WHERE id = ?", [id]);
  } finally { await pool.end(); }
});

test("GET defaults, no-store y sin datos MP sensibles", async () => {
  const result = await http("GET");
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(json(result), { ...disabled, currency: "ARS", mpConfigured: false });
  assert.ok(!result.body.includes("token"));
});

test("GET usa el tenant del JWT y no expone el token", async () => {
  await pool.query("UPDATE locales SET pet_deposit_enabled = 1, pet_deposit_amount = '3000.50', mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
  const a = await http("GET", `${base}?local_id=${locales[1]}`, undefined, locales[0]);
  const b = await http("GET", base, undefined, locales[1]);
  assert.deepEqual(json(a), { ...enabled, pet_deposit_amount: "3000.50", currency: "ARS", mpConfigured: true });
  assert.deepEqual(json(b), { ...disabled, currency: "ARS", mpConfigured: false });
  assert.ok(!a.body.includes(tokenA));
  assert.ok(!a.body.includes("preview"));
});

test("GET/PUT requieren auth, rol admin y local PET existente", async () => {
  for (const method of ["GET", "PUT"]) {
    const body = method === "PUT" ? disabled : undefined;
    assert.equal((await http(method, base, body, null)).status, 401);
    assert.equal((await http(method, base, body, locales[0], "estilista")).status, 403);
    assert.equal((await http(method, base, body, locales[0], "superadmin")).status, 403);
    assert.equal((await http(method, base, body, locales[2])).status, 403);
    assert.equal((await http(method, base, body, locales[0], "admin", "invalido")).status, 401);
    assert.equal((await http(method, base, body, 2147483647)).status, 404);
  }
});

test("PUT habilita solo con token local, serializa monto exacto y es idempotente", async () => {
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenB, locales[1]]);
  const first = await http("PUT", base, enabled);
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.deepEqual(json(first), { ...enabled, currency: "ARS", mpConfigured: true });
  assert.deepEqual(json(await http("PUT", base, enabled)), json(first));
  assert.deepEqual(json(await http("GET")), json(first));
  assert.equal((await row(locales[0])).pet_deposit_amount, "5000.00");
  assert.equal((await row(locales[1])).pet_deposit_enabled, 0);
  assert.ok(!first.body.includes(tokenA));
});

test("montos límite y desactivar conservando o limpiando el monto", async () => {
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
  for (const amount of ["0.01", "99999999.99"]) {
    assert.equal((await http("PUT", base, { ...enabled, pet_deposit_amount: amount })).status, 200);
    assert.equal(json(await http("GET")).pet_deposit_amount, amount);
  }
  assert.equal((await http("PUT", base, { ...disabled, pet_deposit_amount: "99999999.99" })).status, 200);
  assert.equal((await row(locales[0])).pet_deposit_amount, "99999999.99");
  assert.equal((await http("PUT", base, disabled)).status, 200);
  assert.equal((await row(locales[0])).pet_deposit_amount, null);
});

test("desactivada permite configurar monto sin credencial MP", async () => {
  const result = await http("PUT", base, { ...disabled, pet_deposit_amount: "5000.00" });
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { ...disabled, pet_deposit_amount: "5000.00", currency: "ARS", mpConfigured: false });
});

const invalidos: Array<[string, unknown]> = [
  ["cero", { ...enabled, pet_deposit_amount: "0.00" }],
  ["negativo", { ...enabled, pet_deposit_amount: "-0.01" }],
  ["superior al máximo", { ...enabled, pet_deposit_amount: "100000000.00" }],
  ["tres decimales", { ...enabled, pet_deposit_amount: "1.001" }],
  ["JSON number", { ...enabled, pet_deposit_amount: 5000 }],
  ["coma", { ...enabled, pet_deposit_amount: "1,00" }],
  ["espacios", { ...enabled, pet_deposit_amount: " 1.00" }],
  ["exponente", { ...enabled, pet_deposit_amount: "1e2" }],
  ["no canónico", { ...enabled, pet_deposit_amount: "01.00" }],
  ["enabled sin monto", { pet_deposit_enabled: true, pet_deposit_amount: null }],
  ["sin enabled", { pet_deposit_amount: "5000.00" }],
  ["sin amount", { pet_deposit_enabled: true }],
  ["enabled no boolean", { ...enabled, pet_deposit_enabled: 1 }],
  ["campo extra", { ...enabled, currency: "ARS" }],
  ["local_id", { ...enabled, local_id: 123 }],
  ["localId", { ...enabled, localId: 123 }],
  ["token en body", { ...enabled, mp_access_token: tokenA }],
  ["array", []],
];

for (const [label, body] of invalidos) {
  test(`PUT inválido ${label}: 400 sin escritura`, async () => {
    await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
    const result = await http("PUT", base, body);
    assert.equal(result.status, 400, label);
    assert.deepEqual(json(result), { error: "PET_DEPOSIT_INVALID_PAYLOAD" });
    assert.equal((await row(locales[0])).pet_deposit_enabled, 0);
    assert.equal((await row(locales[0])).pet_deposit_amount, null);
  });
}

test("PUT body JSON null rechazado antes del controller", async () => {
  const result = await http("PUT", base, null);
  assert.equal(result.status, 400);
  assert.deepEqual(json(result), { code: "INVALID_JSON" });
  assert.equal((await row(locales[0])).pet_deposit_enabled, 0);
});

test("habilitar sin token local da 409 sin escritura ni fallback a otro local/global", async () => {
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenB, locales[1]]);
  const result = await http("PUT", base, enabled);
  assert.equal(result.status, 409);
  assert.deepEqual(json(result), { error: "PET_DEPOSIT_MP_REQUIRED" });
  assert.equal((await row(locales[0])).pet_deposit_enabled, 0);
  assert.equal((await row(locales[0])).pet_deposit_amount, null);
  await pool.query("UPDATE locales SET mp_access_token = '   ' WHERE id = ?", [locales[0]]);
  assert.equal((await http("PUT", base, enabled)).status, 409);
});

const mpUserUrl = "https://api.mercadolibre.com/users/me";
const mpUser = { id: 12345678, nickname: "fixture", email: "no-exponer@example.test" };
const mpResponse = (status: number, body: unknown = { error: "fixture" }) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8" },
});

function mockMpFetch(t: TestContext,
  reply: (input: unknown, init: RequestInit) => Promise<Response> | Response) {
  return t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(input, mpUserUrl);
    assert.ok(!String(input).includes(replacement));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${replacement}`);
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    return reply(input, init as RequestInit);
  });
}

test("MP HTTP 200 /users/me con JSON e id esperado guarda y conserva la seña al reemplazar", async t => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  mockMpFetch(t, () => mpResponse(200, mpUser));
  const first = await http("POST", mpBase, { mp_access_token: replacement });
  assert.equal(first.status, 200);
  assert.equal((await row(locales[0])).mp_access_token, replacement);
  assert.equal((await http("PUT", base, enabled)).status, 200);
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
  const second = await http("POST", mpBase, { mp_access_token: replacement });
  assert.equal(second.status, 200);
  assert.equal((await row(locales[0])).mp_access_token, replacement);
  assert.equal((await row(locales[0])).pet_deposit_enabled, 1);
  assert.equal(json(await http("GET")).mpConfigured, true);
  assert.deepEqual(timeouts, [8000, 8000]);
  assert.deepEqual(logs, []);
  for (const result of [first, second]) {
    assert.ok(!result.body.includes(replacement));
    assert.ok(!result.body.includes(mpUser.email));
  }
});

test("MP rechaza un token de tipo no string sin consultar al proveedor", async t => {
  const probe = t.mock.method(globalThis, "fetch", async () => mpResponse(200, mpUser));
  const result = await http("POST", mpBase, { mp_access_token: 123 });
  assert.equal(result.status, 400);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal((await row(locales[0])).mp_access_token, null);
});

for (const [status, expectedHttp] of [
  [401, 400], [403, 400], [404, 503], [429, 503], [500, 503],
  [502, 503], [503, 503], [504, 503], [400, 503],
] as const) {
  test(`MP HTTP real ${status} no guarda ni registra credenciales`, async t => {
    await pool.query("UPDATE locales SET mp_access_token = ?, pet_deposit_enabled = 1, pet_deposit_amount = '5000.00' WHERE id = ?", [tokenA, locales[0]]);
    mockMpFetch(t, () => mpResponse(status, { status: 404, authorization: replacement }));
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    const result = await http("POST", mpBase, { mp_access_token: replacement });
    assert.equal(result.status, expectedHttp);
    assert.deepEqual(json(result), { error: expectedHttp === 400
      ? "El Access Token es inválido. Verificá que lo hayas copiado correctamente desde tu cuenta de Mercado Pago."
      : "No se pudo verificar el token con Mercado Pago" });
    assert.equal((await row(locales[0])).mp_access_token, tokenA);
    assert.equal((await row(locales[0])).pet_deposit_enabled, 1);
    assert.deepEqual(logs, expectedHttp === 400 ? [] : [["Validación MP no disponible"]]);
    assert.ok(!JSON.stringify(logs).includes(replacement));
    assert.ok(!JSON.stringify(logs).includes("Authorization"));
    assert.ok(!result.body.includes(replacement));
  });
}

for (const [label, failure] of [
  ["error local status 404", { status: 404, headers: { Authorization: replacement } }],
  ["timeout", new DOMException("The operation timed out", "TimeoutError")],
  ["error de red", Object.assign(new Error(`network failure ${replacement}`), { headers: { Authorization: replacement } })],
] as const) {
  test(`MP ${label} no se interpreta como HTTP 404 ni guarda`, async t => {
    await pool.query("UPDATE locales SET mp_access_token = ?, pet_deposit_enabled = 1, pet_deposit_amount = '5000.00' WHERE id = ?", [tokenA, locales[0]]);
    mockMpFetch(t, () => { throw failure; });
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    const result = await http("POST", mpBase, { mp_access_token: replacement });
    assert.equal(result.status, 503);
    assert.deepEqual(json(result), { error: "No se pudo verificar el token con Mercado Pago" });
    assert.equal((await row(locales[0])).mp_access_token, tokenA);
    assert.equal((await row(locales[0])).pet_deposit_enabled, 1);
    assert.deepEqual(logs, [["Validación MP no disponible"]]);
    assert.ok(!JSON.stringify(logs).includes(replacement));
    assert.ok(!JSON.stringify(logs).includes("Authorization"));
  });
}

for (const [label, response] of [
  ["id ausente", mpResponse(200, { nickname: "fixture" })],
  ["id string", mpResponse(200, { id: "12345678" })],
  ["id cero", mpResponse(200, { id: 0 })],
  ["array", mpResponse(200, [mpUser])],
  ["JSON malformado", new Response("{invalid", { status: 200, headers: { "Content-Type": "application/json" } })],
  ["content-type inesperado", new Response(JSON.stringify(mpUser), { status: 200, headers: { "Content-Type": "text/html" } })],
] as const) {
  test(`MP HTTP 200 con ${label} no confirma token`, async t => {
    await pool.query("UPDATE locales SET mp_access_token = ?, pet_deposit_enabled = 1, pet_deposit_amount = '5000.00' WHERE id = ?", [tokenA, locales[0]]);
    mockMpFetch(t, () => response);
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    const result = await http("POST", mpBase, { mp_access_token: replacement });
    assert.equal(result.status, 503);
    assert.deepEqual(json(result), { error: "No se pudo verificar el token con Mercado Pago" });
    assert.equal((await row(locales[0])).mp_access_token, tokenA);
    assert.equal((await row(locales[0])).pet_deposit_enabled, 1);
    assert.deepEqual(logs, [["Validación MP no disponible"]]);
  });
}

test("MP validado pero falló el guardado: 500 y log exacto sin credenciales", async t => {
  await pool.query("UPDATE locales SET mp_access_token = ?, pet_deposit_enabled = 1, pet_deposit_amount = '5000.00' WHERE id = ?", [tokenA, locales[0]]);
  mockMpFetch(t, () => mpResponse(200, mpUser));
  const query = pool.query.bind(pool);
  t.mock.method(pool, "query", async (sql: unknown, values?: unknown) => {
    if (typeof sql === "string" && sql.startsWith("UPDATE locales SET mp_access_token = ?")) {
      throw Object.assign(new Error(replacement), { headers: { Authorization: replacement } });
    }
    return query(sql as string, values as number[]);
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const result = await http("POST", mpBase, { mp_access_token: replacement });
  assert.equal(result.status, 500);
  assert.deepEqual(json(result), { error: "Error interno" });
  assert.deepEqual(logs, [["Error configurando MP"]]);
  assert.equal((await row(locales[0])).mp_access_token, tokenA);
  assert.equal((await row(locales[0])).pet_deposit_enabled, 1);
  assert.ok(!result.body.includes(replacement));
  assert.ok(!JSON.stringify(logs).includes("Authorization"));
});

test("error inesperado PET responde 500 sin volcar secreto", async t => {
  const realQuery = pool.query.bind(pool);
  t.mock.method(pool, "query", async (sql: unknown, values?: unknown) => {
    if (typeof sql === "string" && sql.startsWith("SELECT business_type FROM locales")) {
      return realQuery(sql, values as number[]);
    }
    throw new Error(tokenA);
  });
  const result = await http("GET");
  assert.equal(result.status, 500);
  assert.deepEqual(json(result), { error: "Error interno" });
  assert.ok(!result.body.includes(tokenA));
});

test("preview MP no revela valores cortos o malformados", async () => {
  for (const token of ["x", "abcd", "APP_USR-1", "    "]) {
    await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [token, locales[0]]);
    const result = await http("GET", `${mpBase}/estado`);
    assert.equal(result.status, 200);
    assert.deepEqual(json(result), { configurado: token.trim().length > 0, token_preview: null });
    assert.ok(!result.body.includes(token));
  }
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [tokenA, locales[0]]);
  assert.deepEqual(json(await http("GET", `${mpBase}/estado`)), { configurado: true, token_preview: `****${tokenA.slice(-4)}` });
});
