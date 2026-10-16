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
import { TurnosRouter } from "../../turnos/turnos.routes";
import type { TurnoPetCreado } from "./turnos.types";
import { contextoTemporalArgentina } from "../disponibilidad/disponibilidad.service";
import { horaAMinutos, minutosAHora } from "../disponibilidad/disponibilidad.engine";

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

async function patchTurno(turnoId: string | number, payload: unknown, target: number | null = localId, rol = "admin") {
  const token = target === null ? undefined : jwt.sign({ userId: 1, localId: target, rol }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "PATCH",
      path: `/api/pet/admin/turnos/${turnoId}/reprogramar`,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(content) as Record<string, unknown> }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

async function patchEstadoPet(accion: "cancelar" | "completar", turnoId: string | number, target: number | null = localId, rol = "admin") {
  const token = target === null ? undefined : jwt.sign({ userId: 1, localId: target, rol }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "PATCH",
      path: `/api/pet/admin/turnos/${turnoId}/${accion}`,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(content) as Record<string, unknown> }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function patchLegacyEstado(accion: "cancelar" | "completar", turnoId: number, target: number) {
  const token = jwt.sign({ userId: 1, localId: target, rol: "admin" }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "PATCH",
      path: `/api/turnos/${turnoId}/${accion}`,
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(content) as Record<string, unknown> }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function getDisponibilidadPet(): Promise<{ status: number; data: { slots: Array<{ horaInicio: string; horaFin: string }> } }> {
  const token = jwt.sign({ userId: 1, localId, rol: "admin" }, secret, { expiresIn: "1m" });
  const query = new URLSearchParams({ mascotaId: String(mascotaId), servicioId: String(servicioId), fecha });
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "GET",
      path: `/api/pet/admin/disponibilidad?${query.toString()}`,
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(content) as { slots: Array<{ horaInicio: string; horaFin: string }> } }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function totalTurnos(): Promise<number> {
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND mascota_id IS NOT NULL", [localId],
  );
  return rows[0].total;
}

async function turnoExistente(hora: string, horaFin: string, estado: string, alta: number): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
       cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
       duracion_servicio_snapshot, alta_exigencia_snapshot, estado, pago_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'Fixture PET08B', 'test', ?, 'Service fixture', 60, ?, ?, NULL)`,
    [localId, fecha, hora, horaFin, mascotaId, clienteId, servicioId, alta, estado],
  );
  return result.insertId;
}

async function crearTurnoLocal(
  targetLocal: number,
  pet: number,
  client: number,
  service: number | null,
  hora: string,
  horaFin: string,
  state = "activo",
  alta = 0,
): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
       cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
       duracion_servicio_snapshot, alta_exigencia_snapshot, estado, pago_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'Fixture PET08B', 'test', ?, 'Service fixture', 60, ?, ?, NULL)`,
    [targetLocal, fecha, hora, horaFin, pet, client, service, alta, state],
  );
  return result.insertId;
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
  app.use("/api/turnos", TurnosRouter);
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
  await pool.query("DELETE FROM turnos WHERE local_id IN (?, ?) AND cliente_nombre = 'PET08B.4 fixture'", [localId, beautyLocal]);
  await pool.query("DELETE FROM estilistas WHERE local_id IN (?, ?) AND nombre = 'PET08B.4 stylist'", [localId, beautyLocal]);
  await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM horarios_local WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_servicios WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascota_extras WHERE local_id = ?", [localId]);
  await pool.query("DELETE FROM mascotas WHERE local_id = ? AND id <> ? AND nombre = 'PET08B.2 pet'", [localId, mascotaId]);
  await pool.query("UPDATE mascotas SET activo = 1, alta_exigencia = 0 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await pool.query("UPDATE servicios SET nombre = 'Service fixture', duracion = 99, activo = 1 WHERE id = ? AND local_id = ?", [servicioId, localId]);
  await pool.query("UPDATE extras SET nombre = CASE id WHEN ? THEN 'Extra PET08B one' WHEN ? THEN 'Extra PET08B two' ELSE nombre END, activo = 1 WHERE local_id = ?",
    [extraId, extraDosId, localId]);
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
      await pool.query("DELETE FROM turnos WHERE local_id = ? AND cliente_nombre = 'PET08B.4 fixture'", [id]);
      await pool.query("DELETE FROM estilistas WHERE local_id = ? AND nombre = 'PET08B.4 stylist'", [id]);
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

async function agregarHorarioTarde(inicio = "14:00", fin = "18:00"): Promise<void> {
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)",
    [localId, dia, inicio, fin]);
}

