import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import petRouter from "../pet.routes";
import type { TurnoPetCreado } from "./turnos.types";

const secret = "PET08B1_TEST_ONLY";
const fecha = "2099-10-20";
const dia = new Date(Date.UTC(2099, 9, 20)).getUTCDay();
const locales: number[] = [];
let localId = 0;
let otroLocal = 0;
let beautyLocal = 0;
let mascotaId = 0;
let mascotaAjenaId = 0;
let clienteId = 0;
let clienteAjenoId = 0;
let servicioId = 0;
let servicioAjenoId = 0;
let extraId = 0;
let extraDosId = 0;
let extraAjenoId = 0;
let server: Server;
let port: number;

async function crear(tabla: "locales" | "mascotas" | "clientes" | "servicios" | "extras", sql: string, values: unknown[]): Promise<number> {
  assert.ok(sql.startsWith(`INSERT INTO ${tabla} `));
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { mascotaId, clienteId, servicioId, extraIds: [], fecha, hora: "09:00", ...overrides };
}

async function post(payload: unknown = body(), target: number | null = localId, rol = "admin") {
  const token = target === null ? undefined : jwt.sign({ userId: 1, localId: target, rol }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "POST", path: "/api/pet/admin/turnos",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(content) as Record<string, unknown> }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

async function totalTurnos(): Promise<number> {
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND mascota_id IS NOT NULL", [localId],
  );
  return rows[0].total;
}

