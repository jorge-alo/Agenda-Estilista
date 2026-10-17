import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import petRouter from "../pet.routes";

const prefix = `pet10c2-${randomUUID()}`;
let nextPhone = 3000;
function testPhone() { return `112345${nextPhone++}`; }
const secret = "PET10C2_FICTICIO_TEST";
const fixtureLocales: number[] = [];
const activeRequests = new Set<Promise<ApiResult>>();
const ownedThreads = new Set<number>();
let server: Server;
let port: number;

type ApiResult = { status: number; data: Record<string, unknown> };
type Converted = { solicitudId: number; estado: string; cliente: { id: number; reutilizado: boolean }; mascota: { id: number } };

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function watchdog<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Watchdog PET-10C.2: ${label}`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

function jwtLocal(localId: number) { return jwt.sign({ userId: 1, localId, rol: "admin" }, secret); }

function http(method: "POST" | "PATCH", path: string, localId: number, body: object): Promise<ApiResult> {
  const pending = (async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/pet/admin${path}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtLocal(localId)}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  })();
  activeRequests.add(pending);
  void pending.then(() => { activeRequests.delete(pending); }, () => { activeRequests.delete(pending); });
  return pending;
}
function convertir(localId: number, id: number, body: object = {}) { return http("POST", `/solicitudes/${id}/convertir`, localId, body); }
function descartar(localId: number, id: number) { return http("PATCH", `/solicitudes/${id}/estado`, localId, { estado: "DESCARTADA" }); }

async function local(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')",
    [prefix, `${prefix}-${fixtureLocales.length}`]);
  fixtureLocales.push(result.insertId);
  return result.insertId;
}

async function solicitud(localId: number, telefono: string, nombre: string, estado = "NUEVA"): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre, estado)
     VALUES (?, 'Nombre declarado', ?, ?, ?)`, [localId, telefono, nombre, estado]);
  return result.insertId;
}

async function esperarLock(requesting: number | null, blocking: number, table: string): Promise<void> {
  const deadline = Date.now() + 15000; // Watchdog: el orden lo establece data_lock_waits.
  while (Date.now() < deadline) {
    const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
       JOIN performance_schema.threads blocker ON blocker.THREAD_ID = w.BLOCKING_THREAD_ID
       JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
       JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
       WHERE blocker.PROCESSLIST_ID = ? AND (? IS NULL OR requester.PROCESSLIST_ID = ?)
         AND requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = ?`,
      [blocking, requesting, requesting, table]);
    if (rows[0].total > 0) return;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error(`No se observó espera InnoDB real sobre ${table}; bloqueador esperado ${blocking}`);
}

async function diagnosticarLocks() {
  const [rows] = await pool.query<(RowDataPacket & {
    solicitante: number; bloqueador: number; transaccion_solicitante: string; transaccion_bloqueador: string;
    tabla: string; indice: string; modo_solicitado: string; modo_bloqueador: string;
  })[]>(
    `SELECT requester.PROCESSLIST_ID AS solicitante, blocker.PROCESSLIST_ID AS bloqueador,
            w.REQUESTING_ENGINE_TRANSACTION_ID AS transaccion_solicitante,
            w.BLOCKING_ENGINE_TRANSACTION_ID AS transaccion_bloqueador,
            requested.OBJECT_NAME AS tabla, requested.INDEX_NAME AS indice,
            requested.LOCK_MODE AS modo_solicitado, held.LOCK_MODE AS modo_bloqueador
     FROM performance_schema.data_lock_waits w
     JOIN performance_schema.threads blocker ON blocker.THREAD_ID = w.BLOCKING_THREAD_ID
     JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
     JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
     JOIN performance_schema.data_locks held ON held.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
     WHERE requested.OBJECT_SCHEMA = DATABASE()`);
  return rows;
}

async function transaccionDe(thread: number): Promise<string> {
  const [rows] = await pool.query<(RowDataPacket & { trx_id: string })[]>(
    "SELECT trx_id FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ?", [thread]);
  assert.equal(rows.length, 1, `transacción activa de la conversión en thread ${thread}`);
  return String(rows[0].trx_id);
}

async function esperarUniqueBloqueadaPor(trxId: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const waits = await diagnosticarLocks();
    const espera = waits.find(row => row.tabla === "clientes" && row.indice === "unique_cliente_local"
      && String(row.transaccion_bloqueador) === trxId && String(row.transaccion_solicitante) !== trxId);
    if (espera) return espera;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error(`No se observó UNIQUE clientes bloqueada por la transacción ${trxId}`);
}

async function sinEspera(thread: number): Promise<void> {
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
     JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
     WHERE t.PROCESSLIST_ID = ?`, [thread]);
  assert.equal(rows[0].total, 0, `thread ${thread} sin lock waits residuales`);
}