async function leerTurnoPet(id: number) {
  const [rows] = await pool.query<(RowDataPacket & {
    fecha: string; hora: string; hora_fin: string; estado: string; alta_exigencia_snapshot: number;
    cliente_nombre: string; cliente_telefono: string; servicio_nombre_snapshot: string;
    duracion_servicio_snapshot: number;
  })[]>(
    `SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha, hora, hora_fin, estado, alta_exigencia_snapshot,
            cliente_nombre, cliente_telefono, servicio_nombre_snapshot, duracion_servicio_snapshot
     FROM turnos WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL`, [id, localId]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function leerCamposTurno(id: number): Promise<Record<string, unknown>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha, hora, hora_fin, mascota_id, cliente_id,
            servicio_id, estado, alta_exigencia_snapshot, cliente_nombre, cliente_telefono,
            servicio_nombre_snapshot, duracion_servicio_snapshot, created_at
     FROM turnos WHERE id = ? AND local_id = ?`, [id, localId]);
  assert.equal(rows.length, 1);
  return { ...rows[0] };
}

async function crearTurnoBeautyFixture(targetLocal: number, stylistId: number, hora: string): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_nombre,
       cliente_telefono, estado) VALUES (?, ?, ?, ?, ?, NULL, 'PET08B.4 fixture', 'test', 'activo')`,
    [targetLocal, fecha, hora, `${String(Number(hora.slice(0, 2)) + 1).padStart(2, "0")}:00`, stylistId],
  );
  return result.insertId;
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

type ConcurrentRequestResult = Awaited<ReturnType<typeof patchTurno>>;

async function requestsTurnoConLockRetenido(
  t: TestContext,
  startFirst: () => Promise<ConcurrentRequestResult>,
  startSecond: () => Promise<ConcurrentRequestResult>,
  options: { failFirstUpdate?: boolean } = {},
): Promise<[ConcurrentRequestResult, ConcurrentRequestResult]> {
  const firstLocked = barrier<void>();
  const releaseFirstLockQuery = barrier<void>();
  const secondAttempt = barrier<number>();
  const firstAtUpdate = barrier<void>();
  const releaseFirstUpdateFailure = barrier<void>();
  let firstConnection: object | null = null;
  let firstConnectionSeen = false;
  let secondLockAcquired = false;

  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await originalGetConnection();
    const originalQuery = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      const statement: unknown = args[0];
      if (typeof statement === "string" && statement.includes("SELECT id, business_type FROM locales WHERE id = ? FOR UPDATE")) {
        if (!firstConnectionSeen) {
          firstConnectionSeen = true;
          firstConnection = connection;
          return originalQuery(...args).then(async result => {
            firstLocked.resolve();
            await releaseFirstLockQuery.promise;
            return result;
          });
        }
        const lock = originalQuery(...args);
        secondAttempt.resolve(connection.threadId);
        return lock.then(result => {
          secondLockAcquired = true;
          return result;
        });
      }
      if (options.failFirstUpdate && connection === firstConnection && typeof statement === "string"
        && /^\s*UPDATE turnos\s+SET fecha/s.test(statement)) {
        firstAtUpdate.resolve();
        return releaseFirstUpdateFailure.promise.then(() => {
          throw new Error("PET08B.3.2 fixture: fallo UPDATE de reprogramación");
        });
      }
      return originalQuery(...args);
    }) as typeof connection.query);
    return connection;
  });

  const first = startFirst();
  await firstLocked.promise;
  const second = startSecond();
  try {
    const waitingThread = await secondAttempt.promise;
    await esperarEsperaReal(waitingThread);
    assert.equal(secondLockAcquired, false, "la segunda operación sigue esperando el lock local");
    releaseFirstLockQuery.resolve();
    if (options.failFirstUpdate) {
      await firstAtUpdate.promise;
      assert.equal(secondLockAcquired, false, "B debe seguir esperando mientras A prepara el rollback");
      releaseFirstUpdateFailure.resolve();
    }
  } finally {
    releaseFirstLockQuery.resolve();
    releaseFirstUpdateFailure.resolve();
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

test("PATCH exige auth/rol admin y body exacto", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  assert.equal((await patchTurno(id, { fecha: "2099-10-20", hora: "10:00" }, null)).status, 401);
  assert.equal((await patchTurno(id, { fecha: "2099-10-20", hora: "10:00" }, localId, "superadmin")).status, 403);
  for (const invalid of [
    {}, { fecha, hora: "10:00", mascotaId }, { fecha, hora: "10:00", localId },
    { fecha: "2099-02-30", hora: "10:00" }, { fecha, hora: "9:00" },
    { fecha, hora: "10:00", extraIds: [] }, { fecha, hora: 1000 },
  ]) assert.equal((await patchTurno(id, invalid)).status, 400, JSON.stringify(invalid));
  assert.equal((await patchTurno("abc", { fecha, hora: "10:00" })).status, 400);
});

