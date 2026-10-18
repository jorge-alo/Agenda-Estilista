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
import publicBookingRouter from "./publicBooking.routes";
import { generateOpaqueSecret, hashOpaqueSecret } from "../session/opaqueSecret";
import { duracionPublica } from "./publicBooking.types";

const prefix = `pet12c-${randomUUID()}`;
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
    throw new Error(`PET12C_FIXTURE_DB_OPERATION_FAILED:${code}`);
  }
}

interface LocalFixture { id: number; slug: string }
async function createLocal(options: { active?: number; kind?: string } = {}): Promise<LocalFixture> {
  const slug = `${prefix}-${serial++}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, activo, business_type) VALUES (?, ?, ?, ?)",
    [prefix, slug, options.active ?? 1, options.kind ?? "PET_GROOMING"]);
  localIds.push(local.insertId);
  return { id: local.insertId, slug };
}

async function createClient(localId: number, phone = "1123452000", name = "Ana"): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, ?, ?)",
    [name, phone, normalizeClientPhone(phone), localId]);
  return result.insertId;
}

async function createPet(localId: number, name: string, options: { active?: number; online?: number } = {}): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO mascotas (nombre, local_id, activo, reserva_online_habilitada) VALUES (?, ?, ?, ?)",
    [name, localId, options.active ?? 1, options.online ?? 1]);
  return result.insertId;
}

async function link(localId: number, petId: number, clientId: number): Promise<void> {
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [localId, petId, clientId]);
}

async function createSession(localId: number, clienteId: number, options: { expiresInSeconds?: number; revoked?: boolean } = {}) {
  const secret = generateOpaqueSecret();
  const expiresInSeconds = options.expiresInSeconds ?? 43200;
  await q<ResultSetHeader>(
    `INSERT INTO pet_client_sessions (local_id, cliente_id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?,
       CASE WHEN ? < 0 THEN DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) ELSE UTC_TIMESTAMP(3) END,
       DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
       CASE WHEN ? = 1 THEN UTC_TIMESTAMP(3) ELSE NULL END)`,
    [localId, clienteId, hashOpaqueSecret(secret), expiresInSeconds, expiresInSeconds, options.revoked ? 1 : 0]);
  return { secret };
}

async function createServicio(localId: number, nombre: string, duracion: number, options: { activo?: number; precio?: string | null } = {}): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO servicios (nombre, duracion, precio, local_id, activo) VALUES (?, ?, ?, ?, ?)",
    [nombre, duracion, options.precio ?? null, localId, options.activo ?? 1]);
  return result.insertId;
}

async function createExtra(localId: number, nombre: string, options: { activo?: number } = {}): Promise<number> {
  const result = await q<ResultSetHeader>(
    "INSERT INTO extras (local_id, nombre, activo) VALUES (?, ?, ?)",
    [localId, nombre, options.activo ?? 1]);
  return result.insertId;
}

async function configServicio(localId: number, mascotaId: number, servicioId: number, duracion: number): Promise<void> {
  await q("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, ?)",
    [localId, mascotaId, servicioId, duracion]);
}

async function configExtra(localId: number, mascotaId: number, extraId: number, duracion: number): Promise<void> {
  await q("INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, ?)",
    [localId, mascotaId, extraId, duracion]);
}

interface HttpResult { status: number; body: string; noStore: boolean }
async function call(path: string, options: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.text(), noStore: response.headers.get("cache-control") === "no-store" };
}
function opciones(local: LocalFixture, secret: string, mascotaId: number | string): Promise<HttpResult> {
  return call(`/api/pet/public/${local.slug}/mascotas/${mascotaId}/opciones-reserva`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
}
function json(result: HttpResult): any {
  try { return JSON.parse(result.body); } catch { throw new Error("PET12C_RESPONSE_NOT_JSON"); }
}
function assertUnavailable(result: HttpResult): void {
  assert.equal(result.status, 404);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), { error: "PET_MASCOTA_UNAVAILABLE" });
}

before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/pet/public", publicBookingRouter);
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
  for (const localId of localIds.splice(0)) {
    await q("DELETE FROM mascota_servicios WHERE local_id = ?", [localId]);
    await q("DELETE FROM mascota_extras WHERE local_id = ?", [localId]);
    await q("DELETE FROM servicios WHERE local_id = ?", [localId]);
    await q("DELETE FROM extras WHERE local_id = ?", [localId]);
    await q("DELETE FROM locales WHERE id = ? AND nombre = ?", [localId, prefix]);
  }
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

test("PET-12C autoriza mascota propia y devuelve servicios/extras activos con orden estable", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Rocky");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);

  const servicioB = await createServicio(local.id, "Zeta baño", 45);
  const servicioA = await createServicio(local.id, "Alfa corte", 90);
  const extraB = await createExtra(local.id, "Zeta uñas");
  const extraA = await createExtra(local.id, "Alfa perfume");
  await configServicio(local.id, pet, servicioB, 50);
  await configServicio(local.id, pet, servicioA, 90);
  await configExtra(local.id, pet, extraB, 10);
  await configExtra(local.id, pet, extraA, 5);

  const result = await opciones(local, session.secret, pet);
  assert.equal(result.status, 200);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), {
    servicios: [
      { id: servicioA, nombre: "Alfa corte", duracionMinutos: 90 },
      { id: servicioB, nombre: "Zeta baño", duracionMinutos: 50 },
    ],
    extras: [
      { id: extraA, nombre: "Alfa perfume", duracionExtraMinutos: 5 },
      { id: extraB, nombre: "Zeta uñas", duracionExtraMinutos: 10 },
    ],
  });
  assert.equal(logs.length, 0);
});

test("PET-12C lista vacía es válida y no convierte a la mascota en no autorizada", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Sin config");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const result = await opciones(local, session.secret, pet);
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { servicios: [], extras: [] });
});

test("PET-12C usa duracion_minutos y no la duracion genérica del catálogo", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Duración custom");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const servicio = await createServicio(local.id, "Baño", 30);
  await configServicio(local.id, pet, servicio, 75);
  const result = await opciones(local, session.secret, pet);
  assert.deepEqual(json(result).servicios, [{ id: servicio, nombre: "Baño", duracionMinutos: 75 }]);
});

test("PET-12C excluye servicios/extras no configurados y de catálogo inactivo", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Filtros");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);

  const activo = await createServicio(local.id, "Activo", 30);
  const inactivo = await createServicio(local.id, "Inactivo", 30, { activo: 0 });
  await configServicio(local.id, pet, activo, 30);
  await configServicio(local.id, pet, inactivo, 30);

  const extraActivo = await createExtra(local.id, "Extra activo");
  const extraInactivo = await createExtra(local.id, "Extra inactivo", { activo: 0 });
  await configExtra(local.id, pet, extraActivo, 10);
  await configExtra(local.id, pet, extraInactivo, 10);

  const result = await opciones(local, session.secret, pet);
  assert.deepEqual(json(result), {
    servicios: [{ id: activo, nombre: "Activo", duracionMinutos: 30 }],
    extras: [{ id: extraActivo, nombre: "Extra activo", duracionExtraMinutos: 10 }],
  });
});

test("PET-12C extras son independientes del servicio elegido", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Independiente");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const servicio = await createServicio(local.id, "Corte", 60);
  const extra = await createExtra(local.id, "Uñas");
  await configServicio(local.id, pet, servicio, 60);
  await configExtra(local.id, pet, extra, 15);
  assert.deepEqual(json(await opciones(local, session.secret, pet)).extras, [{ id: extra, nombre: "Uñas", duracionExtraMinutos: 15 }]);
  await q("DELETE FROM mascota_servicios WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  const result = await opciones(local, session.secret, pet);
  assert.deepEqual(json(result).servicios, []);
  assert.deepEqual(json(result).extras, [{ id: extra, nombre: "Uñas", duracionExtraMinutos: 15 }]);
});

test("PET-12C mascota compartida M:N es accesible para cada responsable", async () => {
  const local = await createLocal();
  const first = await createClient(local.id, "1123452000", "Ana");
  const second = await createClient(local.id, "1123452001", "Bea");
  const pet = await createPet(local.id, "Compartida");
  await link(local.id, pet, first);
  await link(local.id, pet, second);
  const firstSession = await createSession(local.id, first);
  const secondSession = await createSession(local.id, second);
  for (const secret of [firstSession.secret, secondSession.secret]) {
    const result = await opciones(local, secret, pet);
    assert.equal(result.status, 200);
    assert.deepEqual(json(result), { servicios: [], extras: [] });
  }
});

for (const [label, options] of [
  ["inexistente", {}],
  ["inactiva", { active: 0, online: 1 }],
  ["online deshabilitada", { active: 1, online: 0 }],
] as const) {
  test(`PET-12C mascota ${label} es 404 indistinguible`, async () => {
    const local = await createLocal();
    const client = await createClient(local.id);
    const session = await createSession(local.id, client);
    let mascotaId = 2147483647;
    if (Object.keys(options).length) {
      mascotaId = await createPet(local.id, "No elegible", options as { active?: number; online?: number });
      await link(local.id, mascotaId, client);
    }
    assertUnavailable(await opciones(local, session.secret, mascotaId));
  });
}

test("PET-12C mascota sin vínculo y mascota de otro tenant son 404 indistinguibles", async () => {
  const local = await createLocal();
  const other = await createLocal();
  const client = await createClient(local.id);
  const otherClient = await createClient(other.id, "1123452999", "Otra");
  const session = await createSession(local.id, client);
  const sinVinculo = await createPet(local.id, "Sin vínculo");
  const deOtroTenant = await createPet(other.id, "Ajena");
  await link(other.id, deOtroTenant, otherClient);
  assertUnavailable(await opciones(local, session.secret, sinVinculo));
  assertUnavailable(await opciones(local, session.secret, deOtroTenant));
});

test("PET-12C mascota de otro responsable del mismo local es 404", async () => {
  const local = await createLocal();
  const owner = await createClient(local.id, "1123452000", "Ana");
  const stranger = await createClient(local.id, "1123452001", "Bea");
  const pet = await createPet(local.id, "De Ana");
  await link(local.id, pet, owner);
  const strangerSession = await createSession(local.id, stranger);
  assertUnavailable(await opciones(local, strangerSession.secret, pet));
});

test("PET-12C vínculo eliminado oculta la mascota", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Desvinculada");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  assert.equal((await opciones(local, session.secret, pet)).status, 200);
  await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [pet, client, local.id]);
  assertUnavailable(await opciones(local, session.secret, pet));
});

for (const mascotaId of ["abc", "0", "-1", "1.5", "2147483648", "01"]) {
  test(`PET-12C mascotaId inválido ${JSON.stringify(mascotaId)} es 400 PET_BOOKING_INVALID`, async () => {
    const local = await createLocal();
    const client = await createClient(local.id);
    const session = await createSession(local.id, client);
    const result = await opciones(local, session.secret, mascotaId);
    assert.equal(result.status, 400);
    assert.equal(result.noStore, true);
    assert.deepEqual(json(result), { error: "PET_BOOKING_INVALID" });
  });
}

test("PET-12C sesión inválida: sin Bearer, expirada, revocada, slug distinto y JWT", async () => {
  const local = await createLocal();
  const other = await createLocal();
  const client = await createClient(local.id);
  const otherClient = await createClient(other.id, "1123452999", "Otra");
  const pet = await createPet(local.id, "Rocky");
  await link(local.id, pet, client);
  const expired = await createSession(local.id, client, { expiresInSeconds: -60 });
  const revoked = await createSession(local.id, client, { revoked: true });
  const active = await createSession(local.id, client);
  const otherSession = await createSession(other.id, otherClient);

  const noBearer = await call(`/api/pet/public/${local.slug}/mascotas/${pet}/opciones-reserva`);
  assert.equal(noBearer.status, 401);
  assert.deepEqual(json(noBearer), { error: "PET_SESSION_INVALID" });

  for (const [target, secret] of [
    [local, expired.secret],
    [local, revoked.secret],
    [other, active.secret],
    [local, otherSession.secret],
  ] as const) {
    const result = await opciones(target, secret, pet);
    assert.equal(result.status, 401);
    assert.equal(result.noStore, true);
    assert.deepEqual(json(result), { error: "PET_SESSION_INVALID" });
  }

  const jwtLike = await call(`/api/pet/public/${local.slug}/mascotas/${pet}/opciones-reserva`, {
    headers: { Authorization: "Bearer aaa.bbb.ccc" },
  });
  assert.equal(jwtLike.status, 401);
  assert.deepEqual(json(jwtLike), { error: "PET_SESSION_INVALID" });
  assert.equal(logs.length, 0);
});

test("PET-12C no filtra precio, tenant, flags ni timestamps en la respuesta", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "PII");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const servicio = await createServicio(local.id, "Precio oculto", 40, { precio: "1234.50" });
  const extra = await createExtra(local.id, "Extra oculto");
  await configServicio(local.id, pet, servicio, 40);
  await configExtra(local.id, pet, extra, 10);
  const result = await opciones(local, session.secret, pet);
  const rendered = JSON.stringify(json(result));
  for (const field of ["precio", "local_id", "localId", "clienteId", "activo", "created_at", "updated_at", "sessionId"]) {
    assert.ok(!rendered.includes(field), `la respuesta no debe incluir ${field}`);
  }
  assert.ok(!rendered.includes("1234.50"));
});

test("PET-12C aislamiento multi-tenant: catálogos de dos locales no se mezclan", async () => {
  const localA = await createLocal();
  const localB = await createLocal();
  const clientA = await createClient(localA.id);
  const petA = await createPet(localA.id, "A");
  await link(localA.id, petA, clientA);
  const sessionA = await createSession(localA.id, clientA);

  const servicioA = await createServicio(localA.id, "Servicio A", 30);
  await configServicio(localA.id, petA, servicioA, 30);
  const servicioB = await createServicio(localB.id, "Servicio B", 30);
  const petB = await createPet(localB.id, "B");
  await configServicio(localB.id, petB, servicioB, 30);

  const result = await opciones(localA, sessionA.secret, petA);
  assert.deepEqual(json(result).servicios, [{ id: servicioA, nombre: "Servicio A", duracionMinutos: 30 }]);
});

test("PET-12C guard de integridad de duración falla en vez de publicar corrupción", () => {
  assert.equal(duracionPublica(15, "campo"), 15);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => duracionPublica(value, "campo"));
  }
});