async function integridad(ids: number[], localId: number, telefono: string, total: number): Promise<void> {
  const [requests] = await pool.query<(RowDataPacket & {
    id: number; estado: string; cliente_id: number | null; mascota_id: number | null; converted_at: Date | null;
    responsable_nombre: string; mascota_nombre: string;
  })[]>("SELECT id, estado, cliente_id, mascota_id, converted_at, responsable_nombre, mascota_nombre FROM solicitudes_pet WHERE local_id = ? ORDER BY id", [localId]);
  assert.equal(requests.length, total);
  assert.deepEqual(requests.map(row => row.id).sort(), ids.slice().sort());
  const clientIds = new Set<number>();
  const petIds = new Set<number>();
  for (const row of requests) {
    assert.equal(row.estado, "CONVERTIDA");
    assert.ok(row.cliente_id && row.mascota_id && row.converted_at);
    assert.equal(row.responsable_nombre, "Nombre declarado", "el snapshot permanece intacto");
    clientIds.add(row.cliente_id);
    petIds.add(row.mascota_id);
    const [links] = await pool.query<(RowDataPacket & { cliente_id: number })[]>(
      "SELECT cliente_id FROM mascota_clientes WHERE local_id = ? AND mascota_id = ?", [localId, row.mascota_id]);
    assert.equal(links.length, 1);
    assert.equal(links[0].cliente_id, row.cliente_id);
    for (const table of ["mascota_servicios", "mascota_extras"] as const) {
      const counts: (RowDataPacket & { total: number })[] = (await pool.query<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM ${table} WHERE local_id = ? AND mascota_id = ?`, [localId, row.mascota_id]))[0];
      assert.equal(counts[0].total, 0);
    }
  }
  assert.equal(clientIds.size, 1);
  assert.equal(petIds.size, total);
  const [clients] = await pool.query<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM clientes WHERE local_id = ? AND telefono_normalizado = ?", [localId, normalizeClientPhone(telefono)]);
  assert.equal(clients.length, 1);
  assert.ok(clientIds.has(clients[0].id));
  const [pets] = await pool.query<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM mascotas WHERE local_id = ?", [localId]);
  assert.equal(pets.length, total);
  assert.ok(pets.every(pet => petIds.has(pet.id)));
  const [links] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM mascota_clientes WHERE local_id = ?", [localId]);
  assert.equal(links[0].total, total);
}

// La pausa sucede DESPUÉS de que MySQL confirma el lock/la escritura, pero ANTES de devolver la respuesta al service.
function retenerConversion(t: TestContext, firstLocal: number, point: "local" | "solicitud" | "cliente", failAfterClient = false) {
  const locked = barrier<void>();
  const release = barrier<void>();
  const secondAttempt = barrier<number>();
  let firstThread = 0;
  let secondAcquired = false;
  let rolledBackClientId: number | null = null;
  const phases: string[] = [];
  const instrumented = new WeakSet<object>();
  const originalGet = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGet();
    ownedThreads.add(conn.threadId);
    if (instrumented.has(conn)) return conn;
    instrumented.add(conn);
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const sql = String(args[0]);
      const isLocal = sql.includes("FROM locales WHERE id = ? FOR UPDATE") &&
        Array.isArray(args[1]) && args[1][0] === firstLocal;
      if (isLocal && !firstThread) firstThread = conn.threadId;
      if (isLocal && conn.threadId !== firstThread) {
        secondAttempt.resolve(conn.threadId);
        return query(...args).then(result => { secondAcquired = true; return result; });
      }
      if (conn.threadId === firstThread) {
        if (isLocal) phases.push("A: local FOR UPDATE");
        if (sql.includes("FROM solicitudes_pet WHERE id = ? AND local_id = ? FOR UPDATE")) phases.push("A: solicitud FOR UPDATE");
        if (sql.includes("SELECT id FROM clientes WHERE telefono_normalizado = ? AND local_id = ?")) phases.push("A: SELECT cliente");
        if (sql.includes("INSERT INTO clientes")) phases.push("A: INSERT cliente");
        if (sql.includes("INSERT INTO mascotas")) phases.push("A: INSERT mascota");
        if (sql.includes("INSERT INTO mascota_clientes")) phases.push("A: INSERT vínculo");
        if (sql.includes("UPDATE solicitudes_pet")) phases.push("A: UPDATE solicitud");
        if (point === "local" && isLocal) {
          return query(...args).then(async result => { locked.resolve(); await release.promise; return result; });
        }
        if (point === "solicitud" && sql.includes("FROM solicitudes_pet WHERE id = ? AND local_id = ? FOR UPDATE")) {
          return query(...args).then(async result => { locked.resolve(); await release.promise; return result; });
        }
        if (point === "cliente" && sql.includes("INSERT INTO clientes")) {
          return query(...args).then(async result => {
            rolledBackClientId = (result[0] as ResultSetHeader).insertId;
            locked.resolve();
            await release.promise;
            return result;
          });
        }
        if (failAfterClient && sql.includes("INSERT INTO mascota_clientes")) {
          throw new Error("PET-10C.2 fallo inducido tras cliente y mascota");
        }
      }
      return query(...args);
    }) as typeof conn.query);
    return conn;
  });
  return {
    locked: locked.promise, release: () => release.resolve(), secondAttempt: secondAttempt.promise,
    firstThread: () => firstThread, secondAcquired: () => secondAcquired,
    rolledBackClientId: () => rolledBackClientId,
    phases: () => phases.slice(),
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const [[target]] = await pool.query<(RowDataPacket & { host: string; name: string })[]>(
    "SELECT @@hostname AS host, DATABASE() AS name");
  assert.equal(target.name, "agenda_db");
  assert.equal(target.host, "570d7d86a989", "solo Docker agenda_mysql");
});

beforeEach(t => {
  if (!("mock" in t)) throw new Error("Mock unavailable");
  t.mock.property(process, "env", { ...process.env, JWT_SECRET: secret });
});

afterEach(async () => {
  // También cuando falla el watchdog: no pasar al siguiente escenario con requests activas.
  await Promise.allSettled([...activeRequests]);
  assert.equal(activeRequests.size, 0);
  for (const thread of ownedThreads) await sinEspera(thread);
});

after(async () => {
  try {
    // No borrar filas mientras una transacción iniciada vía HTTP pueda seguir usando el fixture.
    await Promise.allSettled([...activeRequests]);
    assert.equal(activeRequests.size, 0, "todas las requests HTTP terminadas antes del teardown");
    for (const thread of ownedThreads) await sinEspera(thread);
    for (const id of fixtureLocales) {
      await pool.query("DELETE FROM solicitudes_pet WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    }
    const [remaining] = await pool.query<(RowDataPacket & { total: number })[]>(
      "SELECT COUNT(*) AS total FROM locales WHERE nombre = ?", [prefix]);
    assert.equal(remaining[0].total, 0, "fixtures PET-10C.2 limpios");
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});

for (const initial of ["NUEVA", "CONTACTADA"]) {
  test(`misma solicitud ${initial}: segunda conversión espera y no duplica`, { timeout: 30000 }, async t => {
    const tenant = await local();
    const phone = testPhone();
    const id = await solicitud(tenant, phone, "Mascota declarada", initial);
    const hold = retenerConversion(t, tenant, "solicitud");
    const first = convertir(tenant, id, { mascota: { nombre: "Ganadora A" } });
    let second: Promise<ApiResult> | undefined;
    let secondThread: number | undefined;
    try {
      await watchdog(hold.locked, "A no obtuvo lock de solicitud");
      const [before] = await pool.query<(RowDataPacket & { estado: string; cliente_id: number | null; mascota_id: number | null; converted_at: Date | null })[]>(
        "SELECT estado, cliente_id, mascota_id, converted_at FROM solicitudes_pet WHERE id = ?", [id]);
      assert.deepEqual([before[0].estado, before[0].cliente_id, before[0].mascota_id, before[0].converted_at], [initial, null, null, null]);
      second = convertir(tenant, id, { mascota: { nombre: "Perdedora B" } });
      secondThread = await watchdog(hold.secondAttempt, "B no intentó lock local");
      await esperarLock(secondThread, hold.firstThread(), "locales");
      assert.equal(hold.secondAcquired(), false);
    } finally { hold.release(); }
    const [a, b] = await watchdog(Promise.all([first, second!]), "doble conversión");
    assert.equal(a.status, 201);
    assert.deepEqual(b, { status: 409, data: { error: "PET_SOLICITUD_NOT_CONVERTIBLE" } });
    assert.equal((a.data as Converted).cliente.reutilizado, false);
    await integridad([id], tenant, phone, 1);
    const [pets] = await pool.query<(RowDataPacket & { nombre: string })[]>("SELECT nombre FROM mascotas WHERE local_id = ?", [tenant]);
    assert.equal(pets[0].nombre, "Ganadora A");
    await sinEspera(secondThread!);
  });
}

test("dos solicitudes del mismo local y teléfono: ambas convierten, B reutiliza", { timeout: 30000 }, async t => {
  const tenant = await local();
  const phone = testPhone();
  const aId = await solicitud(tenant, phone, "Animal A");
  const bId = await solicitud(tenant, `+54 11 2345 ${phone.slice(-4)}`, "Animal B");
  const hold = retenerConversion(t, tenant, "solicitud");
  const first = convertir(tenant, aId);
  let second: Promise<ApiResult> | undefined;
  let thread: number | undefined;
  try {
    await watchdog(hold.locked, "A no bloqueó solicitud");
    second = convertir(tenant, bId);
    thread = await watchdog(hold.secondAttempt, "B no intentó lock local");
    await esperarLock(thread, hold.firstThread(), "locales");
  } finally { hold.release(); }
  const [a, b] = await watchdog(Promise.all([first, second!]), "dos solicitudes mismo teléfono");
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal((a.data as Converted).cliente.reutilizado, false);
  assert.equal((b.data as Converted).cliente.reutilizado, true);
  assert.equal((a.data as Converted).cliente.id, (b.data as Converted).cliente.id);
  await integridad([aId, bId], tenant, phone, 2);
  await sinEspera(thread!);
});

test("conversión primero: DESCARTAR espera la fila y no pisa CONVERTIDA", { timeout: 30000 }, async t => {
  const tenant = await local();
  const phone = testPhone();
  const id = await solicitud(tenant, phone, "Mascota A");
  const hold = retenerConversion(t, tenant, "solicitud");
  const originalQuery = pool.query.bind(pool);
  const patchAttempt = barrier<void>();
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
    if (String(args[0]).includes("UPDATE solicitudes_pet SET estado = ? WHERE id = ? AND local_id = ? AND estado = ?")) patchAttempt.resolve();
    return originalQuery(...args);
  }) as typeof pool.query);
  const first = convertir(tenant, id);
  let patch: Promise<ApiResult> | undefined;
  try {
    await watchdog(hold.locked, "conversión no bloqueó solicitud");
    patch = descartar(tenant, id);
    await watchdog(patchAttempt.promise, "PATCH no intentó UPDATE");
    await esperarLock(null, hold.firstThread(), "solicitudes_pet");
  } finally { hold.release(); }
  const [converted, discarded] = await watchdog(Promise.all([first, patch!]), "convertir vs descartar");
  assert.equal(converted.status, 201);
  assert.deepEqual(discarded, { status: 409, data: { error: "PET_SOLICITUD_STATE_TRANSITION_INVALID" } });
  await integridad([id], tenant, phone, 1);
  await sinEspera(hold.firstThread());
});

test("DESCARTAR primero: conversión ve estado terminal aunque PATCH aún no respondió", { timeout: 30000 }, async t => {
  const tenant = await local();
  const phone = testPhone();
  const id = await solicitud(tenant, phone, "Mascota A", "CONTACTADA");
  const updated = barrier<void>();
  const release = barrier<void>();
  const original = pool.query.bind(pool);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
    if (String(args[0]).includes("UPDATE solicitudes_pet SET estado = ? WHERE id = ? AND local_id = ? AND estado = ?")) {
      return original(...args).then(async result => { updated.resolve(); await release.promise; return result; });
    }
    return original(...args);
  }) as typeof pool.query);
  const patch = descartar(tenant, id);
  try {
    await watchdog(updated.promise, "DESCARTAR no confirmó UPDATE");
    assert.deepEqual(await convertir(tenant, id), { status: 409, data: { error: "PET_SOLICITUD_NOT_CONVERTIBLE" } });
  } finally { release.resolve(); }
  assert.equal((await watchdog(patch, "respuesta PATCH")).status, 200);
  const [rows] = await pool.query<(RowDataPacket & { estado: string; cliente_id: null; mascota_id: null; converted_at: null })[]>(
    "SELECT estado, cliente_id, mascota_id, converted_at FROM solicitudes_pet WHERE id = ?", [id]);
  assert.deepEqual([rows[0].estado, rows[0].cliente_id, rows[0].mascota_id, rows[0].converted_at], ["DESCARTADA", null, null, null]);
  const [counts] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM clientes WHERE local_id = ? AND telefono_normalizado = ?", [tenant, normalizeClientPhone(phone)]);
  assert.equal(counts[0].total, 0);
  const [pets] = await pool.query<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM mascotas WHERE local_id = ?", [tenant]);
  assert.equal(pets[0].total, 0);
  const [links] = await pool.query<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM mascota_clientes WHERE local_id = ?", [tenant]);
  assert.equal(links[0].total, 0);
});

test("rollback con cliente y mascota intermedios: B espera y convierte sin residuos A", { timeout: 30000 }, async t => {
  const tenant = await local();
  const phone = testPhone();
  const id = await solicitud(tenant, phone, "Mascota A");
  const hold = retenerConversion(t, tenant, "cliente", true);
  const first = convertir(tenant, id, { mascota: { nombre: "Fallida A" } });
  let second: Promise<ApiResult> | undefined;
  let thread: number | undefined;
  try {
    await watchdog(hold.locked, "A no insertó cliente dentro de transacción");
    second = convertir(tenant, id, { mascota: { nombre: "Vigente B" } });
    thread = await watchdog(hold.secondAttempt, "B no intentó lock local");
    await esperarLock(thread, hold.firstThread(), "locales");
  } finally { hold.release(); }
  const [a, b] = await watchdog(Promise.all([first, second!]), "rollback seguido de conversión");
  assert.equal(a.status, 500);
  assert.equal(b.status, 201);
  assert.notEqual((b.data as Converted).cliente.id, hold.rolledBackClientId());
  const [rolledBack] = await pool.query<RowDataPacket[]>("SELECT id FROM clientes WHERE id = ?", [hold.rolledBackClientId()]);
  assert.equal(rolledBack.length, 0, "cliente de A no sobrevivió rollback");
  await integridad([id], tenant, phone, 1);
  const [pets] = await pool.query<(RowDataPacket & { nombre: string })[]>("SELECT nombre FROM mascotas WHERE local_id = ?", [tenant]);
  assert.equal(pets[0].nombre, "Vigente B");
  await sinEspera(thread!);
});

test("tenants distintos con mismo teléfono: B termina mientras A aún retiene su local", { timeout: 30000 }, async t => {
  const localA = await local();
  const localB = await local();
  const phone = testPhone();
  const idA = await solicitud(localA, phone, "Animal A");
  const idB = await solicitud(localB, phone, "Animal B");
  const hold = retenerConversion(t, localA, "local");
  const first = convertir(localA, idA);
  let second: ApiResult;
  try {
    await watchdog(hold.locked, "A no bloqueó local propio");
    second = await watchdog(convertir(localB, idB), "B quedó bloqueado por otro tenant");
    assert.equal(second.status, 201);
    assert.equal((second.data as Converted).cliente.reutilizado, false);
    const [stillPending] = await pool.query<(RowDataPacket & { estado: string })[]>(
      "SELECT estado FROM solicitudes_pet WHERE id = ? AND local_id = ?", [idA, localA]);
    assert.equal(stillPending[0].estado, "NUEVA");
  } finally { hold.release(); }
  const a = await watchdog(first, "A no completó tras liberar lock");
  assert.equal(a.status, 201);
  assert.notEqual((a.data as Converted).cliente.id, (second!.data as Converted).cliente.id);
  await integridad([idA], localA, phone, 1);
  await integridad([idB], localB, phone, 1);
});

test("ruta real de responsables PET: espera UNIQUE y reutiliza el cliente ganador", { timeout: 70000 }, async t => {
  const tenant = await local();
  const phone = testPhone();
  const id = await solicitud(tenant, phone, "Mascota A");
  const hold = retenerConversion(t, tenant, "cliente");
  const original = pool.query.bind(pool);
  const insertAttempt = barrier<void>();
  const legacyPhases: string[] = [];
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
    const sql = String(args[0]);
    const isLookup = sql.includes("FROM clientes WHERE telefono_normalizado = ? AND local_id = ?");
    const isInsert = sql.includes("INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, ?, ?)");
    if (isLookup) legacyPhases.push("legacy: SELECT cliente");
    if (isInsert) { legacyPhases.push("legacy: INSERT cliente"); insertAttempt.resolve(); }
    const query = original(...args);
    if (isLookup || isInsert) {
      void query.then(() => legacyPhases.push(isLookup ? "legacy: SELECT completo" : "legacy: INSERT completo"),
        (err: { code?: string }) => legacyPhases.push(`legacy: INSERT error ${err.code ?? "desconocido"}`));
    }
    return query;
  }) as typeof pool.query);
  const first = convertir(tenant, id, { responsable: { nombre: "Nombre ganador" } });
  let legacy: Promise<ApiResult> | undefined;
  let problema: unknown;
  let waits: Awaited<ReturnType<typeof diagnosticarLocks>> = [];
  let aTrx = "";
  let results: PromiseSettledResult<ApiResult>[] = [];
  try {
    await watchdog(hold.locked, "conversión no insertó cliente");
    aTrx = await transaccionDe(hold.firstThread());
    legacy = http("POST", "/responsables", tenant, { nombre: "Nombre legacy", telefono: phone });
    await watchdog(insertAttempt.promise, "legacy no intentó INSERT real");
    try { await esperarUniqueBloqueadaPor(aTrx); waits = await diagnosticarLocks(); }
    catch (error) { waits = await diagnosticarLocks(); throw error; }
  } catch (error) { problema = error; }
  finally {
    hold.release();
    // Aun con watchdog fallido, esperar a AMBAS rutas antes de que el hook after borre filas.
    results = await Promise.allSettled([first, ...(legacy ? [legacy] : [])]);
  }
  if (problema) throw new Error(`${String(problema)}; A=${JSON.stringify(hold.phases())}; legacy=${JSON.stringify(legacyPhases)}; waits=${JSON.stringify(waits)}; HTTP=${JSON.stringify(results)}`);
  assert.equal(results.length, 2);
  if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") {
    throw new Error(`Requests sin respuesta: ${JSON.stringify(results)}`);
  }
  const converted = results[0].value;
  const legacyResult = results[1].value;
  t.diagnostic(JSON.stringify({ fasesConversion: hold.phases(), fasesLegacy: legacyPhases, aTrx, waits, http: [converted.status, legacyResult.status] }));
  assert.equal(converted.status, 201);
  assert.equal(legacyResult.status, 200, "responsables PET relee al ganador tras duplicado");
  assert.equal(legacyResult.data.isNew, false);
  assert.equal(legacyResult.data.id, (converted.data as Converted).cliente.id);
  await integridad([id], tenant, phone, 1);
  const [client] = await pool.query<(RowDataPacket & { nombre: string })[]>(
    "SELECT nombre FROM clientes WHERE local_id = ? AND telefono = ?", [tenant, phone]);
  assert.equal(client[0].nombre, "Nombre ganador");
});
