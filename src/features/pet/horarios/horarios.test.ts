import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { before, beforeEach, after, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import router from "../pet.routes";
import type { Horario } from "./horarios.types";

const secret = "PET05_HORARIOS_FICTICIO_SOLO_TEST";
const locales: number[] = [];
const base = "/api/pet/admin/horarios";
const valido = { diaSemana: 1, horaInicio: "09:00", horaFin: "13:00" };
let server: Server;
let port: number;

async function http(method: string, path = base, body?: unknown, localId: number | null = locales[0]) {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, rol: "admin", localId }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function crear(body: Record<string, unknown> = valido, localId = locales[0]): Promise<Horario> {
  const result = await http("POST", base, body, localId);
  assert.equal(result.status, 201, result.body);
  return JSON.parse(result.body) as Horario;
}

before(async () => {
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    const [result] = await pool.query<ResultSetHeader>("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", ["Fixture PET05 horarios", randomUUID(), business]);
    locales.push(result.insertId);
  }
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  for (const id of locales) {
    await pool.query("DELETE FROM horarios_local WHERE local_id = ?", [id]);
    await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [id]);
  }
});

after(async () => {
  const errors: unknown[] = [];
  try { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (error) { errors.push(error); }
  try {
    for (const id of locales) {
      try {
        await pool.query("DELETE FROM locales WHERE id = ?", [id]);
        const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM horarios_local WHERE local_id = ?", [id]);
        assert.equal(rows.length, 0);
      } catch (error) { errors.push(error); }
    }
  } finally { await pool.end(); }
  assert.equal(errors.length, 0, "Fixtures horarios deben limpiarse");
});

for (const [label, tenant, status] of [["sin auth", -1, 401], ["BEAUTY", 2, 403]] as const) {
  test(`${label} bloqueado en cuatro rutas horarios`, async () => {
    for (const [method, path, body] of [["GET", base, undefined], ["POST", base, valido], ["PATCH", `${base}/1`, { activo: false }], ["DELETE", `${base}/1`, undefined]] as const) {
      assert.equal((await http(method, path, body, tenant < 0 ? null : locales[tenant])).status, status);
    }
  });
}

test("Crear normaliza horas, activo inicial y GET filtra tenant/ordena", async () => {
  const tarde = await crear({ diaSemana: 1, horaInicio: "15:00:00", horaFin: "19:00:00" });
  const manana = await crear();
  const domingo = await crear({ ...valido, diaSemana: 0 });
  await crear(valido, locales[1]);
  assert.deepEqual(manana, { id: manana.id, dia_semana: 1, hora_inicio: "09:00:00", hora_fin: "13:00:00", activo: 1 });
  const result = await http("GET", `${base}?local_id=${locales[1]}`);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).map((h: Horario) => h.id), [domingo.id, manana.id, tarde.id]);
});

test("Intervalos adyacentes y múltiples días permitidos", async () => {
  await crear();
  await crear({ diaSemana: 1, horaInicio: "13:00", horaFin: "17:00" });
  await crear({ ...valido, diaSemana: 6 });
});

for (const [inicio, fin] of [["09:00", "13:00"], ["08:00", "10:00"], ["12:00", "14:00"], ["10:00", "12:00"], ["08:00", "14:00"]]) {
  test(`Solapamiento/duplicado ${inicio}-${fin}: 409`, async () => {
    await crear();
    assert.equal((await http("POST", base, { diaSemana: 1, horaInicio: inicio, horaFin: fin })).status, 409);
  });
}

for (const diaSemana of [-1, 7, 1.5, "1", null, true]) {
  test(`Día inválido ${JSON.stringify(diaSemana)}: 400 en POST/PATCH`, async () => {
    assert.equal((await http("POST", base, { ...valido, diaSemana })).status, 400);
    const h = await crear();
    assert.equal((await http("PATCH", `${base}/${h.id}`, { diaSemana })).status, 400);
  });
}

