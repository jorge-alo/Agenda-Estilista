import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../config/db";
import { ServiciosRouter } from "./servicio.routes";
import { duracionBeautyValida } from "./servicio.validation";

const secret = "M3B1_SERVICIOS_FICTICIO_SOLO_TESTS";
const locales: number[] = [];
const slugs = Array.from({ length: 3 }, () => `m3b1-servicios-${randomUUID()}`);
let server: Server;
let port: number;
let servicio: number;
let servicioAjeno: number;
let servicioPet: number;
let estilista: number;
let estilistaAjeno: number;
let estilistaPet: number;

async function insert(sql: string, values: unknown[]) {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

async function http(method: string, path: string, body?: unknown, localId: number | null = locales[0], rol = "admin") {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, localId, rol }, secret, { expiresIn: "1m" });
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: `/api/servicios${path}`,
      headers: { "Content-Type": "application/json", ...(payload === undefined ? {} : { "Content-Length": String(Buffer.byteLength(payload)) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let result = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { result += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: result }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

before(async () => {
  for (const [index, business] of ["BEAUTY", "BEAUTY", "PET_GROOMING"].entries()) {
    locales.push(await insert("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", ["Fixture M3B1 servicios", slugs[index], business]));
  }
  [servicio, servicioAjeno, servicioPet] = await Promise.all(locales.map(localId =>
    insert("INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 0, ?)", ["M3B1 catálogo", localId])));
  [estilista, estilistaAjeno, estilistaPet] = await Promise.all(locales.map(localId =>
    insert("INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)", ["M3B1 estilista", localId])));
  const app = express();
  app.use(express.json());
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
  for (const localId of locales) {
    await pool.query("DELETE es FROM estilista_servicios es JOIN estilistas e ON e.id = es.estilista_id WHERE e.local_id = ?", [localId]);
  }
  await pool.query("UPDATE servicios SET activo = 1 WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
});

after(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const localId of locales) {
      await pool.query("DELETE es FROM estilista_servicios es JOIN estilistas e ON e.id = es.estilista_id WHERE e.local_id = ?", [localId]);
      await pool.query("DELETE FROM servicios WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM estilistas WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM locales WHERE id = ?", [localId]);
      assert.equal(rows[0].n, 0);
    }
  } finally { await pool.end(); }
});

for (const [label, tenant, rol, status] of [
  ["sin auth", -1, "admin", 401], ["BEAUTY no-admin", 0, "estilista", 403],
  ["PET admin", 2, "admin", 403], ["BEAUTY superadmin", 0, "superadmin", 403],
] as const) {
  test(`M.3B.1 ${label}: seis rutas legacy rechazan sin ejecutar escrituras`, async t => {
    await pool.query("INSERT INTO estilista_servicios (estilista_id, servicio_id) VALUES (?, ?)", [estilista, servicio]);
    const query = pool.query.bind(pool);
    const spy = t.mock.method(pool, "query", ((sql: string, values?: unknown[]) => {
      assert.match(sql.trim(), /^SELECT\b/i, "Un rechazo no debe ejecutar INSERT/UPDATE/DELETE");
      return query(sql, values);
    }) as typeof pool.query);
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "", { nombre: "No crear", duracion: 30, precio: 10, local_id: locales[0] }],
      ["GET", "/admin"], ["POST", "/asignar", { estilista_id: estilista, servicio_id: servicio }],
      ["DELETE", "/desasignar", { estilista_id: estilista, servicio_id: servicio }],
      ["DELETE", `/${servicio}`], ["PATCH", `/${servicio}/toggle`],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await http(method, path, body, tenant < 0 ? null : locales[tenant], rol)).status, status);
    }
    assert.equal(spy.mock.callCount(), tenant < 0 ? 0 : routes.length);
  });
}