test("turno inexistente, BEAUTY o de otro local se oculta como 404", async () => {
  assert.equal((await patchTurno(2147483647, { fecha, hora: "10:00" })).status, 404);
  const beautyStyle = await crear("locales", "INSERT INTO locales (nombre, slug, business_type) VALUES ('Spare PET local', ?, 'PET_GROOMING')", [randomUUID()]);
  // This orphan test local has no shared PET fixtures; create a stylist and a BEAUTY-shaped row in the actual fixture tenant.
  await pool.query("DELETE FROM locales WHERE id = ?", [beautyStyle]);
  const [stylist] = await pool.query<ResultSetHeader>("INSERT INTO estilistas (nombre, local_id) VALUES ('PET08B.3 beauty stylist', ?)", [localId]);
  const [beauty] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_nombre,
       cliente_telefono, estado) VALUES (?, ?, '09:00', '10:00', ?, NULL, 'PET08B.3 beauty', 'test', 'activo')`,
    [localId, fecha, stylist.insertId],
  );
  assert.equal((await patchTurno(beauty.insertId, { fecha, hora: "10:00" })).status, 404);
  await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [beauty.insertId, localId]);
  await pool.query("DELETE FROM estilistas WHERE id = ? AND local_id = ?", [stylist.insertId, localId]);

  const foreignTurn = await crearTurnoLocal(otroLocal, mascotaAjenaId, clienteAjenoId, servicioAjenoId, "09:00", "10:00");
  assert.equal((await patchTurno(foreignTurn, { fecha, hora: "10:00" })).status, 404);
});

test("solo un turno activo se reprograma; pendiente, cancelado y completado devuelven 409", async () => {
  for (const state of ["pendiente_pago", "cancelado", "completado"] as const) {
    const id = await turnoExistente("09:00", "10:00", state, 0);
    const response = await patchTurno(id, { fecha, hora: "10:00" });
    assert.equal(response.status, 409, state);
    assert.equal(response.data.code, "PET_TURNO_STATE_NOT_REPROGRAMMABLE");
    await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [id, localId]);
  }
  assert.equal((await patchTurno(await turnoExistente("09:00", "10:00", "activo", 0), { fecha, hora: "10:00" })).status, 200);
});

test("reprograma dentro de la misma fecha, incluso al mismo horario, excluyendo su propio turno", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  const same = await patchTurno(id, { fecha, hora: "09:00" });
  assert.equal(same.status, 200);
  assert.equal((same.data as { horaFin: string }).horaFin, "10:00");
  const moved = await patchTurno(id, { fecha, hora: "10:00" });
  assert.deepEqual([moved.status, moved.data.hora, moved.data.horaFin], [200, "10:00", "11:00"]);
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM turnos WHERE id = ?", [id]);
  assert.equal(rows[0].total, 1);
});

test("cambia fecha/día y recalcula el fin con la duración snapshot", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  const nuevaFecha = "2099-10-21";
  const nuevoDia = new Date(Date.UTC(2099, 9, 21)).getUTCDay();
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, '14:00', '17:00')", [localId, nuevoDia]);
  const result = await patchTurno(id, { fecha: nuevaFecha, hora: "14:30" });
  assert.deepEqual([result.status, result.data.fecha, result.data.hora, result.data.horaFin], [200, nuevaFecha, "14:30", "15:30"]);
});

test("conserva cliente/servicio/extras snapshot e ignora catálogo actual y FK desligadas", async () => {
  const created = await post(body({ extraIds: [extraId, extraDosId] }));
  assert.equal(created.status, 201);
  const id = Number(created.data.id);
  const [before] = await pool.query<(RowDataPacket & {
    cliente_nombre: string; cliente_telefono: string; servicio_nombre_snapshot: string;
    duracion_servicio_snapshot: number;
  })[]>("SELECT cliente_nombre, cliente_telefono, servicio_nombre_snapshot, duracion_servicio_snapshot FROM turnos WHERE id = ?", [id]);
  const [extrasBefore] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id, nombre_snapshot, duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [id]);
  await pool.query("UPDATE servicios SET nombre = 'Changed service', duracion = 240 WHERE id = ?", [servicioId]);
  await pool.query("UPDATE mascota_servicios SET duracion_minutos = 200 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [localId, mascotaId, servicioId]);
  await pool.query("UPDATE extras SET nombre = 'Changed extra' WHERE id = ?", [extraId]);
  await pool.query("UPDATE mascota_extras SET duracion_minutos = 180 WHERE local_id = ? AND mascota_id = ? AND extra_id = ?", [localId, mascotaId, extraId]);
  await pool.query("UPDATE turnos SET servicio_id = NULL, cliente_id = NULL WHERE id = ? AND local_id = ?", [id, localId]);
  await pool.query("UPDATE turno_extras SET extra_id = NULL WHERE turno_id = ? AND extra_id = ?", [id, extraId]);

  const result = await patchTurno(id, { fecha, hora: "10:00" });
  assert.deepEqual([result.status, result.data.horaFin, result.data.clienteId, result.data.servicioId], [200, "11:40", null, null]);
  const [turnos] = await pool.query<(RowDataPacket & {
    cliente_nombre: string; cliente_telefono: string; servicio_nombre_snapshot: string;
    duracion_servicio_snapshot: number; hora_fin: string;
  })[]>("SELECT * FROM turnos WHERE id = ? AND local_id = ?", [id, localId]);
  assert.deepEqual([
    turnos[0].cliente_nombre, turnos[0].cliente_telefono, turnos[0].servicio_nombre_snapshot,
    turnos[0].duracion_servicio_snapshot,
  ], [before[0].cliente_nombre, before[0].cliente_telefono, before[0].servicio_nombre_snapshot, before[0].duracion_servicio_snapshot]);
  assert.equal(turnos[0].hora_fin, "11:40:00");
  const [extrasAfter] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id, nombre_snapshot, duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [id]);
  const normalizeExtras = (rows: RowDataPacket[]) => rows.map(row => ({
    extra_id: row.extra_id,
    nombre_snapshot: row.nombre_snapshot,
    duracion_minutos: row.duracion_minutos,
  }));
  assert.deepEqual(normalizeExtras(extrasAfter), normalizeExtras(extrasBefore).map(row => ({
    ...row, extra_id: row.extra_id === extraId ? null : row.extra_id,
  })));
});

test("valida destino contra ocupación, bloqueos, horario y grilla", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  const secondPet = await segundaMascota();
  await crearTurnoLocal(localId, secondPet, clienteId, servicioId, "10:00", "11:00");
  assert.equal((await patchTurno(id, { fecha, hora: "10:00" })).data.code, "PET_SLOT_UNAVAILABLE");
  await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localId, secondPet]);

  await pool.query("INSERT INTO bloqueos_local (local_id, fecha, hora_inicio, hora_fin, es_dia_completo) VALUES (?, ?, '10:00', '11:00', 0)", [localId, fecha]);
  assert.equal((await patchTurno(id, { fecha, hora: "10:00" })).data.code, "PET_SLOT_UNAVAILABLE");
  await pool.query("DELETE FROM bloqueos_local WHERE local_id = ? AND fecha = ?", [localId, fecha]);
  assert.equal((await patchTurno(id, { fecha, hora: "12:30" })).data.code, "PET_SLOT_UNAVAILABLE");
  assert.equal((await patchTurno(id, { fecha, hora: "09:15" })).data.code, "PET_SLOT_UNAVAILABLE");
  assert.equal((await patchTurno(id, { fecha: "2000-01-01", hora: "10:00" })).data.code, "PET_SLOT_UNAVAILABLE");
});

test("rechaza hora pasada hoy en zona ART", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  const now = contextoTemporalArgentina();
  const pastStart = Math.floor((now.minimumStartMinutes - 30) / 30) * 30;
  if (pastStart < 0) return;
  const [year, month, day] = now.fecha.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, '00:00', '23:59')", [localId, weekday]);
  const response = await patchTurno(id, { fecha: now.fecha, hora: minutosAHora(pastStart) });
  assert.equal(response.status, 409);
  assert.equal(response.data.code, "PET_SLOT_UNAVAILABLE");
});

test("snapshot high-demand se actualiza desde la mascota y settings actuales", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MIN_GAP", 30);
  const result = await patchTurno(id, { fecha, hora: "10:30" });
  assert.equal(result.status, 200);
  const [rows] = await pool.query<(RowDataPacket & { alta_exigencia_snapshot: number })[]>("SELECT alta_exigencia_snapshot FROM turnos WHERE id = ?", [id]);
  assert.equal(rows[0].alta_exigencia_snapshot, 1);

  await pool.query("UPDATE mascotas SET alta_exigencia = 0 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  const next = await patchTurno(id, { fecha, hora: "11:00" });
  assert.equal(next.status, 200);
  const [updated] = await pool.query<(RowDataPacket & { alta_exigencia_snapshot: number })[]>("SELECT alta_exigencia_snapshot FROM turnos WHERE id = ?", [id]);
  assert.equal(updated[0].alta_exigencia_snapshot, 0);
});

test("excluye el turno actual de MIN_GAP y MAX_PER_DAY durante su propia reprogramación", async () => {
  for (const [rule, value, snapshot] of [["MIN_GAP", 60, 1], ["MAX_PER_DAY", 1, 1]] as const) {
    await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
    await settings(rule, value);
    const id = await turnoExistente("09:00", "10:00", "activo", snapshot);
    const result = await patchTurno(id, { fecha, hora: "10:00" });
    assert.equal(result.status, 200, rule);
    await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [id, localId]);
    await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
  }
});

test("MAX_PER_DAY incluye otros completed high-demand y settings ausentes dejan el original intacto", async () => {
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  const target = await turnoExistente("09:00", "10:00", "activo", 0);
  await settings("MAX_PER_DAY", 1);
  await turnoExistente("08:00", "09:00", "completado", 1);
  const denied = await patchTurno(target, { fecha, hora: "10:00" });
  assert.equal(denied.status, 409);
  assert.equal(denied.data.code, "PET_SLOT_UNAVAILABLE");
  await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [localId]);
  const noSettings = await patchTurno(target, { fecha, hora: "10:00" });
  assert.equal(noSettings.status, 409);
  assert.equal(noSettings.data.code, "PET_HIGH_DEMAND_SETTINGS_REQUIRED");
  const [rows] = await pool.query<(RowDataPacket & { fecha: string; hora: string; alta_exigencia_snapshot: number })[]>(
    "SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha,hora,alta_exigencia_snapshot FROM turnos WHERE id = ?", [target]);
  assert.deepEqual([rows[0].fecha, rows[0].hora, rows[0].alta_exigencia_snapshot], [fecha, "09:00:00", 0]);
});

test("mascota inactiva rechaza y conserva el turno original", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  await pool.query("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  const result = await patchTurno(id, { fecha, hora: "10:00" });
  assert.equal(result.status, 409);
  const [rows] = await pool.query<(RowDataPacket & { hora: string })[]>("SELECT hora FROM turnos WHERE id = ?", [id]);
  assert.equal(rows[0].hora, "09:00:00");
});

test("error inducido en UPDATE hace rollback y conserva turno/extras", async t => {
  const created = await post(body({ extraIds: [extraId] }));
  assert.equal(created.status, 201);
  const id = Number(created.data.id);
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await originalGetConnection();
    const query = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      const sql: unknown = args[0];
      if (typeof sql === "string" && /^\s*UPDATE turnos\s+SET fecha/s.test(sql)) throw new Error("PET08B.3 fixture UPDATE failure");
      return query(...args);
    }) as typeof connection.query);
    return connection;
  });
  const failed = await patchTurno(id, { fecha, hora: "10:00" });
  assert.equal(failed.status, 500);
  const [rows] = await pool.query<(RowDataPacket & { fecha: string; hora: string; hora_fin: string; alta_exigencia_snapshot: number })[]>(
    "SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha,hora,hora_fin,alta_exigencia_snapshot FROM turnos WHERE id = ?", [id]);
  assert.deepEqual([rows[0].fecha, rows[0].hora, rows[0].hora_fin, rows[0].alta_exigencia_snapshot], [fecha, "09:00:00", "10:15:00", 0]);
  const [extras] = await pool.query<(RowDataPacket & { extra_id: number; nombre_snapshot: string; duracion_minutos: number })[]>(
    "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ?", [id]);
  assert.deepEqual(extras, [{ extra_id: extraId, nombre_snapshot: "Extra PET08B one", duracion_minutos: 15 }]);
});

test("PET-08B.3.2 dos PATCH del mismo turno: espera InnoDB y aplica last valid write wins", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const created = await post(body({ hora: "10:00", extraIds: [extraId] }));
  assert.equal(created.status, 201);
  const turnoId = Number(created.data.id);
  const [extrasBefore] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [turnoId]);

  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => patchTurno(turnoId, { fecha, hora: "16:00" }),
  );
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(await turnosDelDia(), 1);
  const final = await leerTurnoPet(turnoId);
  assert.deepEqual([final.fecha, final.hora, final.hora_fin], [fecha, "16:00:00", "17:15:00"]);
  const [extrasAfter] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [turnoId]);
  assert.deepEqual(extrasAfter.map(row => ({ extra_id: row.extra_id, nombre_snapshot: row.nombre_snapshot, duracion_minutos: row.duracion_minutos })),
    extrasBefore.map(row => ({ extra_id: row.extra_id, nombre_snapshot: row.nombre_snapshot, duracion_minutos: row.duracion_minutos })));
});

test("PET-08B.3.2 segunda reprogramación inválida no revierte el commit de A", { timeout: 30000 }, async t => {
  await agregarHorarioTarde("13:00", "17:00");
  const turnoId = await turnoExistente("10:00", "11:00", "activo", 0);
  const otherPet = await segundaMascota();
  await crearTurnoLocal(localId, otherPet, clienteId, servicioId, "13:00", "14:00");

  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => patchTurno(turnoId, { fecha, hora: "13:30" }),
  );
  assert.equal(a.status, 200);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.deepEqual([(await leerTurnoPet(turnoId)).hora, (await leerTurnoPet(turnoId)).hora_fin], ["14:00:00", "15:00:00"]);
  assert.equal(await turnosDelDia(), 2);
});

test("PET-08B.3.2 reprogramar vs crear mismo destino: solo una operación lo ocupa", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const turnoId = await turnoExistente("10:00", "11:00", "activo", 0);
  const [patchResult, postResult] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => post(body({ hora: "14:00" })),
  );
  assert.deepEqual([patchResult.status, postResult.status], [200, 409]);
  assert.equal(postResult.data.code, "PET_SLOT_UNAVAILABLE");
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL AND hora = '14:00'", [localId, fecha]);
  assert.equal(rows[0].total, 1);
});

test("PET-08B.3.2 reprogramar vs crear con inicio distinto pero overlap: solo uno gana", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const turnoId = await turnoExistente("10:00", "11:30", "activo", 0);
  await pool.query("UPDATE turnos SET duracion_servicio_snapshot = 90 WHERE id = ? AND local_id = ?", [turnoId, localId]);
  const [patchResult, postResult] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => post(body({ hora: "15:00" })),
  );
  assert.equal(patchResult.status, 200);
  assert.deepEqual([postResult.status, postResult.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.deepEqual([(await leerTurnoPet(turnoId)).hora, (await leerTurnoPet(turnoId)).hora_fin], ["14:00:00", "15:30:00"]);
  assert.equal(await turnosDelDia(), 1);
});

test("PET-08B.3.2 reprogramar vs crear adyacentes acepta ambos tras revalidación", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const turnoId = await turnoExistente("10:00", "11:00", "activo", 0);
  const [patchResult, postResult] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => post(body({ hora: "15:00" })),
  );
  assert.equal(patchResult.status, 200);
  assert.equal(postResult.status, 201);
  const [rows] = await pool.query<(RowDataPacket & { total: number })[]>(
    "SELECT COUNT(*) AS total FROM turnos WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL AND hora IN ('14:00','15:00')", [localId, fecha]);
  assert.equal(rows[0].total, 2);
});

test("PET-08B.3.2 dos turnos distintos al mismo destino: una reprogramación queda intacta", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const secondPet = await segundaMascota();
  const firstId = await turnoExistente("10:00", "11:00", "activo", 0);
  const secondId = await crearTurnoLocal(localId, secondPet, clienteId, servicioId, "11:00", "12:00");
  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(firstId, { fecha, hora: "14:00" }),
    () => patchTurno(secondId, { fecha, hora: "14:00" }),
  );
  assert.equal(a.status, 200);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.deepEqual([(await leerTurnoPet(firstId)).hora, (await leerTurnoPet(secondId)).hora], ["14:00:00", "11:00:00"]);
  assert.equal(await turnosDelDia(), 2);
});

test("PET-08B.3.2 MAX_PER_DAY se reevalúa serialmente si ambas mascotas se vuelven high-demand", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const secondPet = await segundaMascota(true);
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MAX_PER_DAY", 1);
  const firstId = await turnoExistente("10:00", "11:00", "activo", 0);
  const secondId = await crearTurnoLocal(localId, secondPet, clienteId, servicioId, "11:00", "12:00", "activo", 0);
  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(firstId, { fecha, hora: "14:00" }),
    () => patchTurno(secondId, { fecha, hora: "16:00" }),
  );
  assert.equal(a.status, 200);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  const [rows] = await pool.query<(RowDataPacket & { high_count: number; second_hour: string; second_snapshot: number })[]>(
    `SELECT SUM(alta_exigencia_snapshot = 1) AS high_count,
            MAX(CASE WHEN id = ? THEN hora END) AS second_hour,
            MAX(CASE WHEN id = ? THEN alta_exigencia_snapshot END) AS second_snapshot
     FROM turnos WHERE local_id = ? AND fecha = ? AND mascota_id IS NOT NULL`,
    [secondId, secondId, localId, fecha]);
  assert.equal(Number(rows[0].high_count), 1);
  assert.deepEqual([rows[0].second_hour, Number(rows[0].second_snapshot)], ["11:00:00", 0]);
});

test("PET-08B.3.2 MIN_GAP se reevalúa serialmente aunque los destinos no se solapen", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const secondPet = await segundaMascota(true);
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MIN_GAP", 60);
  const firstId = await turnoExistente("10:00", "11:00", "activo", 0);
  const secondId = await crearTurnoLocal(localId, secondPet, clienteId, servicioId, "11:00", "12:00", "activo", 0);
  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(firstId, { fecha, hora: "14:00" }),
    () => patchTurno(secondId, { fecha, hora: "15:30" }),
  );
  assert.equal(a.status, 200);
  assert.deepEqual([b.status, b.data.code], [409, "PET_SLOT_UNAVAILABLE"]);
  assert.deepEqual([(await leerTurnoPet(firstId)).hora, (await leerTurnoPet(secondId)).hora], ["14:00:00", "11:00:00"]);
});

test("PET-08B.3.2 rollback de A libera lock y B reprograma; snapshots siguen intactos", { timeout: 30000 }, async t => {
  await agregarHorarioTarde();
  const created = await post(body({ hora: "10:00", extraIds: [extraId] }));
  const turnoId = Number(created.data.id);
  const [extrasBefore] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ?", [turnoId]);
  const [a, b] = await requestsTurnoConLockRetenido(
    t,
    () => patchTurno(turnoId, { fecha, hora: "14:00" }),
    () => patchTurno(turnoId, { fecha, hora: "16:00" }),
    { failFirstUpdate: true },
  );
  assert.equal(a.status, 500);
  assert.equal(b.status, 200);
  const final = await leerTurnoPet(turnoId);
  assert.deepEqual([final.hora, final.hora_fin, final.estado, final.alta_exigencia_snapshot], ["16:00:00", "17:15:00", "activo", 0]);
  const [extrasAfter] = await pool.query<RowDataPacket[]>(
    "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ?", [turnoId]);
  assert.deepEqual(extrasAfter.map(row => ({ extra_id: row.extra_id, nombre_snapshot: row.nombre_snapshot, duracion_minutos: row.duracion_minutos })),
    extrasBefore.map(row => ({ extra_id: row.extra_id, nombre_snapshot: row.nombre_snapshot, duracion_minutos: row.duracion_minutos })));
  assert.equal(await turnosDelDia(), 1);
});

test("PATCH cancelar/completar requiere auth admin y valida ID/turno PET tenant-safe", async () => {
  const id = await turnoExistente("09:00", "10:00", "activo", 0);
  for (const action of ["cancelar", "completar"] as const) {
    assert.equal((await patchEstadoPet(action, id, null)).status, 401);
    assert.equal((await patchEstadoPet(action, id, localId, "superadmin")).status, 403);
    assert.equal((await patchEstadoPet(action, "bad-id")).status, 400);
    assert.equal((await patchEstadoPet(action, 2147483647)).status, 404);
  }

  const foreignId = await crearTurnoLocal(otroLocal, mascotaAjenaId, clienteAjenoId, servicioAjenoId, "09:00", "10:00");
  const stylist = await crear("locales", "INSERT INTO locales (nombre, slug, business_type) VALUES ('Unused PET08B.4 local', ?, 'PET_GROOMING')", [randomUUID()]);
  await pool.query("DELETE FROM locales WHERE id = ?", [stylist]);
  const [staff] = await pool.query<ResultSetHeader>("INSERT INTO estilistas (nombre, local_id) VALUES ('PET08B.4 stylist', ?)", [localId]);
  const [beauty] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_nombre, cliente_telefono, estado)
     VALUES (?, ?, '09:00', '10:00', ?, NULL, 'PET08B.4 fixture', 'test', 'activo')`, [localId, fecha, staff.insertId]);
  for (const action of ["cancelar", "completar"] as const) {
    assert.equal((await patchEstadoPet(action, foreignId)).status, 404);
    assert.equal((await patchEstadoPet(action, beauty.insertId)).status, 404);
  }
  await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [beauty.insertId, localId]);
  await pool.query("DELETE FROM estilistas WHERE id = ? AND local_id = ?", [staff.insertId, localId]);
});

