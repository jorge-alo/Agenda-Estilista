import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, test } from "node:test";
import express from "express";
import type { QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { petSessionPublicRouter } from "./session.routes";
import { generateOpaqueSecret, hashOpaqueSecret } from "./opaqueSecret";

const prefix = `pet11c4-${randomUUID()}`;
const localIds: number[] = [];
let serial = 0;
let server: Server;
let port: number;
const logs: unknown[][] = [];

async function q<T extends QueryResult = RowDataPacket[]>(sql: string, values: unknown[] = []): Promise<T> {
  try { return (await pool.query<T>(sql, values))[0]; }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "UNKNOWN";
    throw new Error(`PET11C4_FIXTURE_DB_OPERATION_FAILED:${code}`);
  }
}

interface LocalFixture { id: number; slug: string; clientIds: number[]; petIds: number[] }
async function createLocal(options: { active?: number; kind?: string } = {}): Promise<LocalFixture> {
  const slug = `${prefix}-${serial++}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, activo, business_type) VALUES (?, ?, ?, ?)",
    [prefix, slug, options.active ?? 1, options.kind ?? "PET_GROOMING"]);
  localIds.push(local.insertId);
  return { id: local.insertId, slug, clientIds: [], petIds: [] };
}

async function createClient(local: LocalFixture, phone = "1123452000", name = "Ana"): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, ?, ?)",
    [name, phone, normalizeClientPhone(phone), local.id]);
  local.clientIds.push(result.insertId);
  return result.insertId;
}

async function createPet(local: LocalFixture, name: string, options: { active?: number; online?: number } = {}): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO mascotas (nombre, local_id, activo, reserva_online_habilitada) VALUES (?, ?, ?, ?)",
    [name, local.id, options.active ?? 1, options.online ?? 1]);
  local.petIds.push(result.insertId);
  return result.insertId;
}

async function link(local: LocalFixture, petId: number, clientId: number): Promise<void> {
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [local.id, petId, clientId]);
}

async function createSession(localId: number, clienteId: number, options: { secret?: string; expiresInSeconds?: number; revoked?: boolean } = {}) {
  const secret = options.secret ?? generateOpaqueSecret();
  const expiresInSeconds = options.expiresInSeconds ?? 43200;
  const result = await q<ResultSetHeader>(
    `INSERT INTO pet_client_sessions (local_id, cliente_id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?,
       CASE WHEN ? < 0 THEN DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) ELSE UTC_TIMESTAMP(3) END,
       DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
       CASE WHEN ? = 1 THEN UTC_TIMESTAMP(3) ELSE NULL END)`,
    [localId, clienteId, hashOpaqueSecret(secret), expiresInSeconds, expiresInSeconds, options.revoked ? 1 : 0]);
  return { id: result.insertId, secret };
}

interface HttpResult { status: number; body: string; noStore: boolean }
async function call(path: string, options: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options, signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.text(), noStore: response.headers.get("cache-control") === "no-store" };
}
function me(local: LocalFixture, secret: string): Promise<HttpResult> {
  return call(`/api/pet/public/${local.slug}/session/me`, { headers: { Authorization: `Bearer ${secret}` } });
}
function logout(slug: string, secret: string): Promise<HttpResult> {
  return call(`/api/pet/public/${slug}/session/logout`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}` },
  });
}
function json(result: HttpResult): any {
  try { return JSON.parse(result.body); } catch { throw new Error("PET11C4_RESPONSE_NOT_JSON"); }
}
function assertSessionInvalid(result: HttpResult): void {
  assert.equal(result.status, 401);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), { error: "PET_SESSION_INVALID" });
}
async function row(sql: string, values: unknown[] = []): Promise<RowDataPacket> {
  const rows = await q<RowDataPacket[]>(sql, values);
  assert.equal(rows.length, 1);
  return rows[0];
}

before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/pet/public", petSessionPublicRouter);
  app.use(sanitizedErrorMiddleware);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(t => {
  if (!("mock" in t)) throw new Error("Test mocks unavailable");
  logs.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
});

afterEach(async t => {
  if ("mock" in t) t.mock.restoreAll();
  for (const localId of localIds.splice(0)) await q("DELETE FROM locales WHERE id = ? AND nombre = ?", [localId, prefix]);
});