test("M.3B.1 BEAUTY admin conserva éxito en las seis rutas y tenant JWT", async () => {
  const created = await http("POST", "", { nombre: "BEAUTY válido", duracion: 45, precio: 0, local_id: locales[2] });
  assert.equal(created.status, 200, created.body);
  const id = (JSON.parse(created.body) as { id: number }).id;
  assert.deepEqual(JSON.parse(created.body), { message: "Servicio creado", id });
  const list = await http("GET", "/admin");
  assert.equal(list.status, 200);
  const row = (JSON.parse(list.body) as Array<{ id: number; local_id: number; duracion: number; precio: string }>).find(r => r.id === id);
  assert.equal(row?.local_id, locales[0]);
  assert.equal(row?.duracion, 45);
  assert.equal(Number(row?.precio), 0);
  const relation = { estilista_id: estilista, servicio_id: id };
  assert.deepEqual(JSON.parse((await http("POST", "/asignar", relation)).body), { message: "Servicio asignado al estilista" });
  assert.deepEqual(JSON.parse((await http("DELETE", "/desasignar", relation)).body), { message: "Servicio desasignado" });
  assert.deepEqual(JSON.parse((await http("PATCH", `/${id}/toggle`)).body), { message: "Estado actualizado" });
  assert.deepEqual(JSON.parse((await http("DELETE", `/${id}`)).body), { message: "Servicio eliminado" });
});

test("M.3B.1 slug BEAUTY conserva filas completas; slug PET no expone catálogo", async () => {
  const beauty = await http("GET", `?slug=${slugs[0]}`, undefined, null);
  assert.equal(beauty.status, 200);
  const [expected] = await pool.query<RowDataPacket[]>("SELECT * FROM servicios WHERE local_id = ?", [locales[0]]);
  assert.deepEqual(JSON.parse(beauty.body), JSON.parse(JSON.stringify(expected)));
  const pet = await http("GET", `?slug=${slugs[2]}&local_id=${locales[0]}`, undefined, null);
  assert.equal(pet.status, 200);
  assert.deepEqual(JSON.parse(pet.body), []);
});

test("M.3B.1 estilista solo muestra servicios activos del mismo tenant BEAUTY", async () => {
  for (const pair of [[estilista, servicio], [estilista, servicioAjeno], [estilista, servicioPet], [estilistaPet, servicioPet], [estilistaAjeno, servicio]]) {
    await pool.query("INSERT INTO estilista_servicios (estilista_id, servicio_id) VALUES (?, ?)", pair);
  }
  const valid = await http("GET", `/estilista/${estilista}`, undefined, null);
  assert.equal(valid.status, 200);
  const [expected] = await pool.query<RowDataPacket[]>("SELECT * FROM servicios WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  assert.deepEqual(JSON.parse(valid.body), JSON.parse(JSON.stringify(expected)));
  for (const id of [estilistaAjeno, estilistaPet, 2147483647, "invalido", "1.5", "0"]) {
    const result = await http("GET", `/estilista/${id}?local_id=${locales[0]}`, undefined, null);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), []);
  }
  await pool.query("UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  assert.deepEqual(JSON.parse((await http("GET", `/estilista/${estilista}`, undefined, null)).body), []);
});

for (const value of [undefined, null, 0, -1, 1.5, "30", 2147483648, true, {}, []]) {
  test(`M.3B.1 alta BEAUTY duración inválida ${JSON.stringify(value)} devuelve 400 sin INSERT`, async t => {
    const query = pool.query.bind(pool);
    t.mock.method(pool, "query", ((sql: string, values?: unknown[]) => {
      assert.match(sql.trim(), /^SELECT\b/i);
      return query(sql, values);
    }) as typeof pool.query);
    assert.equal((await http("POST", "", { nombre: "Inválido", duracion: value, precio: 0 })).status, 400);
  });
}

for (const precio of [undefined, null]) {
  test(`M.3B.1 precio ${String(precio)} sigue siendo requerido`, async () => {
    assert.equal((await http("POST", "", { nombre: "Inválido", duracion: 30, precio })).status, 400);
  });
}

test("M.3B.1 nombre sigue requerido", async () => {
  for (const nombre of [undefined, null, "", "   ", 42]) {
    assert.equal((await http("POST", "", { nombre, duracion: 30, precio: 0 })).status, 400);
  }
});

test("M.3B.1 validador directo rechaza NaN/Infinity; límites INT positivos válidos", () => {
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(duracionBeautyValida(value), false);
  for (const value of [1, 30, 2147483647]) assert.equal(duracionBeautyValida(value), true);
});
