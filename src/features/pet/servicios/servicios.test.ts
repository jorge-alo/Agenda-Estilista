import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { before, beforeEach, after, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import router from "../pet.routes";
import { ServiciosRouter } from "../../servicios/servicio.routes";

const secret = "PET03_FICTICIO_EXCLUSIVO_TESTS";
const locales: number[] = [];
let server: Server;
let port: number;
let mascota: number;
let otraMascota: number;
let servicio: number;
let otroServicio: number;
let inactivo: number;
const base = "/api/pet/admin";
const path = () => `${base}/mascotas/${mascota}/servicios`;

async function insert(sql: string, values: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

async function http(method: string, url: string, body?: unknown, localId: number | null = locales[0]) {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, rol: "admin", localId }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path: url,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let result = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { result += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: result }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

before(async () => {
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    locales.push(await insert("INSERT INTO locales (nombre, business_type) VALUES (?, ?)", ["Fixture PET03", business]));
  }
  mascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Rocky", locales[0]]);
  otraMascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Lola", locales[1]]);
  servicio = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Baño", 25, locales[0]]);
  otroServicio = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Otro", 30, locales[1]]);
  inactivo = await insert("INSERT INTO servicios (nombre, duracion, local_id, activo) VALUES (?, ?, ?, 0)", ["Inactivo", 35, locales[0]]);
  const app = express();
  app.use(express.json());
  app.use(base, router);
  app.use("/api/servicios", ServiciosRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  for (const localId of locales) await pool.query("DELETE FROM mascota_servicios WHERE local_id = ?", [localId]);
  await pool.query("UPDATE servicios SET activo = 1 WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  await pool.query("UPDATE mascotas SET activo = 1 WHERE id = ? AND local_id = ?", [mascota, locales[0]]);
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { errors.push(error); }
  try {
    for (const localId of locales) {
      try {
        await pool.query("DELETE FROM servicios WHERE local_id = ?", [localId]);
        await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
      } catch (error) { errors.push(error); }
    }
  } finally { await pool.end(); }
  assert.equal(errors.length, 0, "Todos los fixtures PET03 deben limpiarse");
});

async function asignar() {
  const result = await http("POST", path(), { servicioId: servicio, duracionMinutos: 60 });
  assert.equal(result.status, 201, result.body);
}

for (const [label, tenant, status] of [["PET", 0, 200], ["BEAUTY", 2, 403], ["sin auth", -1, 401]] as const) {
  test(`Vertical: ${label}`, async () => {
    assert.equal((await http("GET", `${base}/servicios`, undefined, tenant < 0 ? null : locales[tenant])).status, status);
  });
}

test("Catálogo tenant incluye activos/inactivos e ignora local_id de query", async () => {
  const result = await http("GET", `${base}/servicios?local_id=${locales[1]}`);
  assert.equal(result.status, 200);
  const rows = JSON.parse(result.body) as Array<{ id: number; activo: number; duracion: number }>;
  assert.deepEqual(rows.map(r => r.id).sort((a, b) => a - b), [servicio, inactivo]);
  assert.equal(rows.find(r => r.id === inactivo)?.activo, 0);
  assert.equal(rows.find(r => r.id === servicio)?.duracion, 25);
});

test("Asigna duración explícita y conserva duración del catálogo", async () => {
  await asignar();
  const [rows] = await pool.query<RowDataPacket[]>("SELECT duracion_minutos FROM mascota_servicios WHERE mascota_id = ? AND local_id = ?", [mascota, locales[0]]);
  assert.equal(rows[0].duracion_minutos, 60);
  const [catalogo] = await pool.query<RowDataPacket[]>("SELECT duracion FROM servicios WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  assert.equal(catalogo[0].duracion, 25);
});

test("Otro tenant y padres inexistentes responden 404", async () => {
  for (const [m, s] of [[otraMascota, servicio], [mascota, otroServicio], [2147483647, servicio], [mascota, 2147483647]]) {
    assert.equal((await http("POST", `${base}/mascotas/${m}/servicios`, { servicioId: s, duracionMinutos: 60 })).status, 404);
  }
});

test("Duplicado responde 409 sin reemplazar duración", async () => {
  await asignar();
  assert.equal((await http("POST", path(), { servicioId: servicio, duracionMinutos: 90 })).status, 409);
  assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 60);
});

test("Servicio inactivo rechaza nuevas asociaciones", async () => {
  assert.equal((await http("POST", path(), { servicioId: inactivo, duracionMinutos: 60 })).status, 409);
});

for (const value of [0, -1, 1.5, "60", null, true, {}, 2147483648, undefined]) {
  test(`Duración inválida POST y PATCH: ${JSON.stringify(value)}`, async () => {
    assert.equal((await http("POST", path(), { servicioId: servicio, duracionMinutos: value })).status, 400);
    await asignar();
    assert.equal((await http("PATCH", `${path()}/${servicio}`, { duracionMinutos: value })).status, 400);
  });
}

test("Rechaza campos protegidos y extras en POST/PATCH", async () => {
  for (const campo of ["local_id", "mascota_id", "duracion", "activo"]) {
    assert.equal((await http("POST", path(), { servicioId: servicio, duracionMinutos: 60, [campo]: 1 })).status, 400);
    assert.equal((await http("PATCH", `${path()}/${servicio}`, { duracionMinutos: 60, [campo]: 1 })).status, 400);
  }
  assert.equal((await http("PATCH", `${path()}/${servicio}`, { duracionMinutos: 60, servicioId: otroServicio })).status, 400);
});

test("IDs estrictos, sin parseInt parcial", async () => {
  for (const id of ["1abc", "0", "-1", "1.5", "2147483648"]) {
    assert.equal((await http("GET", `${base}/mascotas/${id}/servicios`)).status, 400);
  }
  assert.equal((await http("POST", path(), { servicioId: "1", duracionMinutos: 60 })).status, 400);
});

test("Lectura sin relación es vacía; no lista todo el catálogo", async () => {
  assert.deepEqual(JSON.parse((await http("GET", path())).body), []);
});

test("Configuración inactiva sigue visible y editable; PATCH idéntico es 200", async () => {
  await pool.query("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [mascota, locales[0]]);
  await asignar();
  await pool.query("UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  for (let i = 0; i < 2; i++) assert.equal((await http("PATCH", `${path()}/${servicio}`, { duracionMinutos: 90 })).status, 200);
  const result = await http("GET", path());
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), [{ id: servicio, nombre: "Baño", activo: 0, duracion_minutos: 90 }]);
});

test("Otro tenant no puede leer, editar ni borrar configuración", async () => {
  await asignar();
  for (const method of ["GET", "PATCH", "DELETE"]) {
    assert.equal((await http(method, method === "GET" ? path() : `${path()}/${servicio}`, method === "PATCH" ? { duracionMinutos: 90 } : undefined, locales[1])).status, 404);
  }
  assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 60);
});

test("PATCH y DELETE de relación inexistente son 404", async () => {
  assert.equal((await http("PATCH", `${path()}/${servicio}`, { duracionMinutos: 90 })).status, 404);
  assert.equal((await http("DELETE", `${path()}/${servicio}`)).status, 404);
});

test("DELETE 204 solo elimina relación", async () => {
  await asignar();
  const result = await http("DELETE", `${path()}/${servicio}`);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.deepEqual(JSON.parse((await http("GET", path())).body), []);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM servicios WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  assert.equal(rows.length, 1);
});

test("BEAUTY conserva CRUD compartido y duración", async () => {
  const created = await http("POST", "/api/servicios", { nombre: "Beauty fixture", duracion: 45, precio: 100 }, locales[2]);
  assert.equal(created.status, 200, created.body);
  const id = JSON.parse(created.body).id as number;
  const listado = await http("GET", "/api/servicios/admin", undefined, locales[2]);
  assert.equal(listado.status, 200);
  assert.equal(JSON.parse(listado.body).find((s: { id: number }) => s.id === id).duracion, 45);
  assert.equal((await http("PATCH", `/api/servicios/${id}/toggle`, undefined, locales[2])).status, 200);
  assert.equal((await http("DELETE", `/api/servicios/${id}`, undefined, locales[2])).status, 200);
});

for (const duration of [0, -1]) {
  test(`MySQL CHECK rechaza ${duration}`, async () => {
    await assert.rejects(pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, ?)", [locales[0], mascota, servicio, duration]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });
}

test("MySQL FK rechaza cruces tenant, local falsificado y padres inexistentes", async () => {
  for (const values of [[locales[0], mascota, otroServicio], [locales[1], mascota, servicio], [locales[0], otraMascota, servicio], [locales[0], 2147483647, servicio], [locales[0], mascota, 2147483647]]) {
    await assert.rejects(pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 60)", values), { code: "ER_NO_REFERENCED_ROW_2" });
  }
});

test("MySQL PK rechaza duplicado", async () => {
  await asignar();
  await assert.rejects(pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 90)", [locales[0], mascota, servicio]), { code: "ER_DUP_ENTRY" });
});

test("MySQL CASCADE mascota limpia la relación", async () => {
  const id = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Cascade", locales[0]]);
  await pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 60)", [locales[0], id, servicio]);
  await pool.query("DELETE FROM mascotas WHERE id = ? AND local_id = ?", [id, locales[0]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE mascota_id = ? AND local_id = ?", [id, locales[0]]);
  assert.equal(rows.length, 0);
});

test("Hard delete compartido de servicio limpia configuración mediante CASCADE", async () => {
  const id = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Cascade", 25, locales[0]]);
  await pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 60)", [locales[0], mascota, id]);
  assert.equal((await http("DELETE", `/api/servicios/${id}`)).status, 200);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE servicio_id = ? AND local_id = ?", [id, locales[0]]);
  assert.equal(rows.length, 0);
});