after(async () => {
  try {
    const rows = await q<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM locales WHERE nombre = ?", [prefix]);
    assert.equal(Number(rows[0].total), 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});

test("PET /me devuelve solo nombre y mascotas elegibles con orden estable", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const session = await createSession(local.id, client);
  const zeta = await createPet(local, "Zeta");
  const alpha = await createPet(local, "Alpha");
  const inactive = await createPet(local, "No activa", { active: 0 });
  const offline = await createPet(local, "No online", { online: 0 });
  await Promise.all([link(local, zeta, client), link(local, alpha, client), link(local, inactive, client), link(local, offline, client)]);

  const result = await me(local, session.secret);
  assert.equal(result.status, 200);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), {
    cliente: { nombre: "Ana" },
    mascotas: [{ id: alpha, nombre: "Alpha" }, { id: zeta, nombre: "Zeta" }],
  });
  const rendered = JSON.stringify(json(result));
  for (const field of ["telefono", "telefono_normalizado", "localId", "clienteId", "sessionId",
    "altaExigencia", "historial", "responsables", "servicios", "extras"]) {
    assert.ok(!rendered.includes(field));
  }
  assert.equal(logs.length, 0);
});

test("PET /me devuelve mascotas [] si no hay elegibles; conserva cliente y sesión", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const session = await createSession(local.id, client);
  const inactive = await createPet(local, "Inactive", { active: 0 });
  const offline = await createPet(local, "Offline", { online: 0 });
  await link(local, inactive, client);
  await link(local, offline, client);
  const result = await me(local, session.secret);
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { cliente: { nombre: "Ana" }, mascotas: [] });
  const [stored] = await q<(RowDataPacket & { revoked_at: unknown })[]>(
    "SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [session.id, local.id]);
  assert.equal(stored.revoked_at, null);
});

test("PET /me refleja inmediatamente mascota deshabilitada, baja lógica y vínculo eliminado", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const session = await createSession(local.id, client);
  const pet = await createPet(local, "Rocky");
  await link(local, pet, client);
  assert.deepEqual(json(await me(local, session.secret)), { cliente: { nombre: "Ana" }, mascotas: [{ id: pet, nombre: "Rocky" }] });
  await q("UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", [pet, local.id]);
  assert.deepEqual(json(await me(local, session.secret)), { cliente: { nombre: "Ana" }, mascotas: [] });
  await q("UPDATE mascotas SET reserva_online_habilitada = 1, activo = 0 WHERE id = ? AND local_id = ?", [pet, local.id]);
  assert.deepEqual(json(await me(local, session.secret)), { cliente: { nombre: "Ana" }, mascotas: [] });
  await q("UPDATE mascotas SET activo = 1, reserva_online_habilitada = 1 WHERE id = ? AND local_id = ?", [pet, local.id]);
  await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [pet, client, local.id]);
  assert.deepEqual(json(await me(local, session.secret)), { cliente: { nombre: "Ana" }, mascotas: [] });
});

test("PET /me mascota compartida aparece a cada responsable con vínculo M:N", async () => {
  const local = await createLocal();
  const first = await createClient(local, "1123452000", "Ana");
  const second = await createClient(local, "1123452001", "Bea");
  const firstSession = await createSession(local.id, first);
  const secondSession = await createSession(local.id, second);
  const pet = await createPet(local, "Compartida");
  await link(local, pet, first);
  await link(local, pet, second);
  assert.deepEqual(json(await me(local, firstSession.secret)), { cliente: { nombre: "Ana" }, mascotas: [{ id: pet, nombre: "Compartida" }] });
  assert.deepEqual(json(await me(local, secondSession.secret)), { cliente: { nombre: "Bea" }, mascotas: [{ id: pet, nombre: "Compartida" }] });
});

test("PET /me rechaza expiración, revocación, slug distinto y tenant distinto", async () => {
  const a = await createLocal();
  const b = await createLocal();
  const clientA = await createClient(a);
  const clientB = await createClient(b);
  const active = await createSession(a.id, clientA);
  const expired = await createSession(a.id, clientA, { expiresInSeconds: -60 });
  const revoked = await createSession(a.id, clientA, { revoked: true });
  const bSession = await createSession(b.id, clientB);
  for (const [slug, secret] of [[a.slug, expired.secret], [a.slug, revoked.secret], [b.slug, active.secret], [a.slug, bSession.secret]] as const) {
    assertSessionInvalid(await me(slug === a.slug ? a : b, secret));
  }
});

test("PET /me cliente borrado entre validaciones se oculta como sesión inválida", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const session = await createSession(local.id, client);
  await q("DELETE FROM clientes WHERE id = ? AND local_id = ?", [client, local.id]);
  assertSessionInvalid(await me(local, session.secret));
});

