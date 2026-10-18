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
import type { Bloqueo } from "./bloqueos.types";
import { guardar } from "./bloqueos.service";

const secret = "PET05_BLOQUEOS_FICTICIO_SOLO_TEST";
const locales: number[] = [];
const base = "/api/pet/admin/bloqueos";
const parcial = { fecha: "2026-10-20", esDiaCompleto: false, horaInicio: "10:00", horaFin: "12:00" };
const completo = { fecha: "2026-10-20", esDiaCompleto: true };
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

async function crear(body: Record<string, unknown> = parcial, localId = locales[0]): Promise<Bloqueo> {
  const result = await http("POST", base, body, localId);
  assert.equal(result.status, 201, result.body);
  return JSON.parse(result.body) as Bloqueo;
}

before(async () => {
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    const [result] = await pool.query<ResultSetHeader>("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", ["Fixture PET05 bloqueos", randomUUID(), business]);
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
  for (const id of locales) await pool.query("DELETE FROM bloqueos_local WHERE local_id = ?", [id]);
});

after(async () => {
  const errors: unknown[] = [];
  try { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (error) { errors.push(error); }
  try {
    for (const id of locales) {
      try {
        await pool.query("DELETE FROM locales WHERE id = ?", [id]);
        const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM bloqueos_local WHERE local_id = ?", [id]);
        assert.equal(rows.length, 0);
      } catch (error) { errors.push(error); }
    }
  } finally { await pool.end(); }
  assert.equal(errors.length, 0, "Fixtures bloqueos deben limpiarse");
});

for (const [label, tenant, status] of [["sin auth", -1, 401], ["BEAUTY", 2, 403]] as const) {
  test(`${label} bloqueado en cuatro rutas bloqueos`, async () => {
    for (const [method, path, body] of [["GET", base, undefined], ["POST", base, parcial], ["PATCH", `${base}/1`, { motivo: "X" }], ["DELETE", `${base}/1`, undefined]] as const) {
      assert.equal((await http(method, path, body, tenant < 0 ? null : locales[tenant])).status, status);
    }
  });
}

test("Parcial, día completo y GET tenant con fechas ISO/horas normalizadas", async () => {
  const b = await crear({ ...parcial, motivo: "  Mantenimiento  " });
  const total = await crear({ fecha: "2026-10-21", esDiaCompleto: true, horaInicio: null, horaFin: null });
  await crear(parcial, locales[1]);
  assert.deepEqual(b, { id: b.id, fecha: "2026-10-20", hora_inicio: "10:00:00", hora_fin: "12:00:00", es_dia_completo: 0, motivo: "Mantenimiento" });
  assert.equal(total.hora_inicio, null);
  assert.equal(total.hora_fin, null);
  const result = await http("GET", `${base}?local_id=${locales[1]}`);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), [b, total]);
});

test("Rango inclusivo y sin rango; ambas fronteras y mismo día", async () => {
  await crear({ ...completo, fecha: "2026-09-30" });
  const inicio = await crear({ ...completo, fecha: "2026-10-01" });
  const fin = await crear({ ...completo, fecha: "2026-10-31" });
  await crear({ ...completo, fecha: "2026-11-01" });
  assert.deepEqual(JSON.parse((await http("GET", `${base}?desde=2026-10-01&hasta=2026-10-31`)).body), [inicio, fin]);
  assert.deepEqual(JSON.parse((await http("GET", `${base}?desde=2026-10-31&hasta=2026-10-31`)).body), [fin]);
  assert.equal(JSON.parse((await http("GET")).body).length, 4);
});

for (const query of ["desde=2026-10-01", "hasta=2026-10-31", "desde=2026-11-01&hasta=2026-10-01", "desde=2026-02-30&hasta=2026-10-31", "desde=x&hasta=2026-10-31", "desde=&hasta=2026-10-31", "desde=2026-10-01&desde=2026-10-02&hasta=2026-10-31"]) {
  test(`Rango inválido: ${query}`, async () => { assert.equal((await http("GET", `${base}?${query}`)).status, 400); });
}

for (const fecha of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-00-10", "2026-13-01", "2026-10-00", "0000-00-00", "2026-1-1", "2026-10-20T00:00:00Z", 20261020, null]) {
  test(`Fecha inválida ${JSON.stringify(fecha)}`, async () => { assert.equal((await http("POST", base, { ...completo, fecha })).status, 400); });
}

test("Fecha bisiesta válida", async () => { await crear({ ...completo, fecha: "2028-02-29" }); });

test("Parcial requiere horas y orden; completo rechaza horas simultáneas", async () => {
  for (const body of [
    { fecha: parcial.fecha, esDiaCompleto: false },
    { ...parcial, horaInicio: null }, { ...parcial, horaFin: null },
    { ...parcial, horaInicio: "12:00" }, { ...parcial, horaInicio: "22:00", horaFin: "02:00" },
    { ...completo, horaInicio: "00:00", horaFin: "23:59" },
    { ...completo, horaInicio: "10:00" }, { ...completo, horaFin: "12:00" },
    { ...parcial, esDiaCompleto: 1 }, { ...parcial, esDiaCompleto: "false" },
  ]) assert.equal((await http("POST", base, body)).status, 400);
});