async function turnoExistente(hora: string, horaFin: string, estado: string, alta: number): Promise<void> {
  await pool.query(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
       cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
       duracion_servicio_snapshot, alta_exigencia_snapshot, estado, pago_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'Fixture PET08B', 'test', ?, 'Service fixture', 60, ?, ?, NULL)`,
    [localId, fecha, hora, horaFin, mascotaId, clienteId, servicioId, alta, estado],
  );
}

async function settings(rule: "MIN_GAP" | "MAX_PER_DAY", value: number): Promise<void> {
  await pool.query(
    `INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day)
     VALUES (?, ?, ?, ?) AS nuevo ON DUPLICATE KEY UPDATE
       high_demand_rule = nuevo.high_demand_rule,
       high_demand_gap_minutes = nuevo.high_demand_gap_minutes,
       high_demand_max_per_day = nuevo.high_demand_max_per_day`,
    [localId, rule, rule === "MIN_GAP" ? value : null, rule === "MAX_PER_DAY" ? value : null],
  );
}

before(async () => {
  for (const kind of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    locales.push(await crear("locales", "INSERT INTO locales (nombre, slug, business_type) VALUES ('PET08B fixture', ?, ?)", [randomUUID(), kind]));
  }
  [localId, otroLocal, beautyLocal] = locales;
  mascotaId = await crear("mascotas", "INSERT INTO mascotas (local_id, nombre) VALUES (?, 'PET08B pet')", [localId]);
  mascotaAjenaId = await crear("mascotas", "INSERT INTO mascotas (local_id, nombre) VALUES (?, 'PET08B foreign pet')", [otroLocal]);
  clienteId = await crear("clientes", "INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, 'Responsable PET08B', ?)", [localId, randomUUID()]);
  clienteAjenoId = await crear("clientes", "INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, 'Foreign PET08B', ?)", [otroLocal, randomUUID()]);
  servicioId = await crear("servicios", "INSERT INTO servicios (local_id, nombre, duracion, activo) VALUES (?, 'Service fixture', 99, 1)", [localId]);
  servicioAjenoId = await crear("servicios", "INSERT INTO servicios (local_id, nombre, duracion, activo) VALUES (?, 'Foreign fixture', 99, 1)", [otroLocal]);
  extraId = await crear("extras", "INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Extra PET08B one', 1)", [localId]);
  extraDosId = await crear("extras", "INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Extra PET08B two', 1)", [localId]);
  extraAjenoId = await crear("extras", "INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Foreign PET08B extra', 1)", [otroLocal]);
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id IS NOT NULL", [localId]);
  await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM horarios_local WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_servicios WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_extras WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascotas WHERE local_id = ? AND id <> ? AND nombre = 'PET08B.2 pet'", [localId, mascotaId]);
  await pool.query("UPDATE mascotas SET activo = 1, alta_exigencia = 0 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await pool.query("UPDATE servicios SET activo = 1 WHERE id = ? AND local_id = ?", [servicioId, localId]);
  await pool.query("UPDATE extras SET activo = 1 WHERE local_id = ?", [localId]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [localId, mascotaId, clienteId]);
  await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)", [localId, mascotaId, servicioId]);
  await pool.query("INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, 15), (?, ?, ?, 25)",
    [localId, mascotaId, extraId, localId, mascotaId, extraDosId]);
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, '09:00', '13:00')", [localId, dia]);
});

after(async () => {
  const errors: unknown[] = [];
  try { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (error) { errors.push(error); }
  try {
    for (const id of locales) {
      await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id IS NOT NULL", [id]);
      await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM mascota_servicios WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM mascota_extras WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM horarios_local WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM extras WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM servicios WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM mascotas WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM clientes WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    }
  } catch (error) { errors.push(error); }
  await pool.end();
  assert.deepEqual(errors, [], "Los fixtures PET-08B.1 deben limpiarse");
});

test("POST requiere auth, rol admin real y local PET sin alterar otras rutas", async () => {
  assert.equal((await post(body(), null)).status, 401);
  assert.equal((await post(body(), localId, "superadmin")).status, 403);
  assert.equal((await post(body(), beautyLocal)).status, 403);
  assert.equal(await totalTurnos(), 0);
});

test("body exacto: rechaza protegidos, formatos, faltantes y extras duplicados", async () => {
  for (const invalid of [
    { ...body(), localId }, { ...body(), estilistaId: 1 }, { ...body(), horaFin: "11:00" },
    { ...body(), duracion: 60 }, { ...body(), altaExigencia: false },
    { ...body(), estado: "activo" }, { ...body(), servicioNombreSnapshot: "evil" },
    { ...body(), mascotaId: "1" }, { ...body(), clienteId: 0 },
    { ...body(), servicioId: 2147483648 }, { ...body(), extraIds: [extraId, extraId] },
    { ...body(), extraIds: ["1"] }, { ...body(), extraIds: undefined },
    { ...body(), fecha: "2099-02-30" }, { ...body(), hora: "9:00" }, { ...body(), hora: "09:00:00" },
  ]) {
    assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal(await totalTurnos(), 0);
});

test("validaciones tenant-safe y responsable vinculado", async () => {
  assert.equal((await post(body({ mascotaId: mascotaAjenaId }))).status, 404);
  assert.equal((await post(body({ clienteId: clienteAjenoId }))).status, 404);
  assert.equal((await post(body({ servicioId: servicioAjenoId }))).status, 404);
  assert.equal((await post(body({ extraIds: [extraAjenoId] }))).status, 404);
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [localId]);
  assert.equal((await post()).status, 409);
  assert.equal(await totalTurnos(), 0);
});

test("inactivos, relaciones faltantes y extras inválidos impiden reservar", async () => {
  await pool.query("UPDATE mascotas SET activo = 0 WHERE id = ?", [mascotaId]);
  assert.equal((await post()).status, 409);
  await pool.query("UPDATE mascotas SET activo = 1 WHERE id = ?", [mascotaId]);
  await pool.query("UPDATE servicios SET activo = 0 WHERE id = ?", [servicioId]);
  assert.equal((await post()).status, 409);
  await pool.query("UPDATE servicios SET activo = 1 WHERE id = ?", [servicioId]);
  await pool.query("DELETE FROM mascota_servicios WHERE mascota_id = ? AND local_id = ?", [mascotaId, localId]);
  assert.equal((await post()).status, 409);
  await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)", [localId, mascotaId, servicioId]);
  await pool.query("UPDATE extras SET activo = 0 WHERE id = ?", [extraId]);
  assert.equal((await post(body({ extraIds: [extraId] }))).status, 409);
  await pool.query("UPDATE extras SET activo = 1 WHERE id = ?", [extraId]);
  await pool.query("DELETE FROM mascota_extras WHERE local_id = ? AND mascota_id = ? AND extra_id = ?", [localId, mascotaId, extraId]);
  assert.equal((await post(body({ extraIds: [extraId] }))).status, 409);
  assert.equal(await totalTurnos(), 0);
});

test("201 guarda turno activo, responsable y snapshots del servicio y dos extras, sin usar duración catálogo", async () => {
  const result = await post(body({ extraIds: [extraId, extraDosId] }));
  assert.equal(result.status, 201);
  const turno = result.data as unknown as TurnoPetCreado;
  assert.deepEqual(turno, { id: turno.id, fecha, hora: "09:00", horaFin: "10:40", estado: "activo", mascotaId, clienteId, servicioId });
  const [rows] = await pool.query<(RowDataPacket & {
    estado: string; estilista_id: number | null; pago_id: number | null; mascota_id: number;
    alta_exigencia_snapshot: number; cliente_nombre: string; cliente_telefono: string;
    servicio_nombre_snapshot: string; duracion_servicio_snapshot: number;
  })[]>("SELECT * FROM turnos WHERE id = ? AND local_id = ?", [turno.id, localId]);
  assert.equal(rows[0].estado, "activo");
  assert.equal(rows[0].estilista_id, null);
  assert.equal(rows[0].pago_id, null);
  assert.equal(rows[0].mascota_id, mascotaId);
  assert.equal(rows[0].alta_exigencia_snapshot, 0);
  assert.equal(rows[0].cliente_nombre, "Responsable PET08B");
  assert.ok(rows[0].cliente_telefono);
  assert.equal(rows[0].servicio_nombre_snapshot, "Service fixture");
  assert.equal(rows[0].duracion_servicio_snapshot, 60);
  const [extras] = await pool.query<(RowDataPacket & { extra_id: number; nombre_snapshot: string; duracion_minutos: number })[]>(
    "SELECT extra_id, nombre_snapshot, duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY extra_id", [turno.id]);
  assert.deepEqual(extras.map(({ extra_id, nombre_snapshot, duracion_minutos }) => ({ extra_id, nombre_snapshot, duracion_minutos })), [
    { extra_id: extraId, nombre_snapshot: "Extra PET08B one", duracion_minutos: 15 },
    { extra_id: extraDosId, nombre_snapshot: "Extra PET08B two", duracion_minutos: 25 },
  ]);
});

test("sin extras crea un turno sin detalles; repite el mismo slot y recibe 409", async () => {
  assert.equal((await post()).status, 201);
  const repeated = await post();
  assert.equal(repeated.status, 409);
  assert.equal(repeated.data.code, "PET_SLOT_UNAVAILABLE");
  assert.equal(await totalTurnos(), 1);
});

test("rechaza hora fuera de la grilla, duración fuera de franja y fecha pasada", async () => {
  assert.equal((await post(body({ hora: "09:15" }))).data.code, "PET_SLOT_UNAVAILABLE");
  assert.equal((await post(body({ hora: "12:30" }))).status, 409);
  assert.equal((await post(body({ fecha: "2000-01-01" }))).status, 409);
  assert.equal(await totalTurnos(), 0);
});

test("bloqueo parcial y completo impiden reservar, sin filas parciales", async () => {
  await pool.query("INSERT INTO bloqueos_local (local_id, fecha, hora_inicio, hora_fin, es_dia_completo) VALUES (?, ?, '09:30', '10:30', 0)", [localId, fecha]);
  assert.equal((await post()).status, 409);
  await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [localId]);
  await pool.query("INSERT INTO bloqueos_local (local_id, fecha, es_dia_completo) VALUES (?, ?, 1)", [localId, fecha]);
  assert.equal((await post()).status, 409);
  assert.equal(await totalTurnos(), 0);
});

test("activo y pendiente_pago solapados bloquean; cancelado y completado no bloquean físicamente", async () => {
  for (const estado of ["activo", "pendiente_pago", "cancelado", "completado"] as const) {
    await turnoExistente("09:30", "10:30", estado, 0);
    const response = await post();
    assert.equal(response.status, estado === "activo" || estado === "pendiente_pago" ? 409 : 201, estado);
    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localId, mascotaId]);
  }
});

test("MIN_GAP respeta completado y pendiente high-demand por snapshot y omite cancelado", async () => {
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ?", [mascotaId]);
  await settings("MIN_GAP", 30);
  for (const estado of ["completado", "pendiente_pago", "cancelado"] as const) {
    await turnoExistente("08:30", "09:00", estado, 1);
    const response = await post();
    assert.equal(response.status, estado === "cancelado" ? 201 : 409, estado);
    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localId, mascotaId]);
  }
});

test("MAX_PER_DAY cuenta completado y pendiente por snapshot y no cancelado; settings ausentes son 409", async () => {
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ?", [mascotaId]);
  const noSettings = await post();
  assert.equal(noSettings.status, 409);
  assert.equal(noSettings.data.code, "PET_HIGH_DEMAND_SETTINGS_REQUIRED");
  await settings("MAX_PER_DAY", 1);
  for (const estado of ["completado", "pendiente_pago", "cancelado"] as const) {
    await turnoExistente("08:30", "09:00", estado, 1);
    const response = await post();
    assert.equal(response.status, estado === "cancelado" ? 201 : 409, estado);
    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localId, mascotaId]);
  }
  assert.equal(await totalTurnos(), 0);
});

test("un error al insertar turno_extras revierte el turno y no deja detalles", async t => {
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGetConnection();
    const originalQuery = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const statement: unknown = args[0];
      if (typeof statement === "string" && statement.includes("INSERT INTO turno_extras")) {
        throw new Error("Fixture: fallo insertando turno_extras");
      }
      return originalQuery(...args);
    }) as typeof conn.query);
    return conn;
  });
  const response = await post(body({ extraIds: [extraId] }));
  assert.equal(response.status, 500);
  assert.equal(await totalTurnos(), 0);
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turno_extras WHERE nombre_snapshot = 'Extra PET08B one'");
  assert.equal(rows[0].total, 0);
});

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function turnosDelDia(target = localId): Promise<number> {
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL", [target, fecha],
  );
  return rows[0].total;
}

async function esperarEsperaReal(threadId: number): Promise<void> {
  // Wait for MySQL to report that B is blocked on InnoDB, not for a guessed delay.
  const deadline = Date.now() + 15000; // watchdog only; never used as synchronization.
  while (Date.now() < deadline) {
    const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
       JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
       WHERE t.PROCESSLIST_ID = ?`, [threadId],
    );
    if (rows[0].total > 0) return;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error("La segunda transacción no llegó a esperar el lock InnoDB del local");
}

