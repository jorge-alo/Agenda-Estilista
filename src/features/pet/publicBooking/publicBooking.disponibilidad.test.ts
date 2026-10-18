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
import { PublicBookingError, validarConsultaDisponibilidadPublica } from "./publicBooking.types";
import { contextoTemporalArgentina } from "../disponibilidad/disponibilidad.service";

const prefix = `pet12d-${randomUUID()}`;
const localIds: number[] = [];
let serial = 0;
let server: Server;
let port: number;
const logs: unknown[][] = [];

const FECHA_FUTURA = "2099-10-20";
const DIA_FUTURO = new Date(Date.UTC(2099, 9, 20)).getUTCDay();
const FECHA_PASADA = "2000-01-01";

async function q<T extends QueryResult = RowDataPacket[]>(sql: string, values: unknown[] = []): Promise<T> {
  try { return (await pool.query<T>(sql, values))[0]; }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "UNKNOWN";
    throw new Error(`PET12D_FIXTURE_DB_OPERATION_FAILED:${code}`);
  }
}

interface LocalFixture { id: number; slug: string }
async function createLocal(): Promise<LocalFixture> {
  const slug = `${prefix}-${serial++}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, activo, business_type, suscripcion_estado, suscripcion_vencimiento) VALUES (?, ?, 1, 'PET_GROOMING', 'activo', '2099-12-31')",
    [prefix, slug]);
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
  const result = await q<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, ?, ?)", [localId, nombre, options.activo ?? 1]);
  return result.insertId;
}

async function configServicio(localId: number, mascotaId: number, servicioId: number, duracion: number): Promise<void> {
  await q("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, ?)", [localId, mascotaId, servicioId, duracion]);
}

async function configExtra(localId: number, mascotaId: number, extraId: number, duracion: number): Promise<void> {
  await q("INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, ?)", [localId, mascotaId, extraId, duracion]);
}

async function addHorario(localId: number, inicio: string, fin: string, dia = DIA_FUTURO): Promise<void> {
  await q("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, 1)", [localId, dia, inicio, fin]);
}

async function addBloqueo(localId: number, fecha: string, options: { completo?: boolean; inicio?: string; fin?: string } = {}): Promise<void> {
  await q(
    "INSERT INTO bloqueos_local (local_id, fecha, hora_inicio, hora_fin, es_dia_completo) VALUES (?, ?, ?, ?, ?)",
    [localId, fecha, options.inicio ?? null, options.fin ?? null, options.completo ? 1 : 0]);
}

async function addTurno(localId: number, options: {
  fecha: string; hora: string; horaFin: string; mascotaId: number;
  estado?: "activo" | "pendiente_pago" | "cancelado" | "completado"; highDemand?: 0 | 1;
}): Promise<void> {
  await q(
    `INSERT INTO turnos (
       fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono,
       estado, mascota_id, alta_exigencia_snapshot, servicio_nombre_snapshot, duracion_servicio_snapshot
     ) VALUES (?, ?, ?, NULL, ?, 'PET12D fixture', 'PET12D fixture', ?, ?, ?, 'Fixture service', 30)`,
    [options.fecha, options.hora, options.horaFin, localId, options.estado ?? "activo", options.mascotaId, options.highDemand ?? 0]);
}

async function setAltaExigencia(localId: number, mascotaId: number, value: 0 | 1): Promise<void> {
  await q("UPDATE mascotas SET alta_exigencia = ? WHERE id = ? AND local_id = ?", [value, mascotaId, localId]);
}

async function setSettings(localId: number, rule: "MIN_GAP" | "MAX_PER_DAY", amount: number): Promise<void> {
  await q(
    `INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day)
     VALUES (?, ?, ?, ?) AS nuevo
     ON DUPLICATE KEY UPDATE
       high_demand_rule = nuevo.high_demand_rule,
       high_demand_gap_minutes = nuevo.high_demand_gap_minutes,
       high_demand_max_per_day = nuevo.high_demand_max_per_day`,
    [localId, rule, rule === "MIN_GAP" ? amount : null, rule === "MAX_PER_DAY" ? amount : null]);
}

interface HttpResult { status: number; body: string; noStore: boolean }
async function call(path: string, options: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.text(), noStore: response.headers.get("cache-control") === "no-store" };
}

function post(local: LocalFixture, secret: string | null, body: unknown, slug?: string): Promise<HttpResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return call(`/api/pet/public/${slug ?? local.slug}/disponibilidad`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

function json(result: HttpResult): any {
  try { return JSON.parse(result.body); } catch { throw new Error("PET12D_RESPONSE_NOT_JSON"); }
}

function slots(result: HttpResult): Array<{ horaInicio: string; horaFin: string }> {
  return json(result).slots;
}

function starts(result: HttpResult): string[] {
  return slots(result).map(slot => slot.horaInicio);
}

async function fixture(options: { online?: number; active?: number } = {}) {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Fixture", options);
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const servicio = await createServicio(local.id, "Baño", 30);
  await configServicio(local.id, pet, servicio, 45);
  return { local, client, pet, session, servicio };
}

function assertUnavailable(result: HttpResult, code: string): void {
  assert.equal(result.status, 404);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), { error: code });
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
  for (const localId of [...localIds]) {
    await q("DELETE FROM turnos WHERE local_id = ?", [localId]);
    await q("DELETE FROM bloqueos_local WHERE local_id = ?", [localId]);
    await q("DELETE FROM horarios_local WHERE local_id = ?", [localId]);
    await q("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
    // These tables have pet/customer-leading indexes, not local-leading ones.
    // Point-scope fixture cleanup must not scan/lock other tests' sessions/links.
    const pets = await q<(RowDataPacket & { id: number })[]>("SELECT id FROM mascotas WHERE local_id = ?", [localId]);
    for (const pet of pets) {
      await q("DELETE FROM mascota_servicios WHERE mascota_id = ? AND local_id = ?", [pet.id, localId]);
      await q("DELETE FROM mascota_extras WHERE mascota_id = ? AND local_id = ?", [pet.id, localId]);
      await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND local_id = ?", [pet.id, localId]);
    }
    await q("DELETE FROM mascotas WHERE local_id = ?", [localId]);
    const clients = await q<(RowDataPacket & { id: number })[]>("SELECT id FROM clientes WHERE local_id = ?", [localId]);
    for (const client of clients) {
      await q("DELETE FROM pet_client_sessions WHERE cliente_id = ? AND local_id = ?", [client.id, localId]);
    }
    await q("DELETE FROM servicios WHERE local_id = ?", [localId]);
    await q("DELETE FROM extras WHERE local_id = ?", [localId]);
    await q("DELETE FROM clientes WHERE local_id = ?", [localId]);
    await q("DELETE FROM locales WHERE id = ? AND nombre = ?", [localId, prefix]);
    localIds.splice(localIds.indexOf(localId), 1);
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

test("PET-12D auth: Bearer válido, ausente, expirado, revocado y slug distinto", async () => {
  const local = await createLocal();
  const other = await createLocal();
  const client = await createClient(local.id);
  const otherClient = await createClient(other.id, "1123452999", "Otra");
  const pet = await createPet(local.id, "Rocky");
  await link(local.id, pet, client);
  const servicio = await createServicio(local.id, "Baño", 30);
  await configServicio(local.id, pet, servicio, 30);
  const session = await createSession(local.id, client);
  const expired = await createSession(local.id, client, { expiresInSeconds: -60 });
  const revoked = await createSession(local.id, client, { revoked: true });
  const otherSession = await createSession(other.id, otherClient);
  const body = { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA };

  const valid = await post(local, session.secret, body);
  assert.equal(valid.status, 200);

  const noBearer = await post(local, null, body);
  assert.equal(noBearer.status, 401);
  assert.deepEqual(json(noBearer), { error: "PET_SESSION_INVALID" });

  for (const [targetSlug, secret] of [
    [local.slug, expired.secret],
    [local.slug, revoked.secret],
    [other.slug, session.secret],
    [local.slug, otherSession.secret],
  ] as const) {
    const result = await post(local, secret, body, targetSlug);
    assert.equal(result.status, 401);
    assert.equal(result.noStore, true);
    assert.deepEqual(json(result), { error: "PET_SESSION_INVALID" });
  }

  const jwtLike = await post(local, "aaa.bbb.ccc", body);
  assert.equal(jwtLike.status, 401);
  assert.equal(logs.length, 0);
});

test("PET-12D DTO: exige claves exactas y rechaza campos/IDs/fecha inválidos", async () => {
  const { local, session, pet, servicio } = await fixture();
  const base = { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA };

  const missingExtras: Record<string, unknown> = { ...base };
  delete missingExtras.extraIds;
  const invalids: unknown[] = [
    missingExtras,
    { ...base, duracion: 30 },
    { ...base, clienteId: 1 },
    { ...base, localId: local.id },
    { ...base, mascotaId: String(pet) },
    { ...base, mascotaId: 0 },
    { ...base, mascotaId: 1.5 },
    { ...base, mascotaId: 2147483648 },
    { ...base, servicioId: -1 },
    { ...base, extraIds: "3" },
    { ...base, extraIds: [String(servicio)] },
    { ...base, extraIds: [3, 3] },
    { ...base, fecha: "2026-02-30" },
    { ...base, fecha: "20-10-2099" },
  ];
  for (const body of invalids) {
    const result = await post(local, session.secret, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.noStore, true);
    assert.deepEqual(json(result), { error: "PET_BOOKING_INVALID" });
  }
});

test("PET-12D DTO: extraIds [] es válido y devuelve slots vacíos sin horarios", async () => {
  const { local, session, pet, servicio } = await fixture();
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { fecha: FECHA_FUTURA, duracionMinutos: 45, slots: [] });
});

test("PET-12D validador: 100 extraIds válidos pasan, 101 y duplicados fallan con PET_BOOKING_INVALID", () => {
  const validos = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.deepEqual(validarConsultaDisponibilidadPublica({ mascotaId: 1, servicioId: 1, extraIds: validos, fecha: FECHA_FUTURA }).extraIds, validos);

  for (const body of [
    { mascotaId: 1, servicioId: 1, extraIds: [...validos, 101], fecha: FECHA_FUTURA },
    { mascotaId: 1, servicioId: 1, extraIds: [3, 3], fecha: FECHA_FUTURA },
  ]) {
    assert.throws(() => validarConsultaDisponibilidadPublica(body), (error: unknown) =>
      error instanceof PublicBookingError && error.status === 400 && error.code === "PET_BOOKING_INVALID");
  }
});

test("PET-12D validador: normaliza extraIds ascendente sin cambiar semántica", () => {
  const parsed = validarConsultaDisponibilidadPublica({ mascotaId: 2, servicioId: 3, extraIds: [9, 4, 7], fecha: FECHA_FUTURA });
  assert.deepEqual(parsed, { mascotaId: 2, servicioId: 3, extraIds: [4, 7, 9], fecha: FECHA_FUTURA });
});

test("PET-12D autoriza mascota propia y compartida M:N", async () => {
  const local = await createLocal();
  const first = await createClient(local.id, "1123452000", "Ana");
  const second = await createClient(local.id, "1123452001", "Bea");
  const pet = await createPet(local.id, "Compartida");
  await link(local.id, pet, first);
  await link(local.id, pet, second);
  const servicio = await createServicio(local.id, "Corte", 30);
  await configServicio(local.id, pet, servicio, 30);
  for (const client of [first, second]) {
    const session = await createSession(local.id, client);
    const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
    assert.equal(result.status, 200);
  }
});

test("PET-12D mascota inexistente es 404 PET_MASCOTA_UNAVAILABLE indistinguible", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const session = await createSession(local.id, client);
  const result = await post(local, session.secret, { mascotaId: 2147483647, servicioId: 1, extraIds: [], fecha: FECHA_FUTURA });
  assertUnavailable(result, "PET_MASCOTA_UNAVAILABLE");
});

test("PET-12D mascota ajena (otro responsable del mismo local) es 404 PET_MASCOTA_UNAVAILABLE", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const owner = await createClient(local.id, "1123452001", "Otra");
  const session = await createSession(local.id, client);
  const pet = await createPet(local.id, "De otra");
  await link(local.id, pet, owner);
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: 1, extraIds: [], fecha: FECHA_FUTURA });
  assertUnavailable(result, "PET_MASCOTA_UNAVAILABLE");
});

for (const [label, options] of [
  ["inactiva", { active: 0, online: 1 }],
  ["offline", { active: 1, online: 0 }],
] as const) {
  test(`PET-12D mascota ${label} es 404 PET_MASCOTA_UNAVAILABLE indistinguible`, async () => {
    const local = await createLocal();
    const client = await createClient(local.id);
    const session = await createSession(local.id, client);
    const pet = await createPet(local.id, "No elegible", options);
    await link(local.id, pet, client);
    const result = await post(local, session.secret, { mascotaId: pet, servicioId: 1, extraIds: [], fecha: FECHA_FUTURA });
    assertUnavailable(result, "PET_MASCOTA_UNAVAILABLE");
  });
}

test("PET-12D vínculo eliminado oculta la mascota (404)", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const session = await createSession(local.id, client);
  const pet = await createPet(local.id, "Desvinculada");
  await link(local.id, pet, client);
  const servicio = await createServicio(local.id, "Corte", 30);
  await configServicio(local.id, pet, servicio, 30);
  assert.equal((await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })).status, 200);
  await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [pet, client, local.id]);
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  assertUnavailable(result, "PET_MASCOTA_UNAVAILABLE");
});

test("PET-12D mascota de otro tenant real es 404 indistinguible", async () => {
  const local = await createLocal();
  const other = await createLocal();
  const client = await createClient(local.id);
  const otherClient = await createClient(other.id, "1123452999", "Otra");
  const session = await createSession(local.id, client);
  const deOtroTenant = await createPet(other.id, "Ajena");
  await link(other.id, deOtroTenant, otherClient);
  const result = await post(local, session.secret, { mascotaId: deOtroTenant, servicioId: 1, extraIds: [], fecha: FECHA_FUTURA });
  assertUnavailable(result, "PET_MASCOTA_UNAVAILABLE");
});

test("PET-12D servicio permitido y duración personalizada (no la genérica)", async () => {
  const local = await createLocal();
  const client = await createClient(local.id);
  const pet = await createPet(local.id, "Rocky");
  await link(local.id, pet, client);
  const session = await createSession(local.id, client);
  const servicio = await createServicio(local.id, "Baño", 99);
  await configServicio(local.id, pet, servicio, 75);
  await addHorario(local.id, "09:00:00", "12:00:00");
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  assert.equal(result.status, 200);
  assert.equal(json(result).duracionMinutos, 75);
});

for (const [label, mutate] of [
  ["no asociado", async (local: LocalFixture, pet: number, servicio: number) => {
    await q("DELETE FROM mascota_servicios WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  }],
  ["inactivo", async (local: LocalFixture, _pet: number, servicio: number) => {
    await q("UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", [servicio, local.id]);
  }],
] as const) {
  test(`PET-12D servicio ${label} es 404 PET_SERVICE_UNAVAILABLE`, async () => {
    const { local, session, pet, servicio } = await fixture();
    await mutate(local, pet, servicio);
    const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
    assertUnavailable(result, "PET_SERVICE_UNAVAILABLE");
  });
}

test("PET-12D servicio inexistente o de otro tenant es 404 PET_SERVICE_UNAVAILABLE", async () => {
  const { local, session, pet } = await fixture();
  const other = await createLocal();
  const ajeno = await createServicio(other.id, "Ajeno", 30);
  for (const servicioId of [2147483647, ajeno]) {
    const result = await post(local, session.secret, { mascotaId: pet, servicioId, extraIds: [], fecha: FECHA_FUTURA });
    assertUnavailable(result, "PET_SERVICE_UNAVAILABLE");
  }
});

test("PET-12D extras: ninguno, uno, varios y orden indistinto", async () => {
  const { local, session, pet, servicio } = await fixture();
  const extraUno = await createExtra(local.id, "Uñas");
  const extraDos = await createExtra(local.id, "Perfume");
  await configExtra(local.id, pet, extraUno, 15);
  await configExtra(local.id, pet, extraDos, 25);
  await addHorario(local.id, "09:00:00", "12:00:00");

  const ninguno = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  assert.equal(json(ninguno).duracionMinutos, 45);

  const uno = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [extraUno], fecha: FECHA_FUTURA });
  assert.equal(json(uno).duracionMinutos, 60);

  const varios = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [extraUno, extraDos], fecha: FECHA_FUTURA });
  assert.equal(json(varios).duracionMinutos, 85);

  const reordenado = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [extraDos, extraUno], fecha: FECHA_FUTURA });
  assert.deepEqual(json(reordenado), json(varios));
});

for (const [label, mutate] of [
  ["no configurado", async (local: LocalFixture, pet: number, extra: number) => {
    await q("DELETE FROM mascota_extras WHERE local_id = ? AND mascota_id = ? AND extra_id = ?", [local.id, pet, extra]);
  }],
  ["inactivo", async (local: LocalFixture, _pet: number, extra: number) => {
    await q("UPDATE extras SET activo = 0 WHERE id = ? AND local_id = ?", [extra, local.id]);
  }],
] as const) {
  test(`PET-12D extra ${label} es 404 PET_EXTRA_UNAVAILABLE`, async () => {
    const { local, session, pet, servicio } = await fixture();
    const extra = await createExtra(local.id, "Uñas");
    await configExtra(local.id, pet, extra, 15);
    await mutate(local, pet, extra);
    const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [extra], fecha: FECHA_FUTURA });
    assertUnavailable(result, "PET_EXTRA_UNAVAILABLE");
  });
}

test("PET-12D extra de otro tenant es 404 PET_EXTRA_UNAVAILABLE", async () => {
  const { local, session, pet, servicio } = await fixture();
  const other = await createLocal();
  const ajeno = await createExtra(other.id, "Ajeno");
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [ajeno], fecha: FECHA_FUTURA });
  assertUnavailable(result, "PET_EXTRA_UNAVAILABLE");
});

test("PET-12D disponibilidad: sin horarios devuelve vacío; una y múltiples franjas", async () => {
  const { local, session, pet, servicio } = await fixture();
  const body = { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA };
  assert.deepEqual(slots(await post(local, session.secret, body)), []);

  await addHorario(local.id, "09:00:00", "10:00:00");
  assert.deepEqual(slots(await post(local, session.secret, body)), [{ horaInicio: "09:00", horaFin: "09:45" }]);

  await addHorario(local.id, "11:00:00", "12:00:00");
  assert.deepEqual(slots(await post(local, session.secret, body)), [
    { horaInicio: "09:00", horaFin: "09:45" },
    { horaInicio: "11:00", horaFin: "11:45" },
  ]);
});

test("PET-12D disponibilidad: cierre exacto y anclaje en :15", async () => {
  const { local, session, pet, servicio } = await fixture();
  await q("UPDATE mascota_servicios SET duracion_minutos = 60 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  await addHorario(local.id, "09:00:00", "10:00:00");
  assert.deepEqual(slots(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })),
    [{ horaInicio: "09:00", horaFin: "10:00" }]);

  await q("DELETE FROM horarios_local WHERE local_id = ?", [local.id]);
  await q("UPDATE mascota_servicios SET duracion_minutos = 30 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  await addHorario(local.id, "09:15:00", "11:15:00");
  assert.deepEqual(starts(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })),
    ["09:15", "09:45", "10:15", "10:45"]);
});

test("PET-12D disponibilidad: bloqueo parcial y día completo", async () => {
  const { local, session, pet, servicio } = await fixture();
  const body = { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA };
  await q("UPDATE mascota_servicios SET duracion_minutos = 30 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  await addHorario(local.id, "09:00:00", "11:00:00");
  await addBloqueo(local.id, FECHA_FUTURA, { inicio: "09:30:00", fin: "10:00:00" });
  assert.deepEqual(starts(await post(local, session.secret, body)), ["09:00", "10:00", "10:30"]);

  await q("DELETE FROM bloqueos_local WHERE local_id = ?", [local.id]);
  await addBloqueo(local.id, FECHA_FUTURA, { completo: true });
  assert.deepEqual(slots(await post(local, session.secret, body)), []);
});

test("PET-12D disponibilidad: ocupación por turno activo excluye el solape", async () => {
  const { local, session, pet, servicio } = await fixture();
  await q("UPDATE mascota_servicios SET duracion_minutos = 30 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  await addHorario(local.id, "09:00:00", "11:00:00");
  await addTurno(local.id, { fecha: FECHA_FUTURA, hora: "09:30:00", horaFin: "10:00:00", mascotaId: pet });
  assert.deepEqual(starts(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })),
    ["09:00", "10:00", "10:30"]);
});

test("PET-12D disponibilidad: fecha pasada devuelve slots vacíos", async () => {
  const { local, session, pet, servicio } = await fixture();
  await addHorario(local.id, "09:00:00", "12:00:00", new Date(Date.UTC(2000, 0, 1)).getUTCDay());
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_PASADA });
  assert.equal(result.status, 200);
  assert.deepEqual(slots(result), []);
});

test("PET-12D disponibilidad: hoy filtra inicios pasados en timezone Argentina", async () => {
  const { local, session, pet, servicio } = await fixture();
  const temporal = contextoTemporalArgentina();
  const [year, month, day] = temporal.fecha.split("-").map(Number);
  const diaHoy = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  await addHorario(local.id, "00:00:00", "23:30:00", diaHoy);
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: temporal.fecha });
  assert.equal(result.status, 200);
  const inicio = starts(result);
  const primeroEsperado = Math.ceil(temporal.minimumStartMinutes / 30) * 30;
  if (temporal.minimumStartMinutes >= 1440 || primeroEsperado + 30 > 1410) {
    assert.deepEqual(inicio, []);
  } else {
    const texto = `${String(Math.floor(primeroEsperado / 60)).padStart(2, "0")}:${String(primeroEsperado % 60).padStart(2, "0")}`;
    assert.equal(inicio[0], texto);
  }
});

test("PET-12D high-demand MIN_GAP intradía respeta el gap desde el vecino anterior", async () => {
  const { local, session, pet, servicio } = await fixture();
  await setAltaExigencia(local.id, pet, 1);
  await setSettings(local.id, "MIN_GAP", 60);
  await addHorario(local.id, "09:00:00", "12:00:00");
  await addTurno(local.id, { fecha: FECHA_FUTURA, hora: "08:00:00", horaFin: "09:00:00", mascotaId: pet, highDemand: 1 });
  const inicio = starts(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA }));
  assert.equal(inicio.includes("09:00"), false);
  assert.equal(inicio.includes("09:30"), false);
  assert.equal(inicio.includes("10:00"), true);
});

test("PET-12D high-demand MIN_GAP interfecha usa el vecino del día anterior", async () => {
  const { local, session, pet, servicio } = await fixture();
  await setAltaExigencia(local.id, pet, 1);
  await setSettings(local.id, "MIN_GAP", 600);
  await addHorario(local.id, "09:00:00", "12:00:00");
  await addTurno(local.id, { fecha: "2099-10-19", hora: "23:30:00", horaFin: "23:59:00", mascotaId: pet, highDemand: 1 });
  const inicio = starts(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA }));
  assert.equal(inicio.includes("09:00"), false);
  assert.equal(inicio.includes("09:30"), false);
  assert.equal(inicio.includes("10:00"), true);
});

test("PET-12D high-demand MIN_GAP respeta el vecino posterior en otra fecha", async () => {
  const { local, session, pet, servicio } = await fixture();
  await setAltaExigencia(local.id, pet, 1);
  await setSettings(local.id, "MIN_GAP", 600);
  await q("UPDATE mascota_servicios SET duracion_minutos = 60 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [local.id, pet, servicio]);
  await addHorario(local.id, "13:00:00", "15:00:00");
  await addTurno(local.id, { fecha: "2099-10-21", hora: "00:00:00", horaFin: "00:30:00", mascotaId: pet, highDemand: 1 });
  assert.deepEqual(slots(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })),
    [{ horaInicio: "13:00", horaFin: "14:00" }]);
});

test("PET-12D high-demand MAX_PER_DAY vacía cuando el día llegó al máximo", async () => {
  const { local, session, pet, servicio } = await fixture();
  await setAltaExigencia(local.id, pet, 1);
  await setSettings(local.id, "MAX_PER_DAY", 1);
  await addHorario(local.id, "09:00:00", "12:00:00");
  await addTurno(local.id, { fecha: FECHA_FUTURA, hora: "08:00:00", horaFin: "08:30:00", mascotaId: pet, highDemand: 1 });
  assert.deepEqual(slots(await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA })), []);
});

test("PET-12D alta exigencia sin settings devuelve 409 PET_BOOKING_UNAVAILABLE", async () => {
  const { local, session, pet, servicio } = await fixture();
  await setAltaExigencia(local.id, pet, 1);
  await addHorario(local.id, "09:00:00", "12:00:00");
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  assert.equal(result.status, 409);
  assert.equal(result.noStore, true);
  assert.deepEqual(json(result), { error: "PET_BOOKING_UNAVAILABLE" });
});

test("PET-12D proyección pública mínima: sin precio, tenant ni detalles de reglas", async () => {
  const { local, session, pet, servicio } = await fixture();
  await createServicio(local.id, "Con precio", 30, { precio: "1234.50" });
  await addHorario(local.id, "09:00:00", "12:00:00");
  const result = await post(local, session.secret, { mascotaId: pet, servicioId: servicio, extraIds: [], fecha: FECHA_FUTURA });
  const payload = json(result);
  assert.deepEqual(Object.keys(payload).sort(), ["duracionMinutos", "fecha", "slots"]);
  const rendered = JSON.stringify(payload);
  for (const field of ["precio", "local_id", "localId", "clienteId", "altaExigencia", "settings", "1234.50"]) {
    assert.ok(!rendered.includes(field), `la respuesta no debe incluir ${field}`);
  }
});

test("PET-12D regresión: el contrato PET-12C opciones-reserva sigue intacto", async () => {
  const { local, session, pet, servicio } = await fixture();
  const result = await call(`/api/pet/public/${local.slug}/mascotas/${pet}/opciones-reserva`, {
    headers: { Authorization: `Bearer ${session.secret}` },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { servicios: [{ id: servicio, nombre: "Baño", duracionMinutos: 45 }], extras: [] });
});