for (const horaInicio of ["9:00", "24:00", "-01:00", "12:60", "12:00:60", "09:00:00.5", "09:00:01", "09:00:30", "09:30:59", "23:59:59", null, 900]) {
  test(`Hora inválida ${JSON.stringify(horaInicio)}`, async () => {
    assert.equal((await http("POST", base, { ...valido, horaInicio })).status, 400);
  });
}

test("Inicio igual/mayor a fin y medianoche rechazados; HH:mm y segundos 00 válidos", async () => {
  for (const [horaInicio, horaFin] of [["10:00", "10:00"], ["22:00", "02:00"]]) {
    assert.equal((await http("POST", base, { diaSemana: 1, horaInicio, horaFin })).status, 400);
  }
  await crear({ diaSemana: 0, horaInicio: "00:00:00", horaFin: "23:59" });
  await crear({ diaSemana: 2, horaInicio: "09:00", horaFin: "13:00" });
  await crear({ diaSemana: 3, horaInicio: "09:00:00", horaFin: "13:00:00" });
  await crear({ diaSemana: 4, horaInicio: "09:15:00", horaFin: "13:00" });
});

test("Campos protegidos, payload incompleto/vacío y boolean inválido", async () => {
  for (const campo of ["local_id", "id", "activo", "estilista_id", "created_at", "otro"]) {
    assert.equal((await http("POST", base, { ...valido, [campo]: 1 })).status, 400);
  }
  assert.equal((await http("POST", base, { diaSemana: 1 })).status, 400);
  const h = await crear();
  for (const body of [{}, [], { activo: "false" }, { activo: 1 }, { local_id: locales[1] }, { updated_at: "hoy" }]) {
    assert.equal((await http("PATCH", `${base}/${h.id}`, body)).status, 400);
  }
});

test("PATCH reconstruye estado final, excluye propio ID y permite no-op", async () => {
  const h = await crear();
  assert.equal((await http("PATCH", `${base}/${h.id}`, { horaInicio: "14:00" })).status, 400);
  const result = await http("PATCH", `${base}/${h.id}`, { diaSemana: 2, horaInicio: "10:00", horaFin: "14:00" });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { id: h.id, dia_semana: 2, hora_inicio: "10:00:00", hora_fin: "14:00:00", activo: 1 });
  assert.equal((await http("PATCH", `${base}/${h.id}`, { activo: true })).status, 200);
});

test("Inactivo visible, ignorado en solapamientos, reactivación conflictiva rechazada", async () => {
  const h = await crear();
  assert.equal((await http("PATCH", `${base}/${h.id}`, { activo: false })).status, 200);
  await crear({ diaSemana: 1, horaInicio: "10:00", horaFin: "14:00" });
  assert.equal((await http("PATCH", `${base}/${h.id}`, { activo: true })).status, 409);
  assert.equal((await http("PATCH", `${base}/${h.id}`, { horaInicio: "08:00" })).status, 200);
  const rows = JSON.parse((await http("GET")).body) as Horario[];
  assert.equal(rows.find(r => r.id === h.id)?.activo, 0);
});

test("UNIQUE incluye inactivos en POST y PATCH; rollback preserva fila", async () => {
  const h = await crear();
  await http("PATCH", `${base}/${h.id}`, { activo: false });
  assert.equal((await http("POST", base, valido)).status, 409);
  const otro = await crear({ diaSemana: 1, horaInicio: "15:00", horaFin: "18:00" });
  assert.equal((await http("PATCH", `${base}/${otro.id}`, { horaInicio: "09:00", horaFin: "13:00", activo: false })).status, 409);
  const rows = JSON.parse((await http("GET")).body) as Horario[];
  assert.equal(rows.find(r => r.id === otro.id)?.hora_inicio, "15:00:00");
});

test("Cambio de día valida conflictos en destino y revierte", async () => {
  const h = await crear();
  await crear({ ...valido, diaSemana: 2 });
  assert.equal((await http("PATCH", `${base}/${h.id}`, { diaSemana: 2 })).status, 409);
  assert.equal((JSON.parse((await http("GET")).body) as Horario[]).find(r => r.id === h.id)?.dia_semana, 1);
});