test("PET activo puede cancelarse/completarse y solo cambia estado, snapshots y extras intactos", async () => {
  for (const action of ["cancelar", "completar"] as const) {
    const created = await post(body({ extraIds: [extraId] }));
    assert.equal(created.status, 201);
    const id = Number(created.data.id);
    const before = await leerCamposTurno(id);
    const [extrasBefore] = await pool.query<RowDataPacket[]>(
      "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [id]);
    const result = await patchEstadoPet(action, id);
    const expectedState = action === "cancelar" ? "cancelado" : "completado";
    assert.deepEqual([result.status, result.data.id, result.data.estado], [200, id, expectedState]);
    assert.deepEqual(Object.keys(result.data).sort(), ["estado", "id"]);
    const afterState = await leerCamposTurno(id);
    const { estado: _oldState, ...beforeWithoutState } = before;
    const { estado: _newState, ...afterWithoutState } = afterState;
    assert.deepEqual(afterWithoutState, beforeWithoutState);
    const [extrasAfter] = await pool.query<RowDataPacket[]>(
      "SELECT extra_id,nombre_snapshot,duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id", [id]);
    const normalize = (rows: RowDataPacket[]) => rows.map(row => ({
      extra_id: row.extra_id, nombre_snapshot: row.nombre_snapshot, duracion_minutos: row.duracion_minutos,
    }));
    assert.deepEqual(normalize(extrasAfter), normalize(extrasBefore));
  }
});

test("segunda cancelación/completado y transiciones desde pendiente o estado final devuelven 409", async () => {
  const cancelId = await turnoExistente("09:00", "10:00", "activo", 0);
  assert.equal((await patchEstadoPet("cancelar", cancelId)).status, 200);
  assert.equal((await patchEstadoPet("cancelar", cancelId)).data.code, "PET_TURNO_STATE_NOT_CANCELLABLE");
  assert.equal((await patchEstadoPet("completar", cancelId)).data.code, "PET_TURNO_STATE_NOT_COMPLETABLE");

  const completeId = await turnoExistente("10:00", "11:00", "activo", 0);
  assert.equal((await patchEstadoPet("completar", completeId)).status, 200);
  assert.equal((await patchEstadoPet("completar", completeId)).data.code, "PET_TURNO_STATE_NOT_COMPLETABLE");
  assert.equal((await patchEstadoPet("cancelar", completeId)).data.code, "PET_TURNO_STATE_NOT_CANCELLABLE");

  for (const state of ["pendiente_pago", "cancelado", "completado"] as const) {
    const id = await turnoExistente("11:00", "12:00", state, 0);
    assert.equal((await patchEstadoPet("cancelar", id)).data.code, "PET_TURNO_STATE_NOT_CANCELLABLE", state);
    assert.equal((await patchEstadoPet("completar", id)).data.code, "PET_TURNO_STATE_NOT_COMPLETABLE", state);
    const [rows] = await pool.query<(RowDataPacket & { estado: string })[]>("SELECT estado FROM turnos WHERE id = ?", [id]);
    assert.equal(rows[0].estado, state);
  }
});

test("las rutas BEAUTY legacy no modifican PET y siguen operando sobre turnos BEAUTY reales", async () => {
  for (const action of ["cancelar", "completar"] as const) {
    const petId = await turnoExistente("09:00", "10:00", "activo", 0);
    const denied = await patchLegacyEstado(action, petId, localId);
    assert.equal(denied.status, 404, action);
    const [petRows] = await pool.query<(RowDataPacket & { estado: string })[]>("SELECT estado FROM turnos WHERE id = ?", [petId]);
    assert.equal(petRows[0].estado, "activo");
    await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [petId, localId]);
  }

  const [staff] = await pool.query<ResultSetHeader>("INSERT INTO estilistas (nombre, local_id) VALUES ('PET08B.4 stylist', ?)", [beautyLocal]);
  const cancelBeauty = await crearTurnoBeautyFixture(beautyLocal, staff.insertId, "09:00");
  const completeBeauty = await crearTurnoBeautyFixture(beautyLocal, staff.insertId, "10:00");
  assert.deepEqual((await patchLegacyEstado("cancelar", cancelBeauty, beautyLocal)).data, { message: "Turno cancelado" });
  assert.deepEqual((await patchLegacyEstado("completar", completeBeauty, beautyLocal)).data, { message: "Turno completado" });
  const [rows] = await pool.query<(RowDataPacket & { id: number; estado: string })[]>(
    "SELECT id,estado FROM turnos WHERE id IN (?, ?) ORDER BY id", [cancelBeauty, completeBeauty]);
  assert.deepEqual(rows.map(row => row.estado), ["cancelado", "completado"]);
  await pool.query("DELETE FROM turnos WHERE id IN (?, ?)", [cancelBeauty, completeBeauty]);
  await pool.query("DELETE FROM estilistas WHERE id = ? AND local_id = ?", [staff.insertId, beautyLocal]);
});

