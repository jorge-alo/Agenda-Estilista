import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { PoolConnection, QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import petRouter from "../pet.routes";
import { generateOpaqueSecret, hashOpaqueSecret } from "../session/opaqueSecret";
import { petSessionPublicRouter } from "../session/session.routes";
import type { PetSessionContext } from "../session/session.types";
import publicBookingRouter from "./publicBooking.routes";
import { solicitudesPublicRouter } from "../solicitudes/solicitudes.routes";
import publicLocalRouter from "../../publicLocal/publicLocal.routes";

export { pool };
export const FECHA = "2099-10-20";
export const SIGUIENTE = "2099-10-21";
let prefix = `pet12e-${randomUUID()}`;
const locals: number[] = [];
const jwtSecret = "PET12E_TEST_ONLY";
let server: Server;
let port: number;
let fixtureSerial = 0;
export const logs: unknown[][] = [];

// mysql2 errors can contain SQL and credentials. Never expose them to the reporter.
export async function q<T extends QueryResult = RowDataPacket[]>(sql: string, values: unknown[] = []): Promise<T> {
  try { return (await pool.query<T>(sql, values))[0]; }
  catch { throw new Error("PET12E_FIXTURE_DB_OPERATION_FAILED"); }
}

export interface Fixture {
  localId: number;
  slug: string;
  clienteId: number;
  mascotaId: number;
  servicioId: number;
  extraIds: number[];
  sessionId: number;
  secret: string;
}

export async function session(localId: number, clienteId: number, ttl = 3600) {
  const secret = generateOpaqueSecret();
  const row = await q<ResultSetHeader>(
    `INSERT INTO pet_client_sessions (local_id, cliente_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
    [localId, clienteId, hashOpaqueSecret(secret), ttl],
  );
  return { sessionId: row.insertId, secret };
}

export async function fixture(): Promise<Fixture> {
  const slug = `${prefix}-${fixtureSerial++}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, activo, business_type, suscripcion_estado, suscripcion_vencimiento) VALUES (?, ?, 1, 'PET_GROOMING', 'activo', '2099-12-31')", [prefix, slug]);
  const localId = local.insertId;
  locals.push(localId);
  const client = await q<ResultSetHeader>(
    "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, 'PET12E Ana', '1123452000', ?)",
    [localId, normalizeClientPhone("1123452000")]);
  const pet = await q<ResultSetHeader>(
    "INSERT INTO mascotas (local_id, nombre, activo, reserva_online_habilitada) VALUES (?, 'PET12E Rocky', 1, 1)", [localId]);
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [localId, pet.insertId, client.insertId]);
  const service = await q<ResultSetHeader>(
    "INSERT INTO servicios (local_id, nombre, duracion, precio, activo) VALUES (?, 'PET12E Baño', 99, 1234.50, 1)", [localId]);
  await q("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)",
    [localId, pet.insertId, service.insertId]);
  const extraIds: number[] = [];
  for (const [name, duration] of [["PET12E Uñas", 15], ["PET12E Perfume", 25]] as const) {
    const extra = await q<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, ?, 1)", [localId, name]);
    extraIds.push(extra.insertId);
    await q("INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, ?)",
      [localId, pet.insertId, extra.insertId, duration]);
  }
  await horario(localId, FECHA, "09:00", "13:00");
  return { localId, slug, clienteId: client.insertId, mascotaId: pet.insertId, servicioId: service.insertId,
    extraIds, ...await session(localId, client.insertId) };
}

export function context(f: Fixture): PetSessionContext {
  return { sessionId: f.sessionId, localId: f.localId, clienteId: f.clienteId };
}

export function body(f: Fixture, overrides: Record<string, unknown> = {}) {
  return { mascotaId: f.mascotaId, servicioId: f.servicioId, extraIds: [] as number[], fecha: FECHA, hora: "10:00", ...overrides };
}