test("PATCH/DELETE ajenos o inexistentes: 404; IDs inválidos: 400", async () => {
  const h = await crear(valido, locales[1]);
  for (const id of [h.id, 2147483647]) {
    assert.equal((await http("PATCH", `${base}/${id}`, { activo: false })).status, 404);
    assert.equal((await http("DELETE", `${base}/${id}`)).status, 404);
  }
  for (const id of ["1abc", "0", "-1", "1.5", "2147483648"]) assert.equal((await http("DELETE", `${base}/${id}`)).status, 400);
});

test("DELETE hard delete 204 y posterior 404", async () => {
  const h = await crear();
  const result = await http("DELETE", `${base}/${h.id}`);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.deepEqual(JSON.parse((await http("GET")).body), []);
  assert.equal((await http("DELETE", `${base}/${h.id}`)).status, 404);
});

test("Concurrencia con agenda vacía: lock local impide dos creaciones incompatibles", { timeout: 10000 }, async () => {
  const connection = await pool.getConnection();
  let pending: Promise<{ status: number; body: string }>[] = [];
  try {
    await connection.beginTransaction();
    await connection.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [locales[0]]);
    let terminadas = 0;
    pending = [http("POST", base, valido), http("POST", base, { diaSemana: 1, horaInicio: "12:00", horaFin: "15:00" })];
    for (const promise of pending) void promise.then(() => { terminadas++; });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(terminadas, 0, "Ambas escrituras deben esperar el lock de locales");
    await connection.commit();
    assert.deepEqual((await Promise.all(pending)).map(r => r.status).sort(), [201, 409]);
    assert.equal(JSON.parse((await http("GET")).body).length, 1);
  } finally {
    await connection.rollback();
    connection.release();
    await Promise.allSettled(pending);
  }
});

test("Reactivar vs crear simultáneamente: solo una operación gana", async () => {
  const h = await crear();
  await http("PATCH", `${base}/${h.id}`, { activo: false });
  const results = await Promise.all([
    http("PATCH", `${base}/${h.id}`, { activo: true }),
    http("POST", base, { diaSemana: 1, horaInicio: "12:00", horaFin: "16:00" }),
  ]);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  const rows = JSON.parse((await http("GET")).body) as Horario[];
  assert.equal(rows.filter(r => r.activo === 1).length, 1);
});

test("Bloqueo dentro del horario NO es conflicto (ambos órdenes de creación)", async () => {
  await crear({ diaSemana: 2, horaInicio: "09:00", horaFin: "18:00" });
  assert.equal((await http("POST", "/api/pet/admin/bloqueos", { fecha: "2026-10-20", esDiaCompleto: false, horaInicio: "14:00", horaFin: "16:00" })).status, 201);
  assert.equal((await http("POST", "/api/pet/admin/bloqueos", { fecha: "2026-10-21", esDiaCompleto: true })).status, 201);
  await crear({ diaSemana: 3, horaInicio: "09:00", horaFin: "18:00" });
});

test("MySQL CHECK de día y horas, FK, UNIQUE y CASCADE", async () => {
  for (const [dia, inicio, fin] of [[-1, "09:00", "13:00"], [7, "09:00", "13:00"], [1, "13:00", "13:00"], [1, "22:00", "02:00"], [1, "-01:00", "13:00"], [1, "09:00", "24:00"]]) {
    await assert.rejects(pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)", [locales[0], dia, inicio, fin]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  }
  await assert.rejects(pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, 1, '09:00', '13:00')", [2147483647]), { code: "ER_NO_REFERENCED_ROW_2" });
  await crear();
  await assert.rejects(pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, 1, '09:00', '13:00', 0)", [locales[0]]), { code: "ER_DUP_ENTRY" });
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, 1, '09:00', '13:00')", [locales[2]]);
  await pool.query("DELETE FROM locales WHERE id = ?", [locales[2]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM horarios_local WHERE local_id = ?", [locales[2]]);
  assert.equal(rows.length, 0);
});