test("Horas estrictas, motivo hasta 255, sin campos protegidos", async () => {
  for (const horaInicio of ["9:00", "24:00", "-01:00", "10:60", "10:00:60", "10:00:01", "10:00:30", "10:30:59", "23:59:59", true, {}, 10]) {
    assert.equal((await http("POST", base, { ...parcial, horaInicio })).status, 400);
  }
  for (const campo of ["id", "local_id", "activo", "estilista_id", "created_at", "updated_at", "otro"]) {
    assert.equal((await http("POST", base, { ...parcial, [campo]: 1 })).status, 400);
  }
  for (const motivo of ["a".repeat(256), 5, true, {}]) assert.equal((await http("POST", base, { ...parcial, motivo })).status, 400);
  await crear({ ...parcial, motivo: "a".repeat(255) });
});

test("HH:mm y segundos 00 válidos; horas normalizadas a HH:mm:ss", async () => {
  assert.equal((await crear({ fecha: "2026-10-22", esDiaCompleto: false, horaInicio: "09:00", horaFin: "10:00" })).hora_inicio, "09:00:00");
  assert.equal((await crear({ fecha: "2026-10-23", esDiaCompleto: false, horaInicio: "09:00:00", horaFin: "10:00:00" })).hora_fin, "10:00:00");
  assert.equal((await crear({ fecha: "2026-10-24", esDiaCompleto: false, horaInicio: "09:15:00", horaFin: "10:15" })).hora_inicio, "09:15:00");
  assert.equal((await crear({ fecha: "2026-10-25", esDiaCompleto: false, horaInicio: "22:59", horaFin: "23:59" })).hora_fin, "23:59:00");
});

test("Adyacencia permitida, intersecciones en ambos sentidos/contenidas rechazadas", async () => {
  await crear();
  await crear({ ...parcial, horaInicio: "12:00", horaFin: "14:00" });
  for (const [horaInicio, horaFin] of [["09:00", "11:00"], ["11:00", "13:00"], ["10:30", "11:30"], ["09:00", "15:00"], ["10:00", "12:00"]]) {
    assert.equal((await http("POST", base, { ...parcial, horaInicio, horaFin })).status, 409);
  }
});

test("Parcial existente impide día completo", async () => {
  await crear();
  assert.equal((await http("POST", base, completo)).status, 409);
});

test("Día completo impide parcial y otro completo; otra fecha permitida", async () => {
  await crear(completo);
  assert.equal((await http("POST", base, parcial)).status, 409);
  assert.equal((await http("POST", base, completo)).status, 409);
  await crear({ ...completo, fecha: "2026-10-21" });
});

test("PATCH parcial->completo limpia horas, completo->parcial exige ambas", async () => {
  const b = await crear();
  const total = await http("PATCH", `${base}/${b.id}`, { esDiaCompleto: true });
  assert.equal(total.status, 200);
  assert.equal(JSON.parse(total.body).hora_inicio, null);
  assert.equal(JSON.parse(total.body).hora_fin, null);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { esDiaCompleto: false })).status, 400);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { esDiaCompleto: false, horaInicio: "10:00" })).status, 400);
  const parcialNuevo = await http("PATCH", `${base}/${b.id}`, { esDiaCompleto: false, horaInicio: "14:00", horaFin: "16:00" });
  assert.equal(parcialNuevo.status, 200);
  assert.equal(JSON.parse(parcialNuevo.body).hora_inicio, "14:00:00");
});

test("PATCH reconstruye intervalo; propio ID no conflictúa y no-op es 200", async () => {
  const b = await crear();
  assert.equal((await http("PATCH", `${base}/${b.id}`, { horaInicio: "13:00" })).status, 400);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { motivo: "Cambio" })).status, 200);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { horaInicio: "10:00:00" })).status, 200);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { motivo: null })).status, 200);
  assert.equal(JSON.parse((await http("GET")).body)[0].motivo, null);
});

test("PATCH completo rechaza horas; vacío/campos extra/tipos inválidos son 400", async () => {
  const b = await crear(completo);
  for (const body of [{}, [], { horaInicio: "10:00" }, { local_id: locales[1] }, { esDiaCompleto: "true" }, { fecha: "2026-02-30" }, { motivo: 2 }]) {
    assert.equal((await http("PATCH", `${base}/${b.id}`, body)).status, 400);
  }
});

test("PATCH fecha valida destino y revierte conflicto, permite mover a fecha libre", async () => {
  const b = await crear();
  await crear({ ...completo, fecha: "2026-10-21" });
  assert.equal((await http("PATCH", `${base}/${b.id}`, { fecha: "2026-10-21" })).status, 409);
  assert.equal((JSON.parse((await http("GET")).body) as Bloqueo[]).find(r => r.id === b.id)?.fecha, parcial.fecha);
  assert.equal((await http("PATCH", `${base}/${b.id}`, { fecha: "2026-10-22" })).status, 200);
});