export interface ApiResult { status: number; data: unknown; noStore: boolean }
export async function call(path: string, options: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(25000) });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error("PET12E_RESPONSE_NOT_JSON"); }
  return { status: response.status, data, noStore: response.headers.get("cache-control") === "no-store" };
}

export function post(f: Fixture, payload: unknown = body(f), secret: string | null = f.secret): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/turnos`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(payload),
  });
}

export function publicSlots(f: Fixture, candidatePet = f.mascotaId): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/disponibilidad`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.secret}` },
    body: JSON.stringify({ mascotaId: candidatePet, servicioId: f.servicioId, extraIds: [], fecha: FECHA }),
  });
}

export function adminSlots(f: Fixture, candidatePet = f.mascotaId): Promise<ApiResult> {
  const params = new URLSearchParams({ mascotaId: String(candidatePet), servicioId: String(f.servicioId), fecha: FECHA });
  return call(`/api/pet/admin/disponibilidad?${params.toString()}`, {
    headers: { Authorization: `Bearer ${jwt.sign(
      { userId: 1, localId: f.localId, rol: "admin" }, jwtSecret, { expiresIn: "1m" })}` },
  });
}

export function admin(f: Fixture, payload = body(f)): Promise<ApiResult> {
  return call("/api/pet/admin/turnos", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign(
      { userId: 1, localId: f.localId, rol: "admin" }, jwtSecret, { expiresIn: "1m" })}` },
    body: JSON.stringify({ ...payload, clienteId: f.clienteId }),
  });
}

export function reschedule(f: Fixture, turnoId: number, hora: string): Promise<ApiResult> {
  return call(`/api/pet/admin/turnos/${turnoId}/reprogramar`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign(
      { userId: 1, localId: f.localId, rol: "admin" }, jwtSecret, { expiresIn: "1m" })}` },
    body: JSON.stringify({ fecha: FECHA, hora }),
  });
}

export function logout(f: Fixture): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/session/logout`, { method: "POST", headers: { Authorization: `Bearer ${f.secret}` } });
}

export function rejected(result: ApiResult, status: number, error: string): void {
  assert.equal(result.status, status);
  assert.equal(result.noStore, true);
  assert.deepEqual(result.data, status === 500 ? { code: error } : { error });
}

export function record(result: ApiResult): Record<string, unknown> {
  assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
  return result.data as Record<string, unknown>;
}

export async function counts(f: Fixture): Promise<{ turnos: number; extras: number }> {
  const [row] = await q<(RowDataPacket & { turnos: number; extras: number })[]>(
    `SELECT (SELECT COUNT(*) FROM turnos WHERE local_id = ?) AS turnos,
       (SELECT COUNT(*) FROM turno_extras te JOIN turnos t ON t.id = te.turno_id WHERE t.local_id = ?) AS extras`,
    [f.localId, f.localId]);
  return { turnos: Number(row.turnos), extras: Number(row.extras) };
}

export async function sessionState(f: Fixture) {
  const [row] = await q<RowDataPacket[]>(
    "SELECT CAST(created_at AS CHAR) AS created, CAST(expires_at AS CHAR) AS expires, CAST(revoked_at AS CHAR) AS revoked FROM pet_client_sessions WHERE id = ? AND local_id = ?",
    [f.sessionId, f.localId]);
  return { ...row };
}

export async function horario(localId: number, fecha: string, inicio: string, fin: string): Promise<void> {
  const [year, month, day] = fecha.split("-").map(Number);
  await q("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, 1)",
    [localId, new Date(Date.UTC(year, month - 1, day)).getUTCDay(), inicio, fin]);
}