type PostResult = Awaited<ReturnType<typeof post>>;

async function reservarConLockRetenido(
  t: TestContext,
  firstPayload: Record<string, unknown>,
  secondPayload: Record<string, unknown>,
  options: { secondLocal?: number; failFirstExtra?: boolean } = {},
): Promise<[PostResult, PostResult]> {
  const firstLocked = barrier<void>();
  const releaseFirst = barrier<void>();
  const secondAttempt = barrier<number>();
  let firstConnectionSeen = false;
  let firstConnection: object | null = null;
  let bLockAcquired = false;
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGetConnection();
    const originalQuery = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const statement: unknown = args[0];
      if (typeof statement === "string" && statement.includes("SELECT id, business_type FROM locales WHERE id = ? FOR UPDATE")) {
        if (!firstConnectionSeen) {
          firstConnectionSeen = true;
          firstConnection = conn;
          const lock = originalQuery(...args);
          return lock.then(async result => {
            firstLocked.resolve();
            await releaseFirst.promise;
            return result;
          });
        }
        const lock = originalQuery(...args);
        secondAttempt.resolve(conn.threadId);
        return lock.then(result => {
          bLockAcquired = true;
          return result;
        });
      }
      if (options.failFirstExtra && conn === firstConnection && typeof statement === "string"
        && statement.includes("INSERT INTO turno_extras")) {
        throw new Error("Fixture PET-08B.2: falla INSERT de extra tras tomar lock");
      }
      return originalQuery(...args);
    }) as typeof conn.query);
    return conn;
  });

  const first = post(firstPayload);
  await firstLocked.promise;
  const second = post(secondPayload, options.secondLocal ?? localId);
  try {
    const secondThread = await secondAttempt.promise;
    if (options.secondLocal === undefined || options.secondLocal === localId) {
      await esperarEsperaReal(secondThread);
      assert.equal(bLockAcquired, false, "B no puede obtener el lock antes del COMMIT/ROLLBACK de A");
      assert.equal(await turnosDelDia(), 0, "A conserva el lock aunque la agenda aún esté vacía");
    } else {
      // B must finish on another local while A still holds its lock. Watchdog is not an ordering mechanism.
      let timer: ReturnType<typeof setTimeout>;
      const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Reserva de otro local quedó bloqueada")), 15000);
      });
      try {
        await Promise.race([second, watchdog]);
      } finally {
        clearTimeout(timer!);
      }
      assert.equal(bLockAcquired, true);
      assert.equal(await turnosDelDia(), 0);
    }
  } finally {
    releaseFirst.resolve();
  }
  return Promise.all([first, second]);
}