test("cancelar libera slot y elimina high-demand de MIN_GAP/MAX_PER_DAY", async () => {
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MAX_PER_DAY", 1);
  const created = await post(body({ extraIds: [] }));
  assert.equal(created.status, 201);
  const id = Number(created.data.id);
  assert.deepEqual((await getDisponibilidadPet()).data.slots, []);
  assert.equal((await patchEstadoPet("cancelar", id)).status, 200);
  let slots = (await getDisponibilidadPet()).data.slots;
  assert.ok(slots.some(slot => slot.horaInicio === "09:00"));

  await settings("MIN_GAP", 60);
  slots = (await getDisponibilidadPet()).data.slots;
  assert.ok(slots.some(slot => slot.horaInicio === "09:00"), "cancelado no participa en MIN_GAP");
});

test("completar libera ocupación, pero el high-demand completado conserva MIN_GAP y MAX_PER_DAY", async () => {
  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  await settings("MIN_GAP", 60);
  const created = await post(body());
  assert.equal(created.status, 201);
  const id = Number(created.data.id);
  assert.equal((await patchEstadoPet("completar", id)).status, 200);

  // A normal candidate ignores high-demand separation; completed must not occupy the interval physically.
  await pool.query("UPDATE mascotas SET alta_exigencia = 0 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  let slots = (await getDisponibilidadPet()).data.slots;
  assert.ok(slots.some(slot => slot.horaInicio === "09:00"), "completado no bloquea físicamente");

  await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localId]);
  slots = (await getDisponibilidadPet()).data.slots;
  assert.ok(!slots.some(slot => slot.horaInicio === "09:00"));
  assert.ok(slots.some(slot => slot.horaInicio === "11:00"), "completado participa en MIN_GAP");

  await settings("MAX_PER_DAY", 1);
  assert.deepEqual((await getDisponibilidadPet()).data.slots, [], "completado cuenta en MAX_PER_DAY");
});