export async function highDemand(f: Fixture, rule: "MIN_GAP" | "MAX_PER_DAY", value: number): Promise<void> {
  await q("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
  await q("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day) VALUES (?, ?, ?, ?)",
    [f.localId, rule, rule === "MIN_GAP" ? value : null, rule === "MAX_PER_DAY" ? value : null]);
}

export async function existing(f: Fixture, hora: string, fin: string, fecha = FECHA, estado = "activo", alta = 0): Promise<void> {
  await q(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
       cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot, duracion_servicio_snapshot,
       alta_exigencia_snapshot, estado, pago_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'PET12E fixture', 'PET12E fixture', ?, 'PET12E fixture', 60, ?, ?, NULL)`,
    [f.localId, fecha, hora, fin, f.mascotaId, f.clienteId, f.servicioId, alta, estado]);
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

export async function watchdog<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PET12E_WATCHDOG")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

export function instrument(t: TestContext, decorate: (connection: PoolConnection) => void): void {
  const get = pool.getConnection.bind(pool);
  const seen = new WeakSet<object>();
  t.mock.method(pool, "getConnection", async () => {
    const conn = await get();
    if (!seen.has(conn)) { seen.add(conn); decorate(conn); }
    return conn;
  });
}

export async function waitForLock(blocker: number, requester: number | null, table: string): Promise<number> {
  return watchdog((async () => {
    for (;;) {
      const rows = await q<(RowDataPacket & { requester: number })[]>(
        `SELECT r.PROCESSLIST_ID AS requester FROM performance_schema.data_lock_waits w
         JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
         JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE b.PROCESSLIST_ID = ? AND (? IS NULL OR r.PROCESSLIST_ID = ?)
           AND l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = ?`, [blocker, requester, requester, table]);
      if (rows.length) return Number(rows[0].requester);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  })());
}

export async function waitForExpiry(f: Fixture): Promise<void> {
  await watchdog((async () => {
    for (;;) {
      const [row] = await q<(RowDataPacket & { expired: number })[]>(
        "SELECT expires_at <= UTC_TIMESTAMP(3) AS expired FROM pet_client_sessions WHERE id = ? AND local_id = ?", [f.sessionId, f.localId]);
      if (row.expired === 1) return;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  })());
}

export function useBookingHarness(label = "pet12e"): void {
  prefix = `${label}-${randomUUID()}`;
  before(async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/public/local", publicLocalRouter);
    app.use("/api/pet/public", solicitudesPublicRouter);
    app.use("/api/pet/admin", petRouter);
    app.use("/api/pet/public", petSessionPublicRouter);
    app.use("/api/pet/public", publicBookingRouter);
    app.use(sanitizedErrorMiddleware);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = address.port;
  });
  beforeEach(t => {
    if (!("mock" in t)) throw new Error("PET12E_MOCKS_UNAVAILABLE");
    t.mock.property(process, "env", { ...process.env, JWT_SECRET: jwtSecret });
    logs.length = 0;
    for (const method of ["log", "warn", "error", "info"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
  });
  afterEach(async t => {
    if ("mock" in t) t.mock.restoreAll();
    for (const localId of locals) {
      await q("DELETE FROM turnos WHERE local_id = ?", [localId]);
      await q("DELETE FROM bloqueos_local WHERE local_id = ?", [localId]);
      await q("DELETE FROM horarios_local WHERE local_id = ?", [localId]);
      await q("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
      await q("DELETE FROM mascota_servicios WHERE local_id = ?", [localId]);
      await q("DELETE FROM mascota_extras WHERE local_id = ?", [localId]);
      await q("DELETE FROM servicios WHERE local_id = ?", [localId]);
      await q("DELETE FROM extras WHERE local_id = ?", [localId]);
      await q("DELETE FROM solicitudes_pet WHERE local_id = ?", [localId]);
      await q("DELETE FROM pagos_suscripcion WHERE local_id = ?", [localId]);
      await q("DELETE FROM locales WHERE id = ? AND nombre = ?", [localId, prefix]);
    }
    locals.length = 0;
  });
  after(async () => {
    try {
      const [row] = await q<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM locales WHERE nombre = ?", [prefix]);
      assert.equal(Number(row.total), 0);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      await pool.end();
    }
  });
}