async function segundaMascota(altaExigencia = false): Promise<number> {
  const secondPet = await crear("mascotas", "INSERT INTO mascotas (local_id, nombre, alta_exigencia) VALUES (?, 'PET08B.2 pet', ?)", [localId, Number(altaExigencia)]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [localId, secondPet, clienteId]);
  await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)",
    [localId, secondPet, servicioId]);
  return secondPet;
}

test("PET-08B.2 agenda vacía: mismo slot espera lock, 201/409 y solo un turno", { timeout: 30000 }, async t => {
  await pool.query("UPDATE mascota_servicios SET duracion_minutos = 90 WHERE local_id = ? AND mascota_id = ?", [localId, mascotaId]);
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }), body({ hora: "10:00" }));
  assert.equal(a.status, 201);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.equal(await turnosDelDia(), 1);
});

test("PET-08B.2 inicios distintos solapados: el UNIQUE de hora no basta", { timeout: 30000 }, async t => {
  const secondPet = await segundaMascota();
  await pool.query("UPDATE mascota_servicios SET duracion_minutos = 90 WHERE local_id = ? AND mascota_id = ?", [localId, mascotaId]);
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }), body({ hora: "11:00", mascotaId: secondPet }));
  assert.deepEqual([a.status, a.data.horaFin], [201, "11:30"]);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.equal(await turnosDelDia(), 1);
});