test("PET logout: sesión activa se revoca, respuesta 204/no-store y otras sesiones quedan activas", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const current = await createSession(local.id, client);
  const other = await createSession(local.id, client);
  const result = await logout(local.slug, current.secret);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.equal(result.noStore, true);
  const currentRow = await row("SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [current.id, local.id]);
  const otherRow = await row("SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [other.id, local.id]);
  assert.ok(currentRow.revoked_at !== null);
  assert.equal(otherRow.revoked_at, null);
  assert.equal(logs.length, 0);
});

test("PET logout es idempotente para sesión revocada y expirada bajo su local", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const revoked = await createSession(local.id, client, { revoked: true });
  const expired = await createSession(local.id, client, { expiresInSeconds: -60 });
  for (const session of [revoked, expired]) {
    const first = await logout(local.slug, session.secret);
    const second = await logout(local.slug, session.secret);
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.equal(first.noStore, true);
    assert.equal(second.noStore, true);
    const stored = await row("SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [session.id, local.id]);
    assert.ok(stored.revoked_at !== null);
  }
});

test("PET logout token inexistente válido devuelve 204", async () => {
  const local = await createLocal();
  const result = await logout(local.slug, generateOpaqueSecret());
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.equal(result.noStore, true);
});

test("PET logout sesión A bajo slug B devuelve 204 y no revoca A", async () => {
  const a = await createLocal();
  const b = await createLocal();
  const clientA = await createClient(a);
  const sessionA = await createSession(a.id, clientA);
  const result = await logout(b.slug, sessionA.secret);
  assert.equal(result.status, 204);
  const stored = await row("SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [sessionA.id, a.id]);
  assert.equal(stored.revoked_at, null);
});

test("PET logout slug inexistente/inactivo/BEAUTY conserva 404", async () => {
  const inactive = await createLocal({ active: 0 });
  const beauty = await createLocal({ kind: "BEAUTY" });
  for (const slug of [inactive.slug, beauty.slug, `${prefix}-missing`]) {
    const result = await logout(slug, generateOpaqueSecret());
    assert.equal(result.status, 404);
    assert.equal(result.noStore, true);
    assert.deepEqual(json(result), { error: "PET_LOCAL_NOT_FOUND" });
  }
});

test("PET logout rechaza Bearer ausente, mal formado y JWT", async () => {
  const local = await createLocal();
  const cases: Array<string | undefined> = [undefined, "Basic SECRET_AUTH_SENTINEL", "Bearer ", "Bearer notcanonical"];
  for (const authorization of cases) {
    const result = await call(`/api/pet/public/${local.slug}/session/logout`, {
      method: "POST", headers: authorization === undefined ? {} : { Authorization: authorization },
    });
    assertSessionInvalid(result);
  }
  assert.equal(logs.length, 0);
});

test("PET logout dos requests concurrentes de la misma sesión responden 204", async () => {
  const local = await createLocal();
  const client = await createClient(local);
  const session = await createSession(local.id, client);
  const results = await Promise.all([logout(local.slug, session.secret), logout(local.slug, session.secret)]);
  assert.deepEqual(results.map(result => result.status), [204, 204]);
  assert.ok(results.every(result => result.body === "" && result.noStore));
  const stored = await row("SELECT revoked_at FROM pet_client_sessions WHERE id = ? AND local_id = ?", [session.id, local.id]);
  assert.ok(stored.revoked_at !== null);
});

test("PET me/logout no exponen Bearer, cliente ni mascotas en logs o respuestas no store", async () => {
  const local = await createLocal();
  const client = await createClient(local, "1123452000", "CLIENT_SENTINEL");
  const session = await createSession(local.id, client);
  const pet = await createPet(local, "PET_SENTINEL");
  await link(local, pet, client);
  const meResult = await me(local, session.secret);
  assert.equal(meResult.noStore, true);
  assert.deepEqual(json(meResult), { cliente: { nombre: "CLIENT_SENTINEL" }, mascotas: [{ id: pet, nombre: "PET_SENTINEL" }] });
  const logoutResult = await logout(local.slug, session.secret);
  assert.equal(logoutResult.status, 204);
  const rendered = JSON.stringify(logs);
  for (const sentinel of [session.secret, "CLIENT_SENTINEL", "PET_SENTINEL", hashOpaqueSecret(session.secret).toString("hex")]) {
    assert.ok(!rendered.includes(sentinel));
  }
  assert.equal(logs.length, 0);
});