test("PATCH a completo con otra franja mismo día es 409 y conserva parcial", async () => {
  const b = await crear();
  await crear({ ...parcial, horaInicio: "15:00", horaFin: "17:00" });
  assert.equal((await http("PATCH", `${base}/${b.id}`, { esDiaCompleto: true })).status, 409);
  assert.equal((JSON.parse((await http("GET")).body) as Bloqueo[]).find(r => r.id === b.id)?.es_dia_completo, 0);
});

test("PATCH/DELETE cross-tenant/inexistente 404; ID inválido 400", async () => {
  const b = await crear(parcial, locales[1]);
  for (const id of [b.id, 2147483647]) {
    assert.equal((await http("PATCH", `${base}/${id}`, { motivo: "X" })).status, 404);
    assert.equal((await http("DELETE", `${base}/${id}`)).status, 404);
  }
  for (const id of ["1abc", "0", "-1", "1.5", "2147483648"]) assert.equal((await http("DELETE", `${base}/${id}`)).status, 400);
});

test("DELETE hard delete 204, libera fecha y posterior 404", async () => {
  const b = await crear(completo);
  const result = await http("DELETE", `${base}/${b.id}`);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.deepEqual(JSON.parse((await http("GET")).body), []);
  assert.equal((await http("DELETE", `${base}/${b.id}`)).status, 404);
  await crear();
});

test("Concurrencia fecha vacía: día completo vs parcial espera lock local y solo uno gana", { timeout: 10000 }, async () => {
  const connection = await pool.getConnection();
  let pending: Promise<{ status: number; body: string }>[] = [];
  try {
    await connection.beginTransaction();
    await connection.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [locales[0]]);
    let terminadas = 0;
    pending = [http("POST", base, parcial), http("POST", base, completo)];
    for (const promise of pending) void promise.then(() => { terminadas++; });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(terminadas, 0);
    await connection.commit();
    assert.deepEqual((await Promise.all(pending)).map(r => r.status).sort(), [201, 409]);
    assert.equal(JSON.parse((await http("GET")).body).length, 1);
  } finally {
    await connection.rollback();
    connection.release();
    await Promise.allSettled(pending);
  }
});

test("Dos parciales solapados concurrentes producen 201/409", async () => {
  const results = await Promise.all([http("POST", base, parcial), http("POST", base, { ...parcial, horaInicio: "11:00", horaFin: "13:00" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
});

test("Dos PATCH concurrentes a la misma fecha: un 200 y un 409", async () => {
  const a = await crear(completo);
  const b = await crear({ ...completo, fecha: "2026-10-21" });
  const results = await Promise.all([http("PATCH", `${base}/${a.id}`, { fecha: "2026-10-22" }), http("PATCH", `${base}/${b.id}`, { fecha: "2026-10-22" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test("Concurrencia de distintos tenants no genera conflicto entre ellos", { timeout: 10000 }, async t => {
  // Forzar ambas lecturas de agenda vacía antes de insertar: detecta deadlocks
  // por gap locks compartidos entre tenants bajo REPEATABLE READ.
  const getConnection = pool.getConnection.bind(pool);
  let lecturas = 0;
  let liberar!: () => void;
  const barrera = new Promise<void>(resolve => { liberar = resolve; });
  t.mock.method(pool, "getConnection", async () => {
    const connection = await getConnection();
    return new Proxy(connection, {
      get(target, property) {
        if (property === "query") return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql.startsWith("SELECT id FROM bloqueos_local WHERE")) {
            if (++lecturas === 2) liberar();
            await barrera;
          }
          return result;
        };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const results = await Promise.allSettled([guardar(locales[0], completo), guardar(locales[1], completo)]);
  assert.deepEqual(results.map(r => r.status === "fulfilled" ? "creado" : (r.reason as { code?: string }).code), ["creado", "creado"]);
});

test("MySQL CHECK combina bandera/horas sin aceptar NULL inválido", async () => {
  for (const [flag, inicio, fin] of [[2, null, null], [0, null, null], [0, "10:00", null], [0, null, "12:00"], [1, "00:00", "23:59"], [1, "10:00", null], [0, "12:00", "12:00"], [0, "22:00", "02:00"], [0, "-01:00", "12:00"], [0, "10:00", "24:00"]]) {
    await assert.rejects(pool.query("INSERT INTO bloqueos_local (local_id, fecha, es_dia_completo, hora_inicio, hora_fin) VALUES (?, '2026-10-20', ?, ?, ?)", [locales[0], flag, inicio, fin]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  }
});

test("MySQL FK y CASCADE del local", async () => {
  await assert.rejects(pool.query("INSERT INTO bloqueos_local (local_id, fecha, es_dia_completo) VALUES (?, '2026-10-20', 1)", [2147483647]), { code: "ER_NO_REFERENCED_ROW_2" });
  await pool.query("INSERT INTO bloqueos_local (local_id, fecha, es_dia_completo) VALUES (?, '2026-10-20', 1)", [locales[2]]);
  await pool.query("DELETE FROM locales WHERE id = ?", [locales[2]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM bloqueos_local WHERE local_id = ?", [locales[2]]);
  assert.equal(rows.length, 0);
});