test("PET-08B.2 intervalos adyacentes: ambos persisten tras revalidar", { timeout: 30000 }, async t => {
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }), body({ hora: "11:00" }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(await turnosDelDia(), 2);
});

test("PET-08B.2 distintos locales: B confirma mientras A aún mantiene el lock", { timeout: 30000 }, async t => {
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [otroLocal, mascotaAjenaId, clienteAjenoId]);
  await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)",
    [otroLocal, mascotaAjenaId, servicioAjenoId]);
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, '09:00', '13:00')", [otroLocal, dia]);
  assert.equal(await turnosDelDia(), 0);
  assert.equal(await turnosDelDia(otroLocal), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }),
    body({ hora: "10:00", mascotaId: mascotaAjenaId, clienteId: clienteAjenoId, servicioId: servicioAjenoId }),
    { secondLocal: otroLocal });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(await turnosDelDia(), 1);
  assert.equal(await turnosDelDia(otroLocal), 1);
});

test("PET-08B.2 MAX_PER_DAY=1 se revalida después del lock aunque los slots no se solapen", { timeout: 30000 }, async t => {
  const secondPet = await segundaMascota(true);
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MAX_PER_DAY", 1);
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }), body({ hora: "12:00", mascotaId: secondPet }));
  assert.equal(a.status, 201);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL AND alta_exigencia_snapshot = 1", [localId, fecha]);
  assert.equal(rows[0].total, 1);
});

test("PET-08B.2 MIN_GAP rechaza reservas high-demand físicamente no solapadas", { timeout: 30000 }, async t => {
  const secondPet = await segundaMascota(true);
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MIN_GAP", 60);
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00" }), body({ hora: "11:30", mascotaId: secondPet }));
  assert.equal(a.status, 201);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.equal(await turnosDelDia(), 1);
});

test("PET-08B.2 rollback tras lock libera B: no quedan turno ni extra parciales", { timeout: 30000 }, async t => {
  assert.equal(await turnosDelDia(), 0);
  const [a, b] = await reservarConLockRetenido(t, body({ hora: "10:00", extraIds: [extraId] }), body({ hora: "10:00" }),
    { failFirstExtra: true });
  assert.equal(a.status, 500);
  assert.equal(b.status, 201);
  assert.equal(await turnosDelDia(), 1);
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM turno_extras te
     JOIN turnos t ON t.id = te.turno_id
     WHERE t.local_id = ? AND t.fecha = ? AND t.mascota_id IS NOT NULL`, [localId, fecha]);
  assert.equal(rows[0].total, 0);
});
