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
import type { Extra, ExtraConfigurado } from "./extras.types";

const secret = "PET04_FICTICIO_EXCLUSIVO_TESTS";
const locales: number[] = [];
let server: Server;
let port: number;
let mascota: number;
let otraMascota: number;
let extra: number;
let otroExtra: number;
let inactivo: number;
const base = "/api/pet/admin";
const catalogo = `${base}/extras`;
const path = (id = mascota) => `${base}/mascotas/${id}/extras`;

async function insert(sql: string, values: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

async function http(method: string, url: string, body?: unknown, localId: number | null = locales[0], rol = "admin") {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, rol, localId }, secret, { expiresIn: "1m" });
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
    locales.push(await insert("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)",
      ["Fixture PET04", `pet04-${randomUUID()}`, business]));
  }
  mascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Rocky", locales[0]]);
  otraMascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Lola", locales[1]]);
  const app = express();
  app.use(express.json());
  app.use(base, router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  for (const localId of locales) await pool.query("DELETE FROM extras WHERE local_id = ?", [localId]);
  await pool.query("UPDATE mascotas SET activo = 1 WHERE id = ? AND local_id = ?", [mascota, locales[0]]);
  extra = await insert("INSERT INTO extras (nombre, local_id) VALUES (?, ?)", ["Corte de uñas", locales[0]]);
  inactivo = await insert("INSERT INTO extras (nombre, local_id, activo) VALUES (?, ?, 0)", ["Deslanado", locales[0]]);
  otroExtra = await insert("INSERT INTO extras (nombre, local_id) VALUES (?, ?)", ["Extra ajeno", locales[1]]);
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { errors.push(error); }
  try {
    for (const localId of locales) {
      try {
        // Las FKs del local limpian los extras, mascotas y asociaciones del fixture.
        await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT (SELECT COUNT(*) FROM extras WHERE local_id = ?) AS extras,
                  (SELECT COUNT(*) FROM mascota_extras WHERE local_id = ?) AS relaciones,
                  (SELECT COUNT(*) FROM mascotas WHERE local_id = ?) AS mascotas`, [localId, localId, localId]
        );
        assert.deepEqual([rows[0].extras, rows[0].relaciones, rows[0].mascotas], [0, 0, 0]);
      } catch (error) { errors.push(error); }
    }
  } finally { await pool.end(); }
  assert.equal(errors.length, 0, "Todos los fixtures PET04 deben limpiarse");
});

async function asignar(duracionMinutos = 20): Promise<ExtraConfigurado> {
  const result = await http("POST", path(), { extraId: extra, duracionMinutos });
  assert.equal(result.status, 201, result.body);
  return JSON.parse(result.body) as ExtraConfigurado;
}

test("PET accede al catálogo", async () => {
  assert.equal((await http("GET", catalogo)).status, 200);
});

for (const [label, tenant, rol, status] of [
  ["BEAUTY", 2, "admin", 403], ["sin auth", -1, "admin", 401],
  ["PET no-admin", 0, "estilista", 403], ["PET superadmin", 0, "superadmin", 403],
] as const) {
  test(`${label}: protege las ocho rutas de extras`, async () => {
    await asignar();
    const snapshot = async () => {
      const [extras] = await pool.query<RowDataPacket[]>("SELECT * FROM extras WHERE local_id = ? ORDER BY id", [locales[0]]);
      const [relaciones] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_extras WHERE local_id = ? ORDER BY mascota_id, extra_id", [locales[0]]);
      return { extras, relaciones };
    };
    const previo = await snapshot();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", catalogo], ["POST", catalogo, { nombre: "Nuevo" }],
      ["PATCH", `${catalogo}/${extra}`, { activo: false }], ["DELETE", `${catalogo}/${extra}`],
      ["GET", path()], ["POST", path(), { extraId: extra, duracionMinutos: 20 }],
      ["PATCH", `${path()}/${extra}`, { duracionMinutos: 30 }], ["DELETE", `${path()}/${extra}`],
    ];
    for (const [method, url, body] of routes) {
      assert.equal((await http(method, url, body, tenant < 0 ? null : locales[tenant], rol)).status, status);
      assert.deepEqual(await snapshot(), previo);
    }
  });
}

test("Catálogo incluye activos/inactivos, filtra tenant e ignora query.local_id", async () => {
  const result = await http("GET", `${catalogo}?local_id=${locales[1]}`);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), [
    { id: extra, nombre: "Corte de uñas", activo: 1 },
    { id: inactivo, nombre: "Deslanado", activo: 0 },
  ]);
});

test("Crear extra devuelve recurso, recorta nombre y persiste activo/timestamps", async () => {
  const result = await http("POST", catalogo, { nombre: "  Limpieza de oídos  " });
  assert.equal(result.status, 201);
  const created = JSON.parse(result.body) as Extra;
  assert.deepEqual(created, { id: created.id, nombre: "Limpieza de oídos", activo: 1 });
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM extras WHERE id = ? AND local_id = ?", [created.id, locales[0]]);
  assert.equal(rows[0].nombre, created.nombre);
  assert.equal(rows[0].activo, 1);
  assert.ok(rows[0].created_at);
  assert.ok(rows[0].updated_at);
  assert.ok(!("precio" in rows[0]) && !("duracion" in rows[0]));
});

for (const nombre of [undefined, "", "   ", "a".repeat(101), null, 42, true, {}]) {
  test(`Nombre inválido POST/PATCH: ${JSON.stringify(nombre)}`, async () => {
    assert.equal((await http("POST", catalogo, { nombre })).status, 400);
    assert.equal((await http("PATCH", `${catalogo}/${extra}`, { nombre })).status, 400);
  });
}

test("Nombre de 100 caracteres permitido y creación no acepta payload no objeto", async () => {
  assert.equal((await http("POST", catalogo, { nombre: "a".repeat(100) })).status, 201);
  for (const body of [[], null, "nombre"]) assert.equal((await http("POST", catalogo, body)).status, 400);
});

test("Nombre duplicado en tenant: 409; mismo nombre en otro tenant: 201", async () => {
  assert.equal((await http("POST", catalogo, { nombre: "  Corte de uñas  " })).status, 409);
  assert.equal((await http("POST", catalogo, { nombre: "CORTE DE UÑAS" })).status, 409);
  assert.equal((await http("POST", catalogo, { nombre: "Corte de uñas" }, locales[1])).status, 201);
});

test("Creación concurrente duplicada: una sola fila y 201/409", async () => {
  const results = await Promise.all([http("POST", catalogo, { nombre: "Concurrente" }), http("POST", catalogo, { nombre: "Concurrente" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
});

test("POST catálogo rechaza activo, campos protegidos y pricing", async () => {
  for (const campo of ["id", "local_id", "activo", "created_at", "updated_at", "precio", "duracion", "otro"]) {
    assert.equal((await http("POST", catalogo, { nombre: "Nuevo", [campo]: 1 })).status, 400);
  }
});

test("PATCH catálogo devuelve recurso, permite ambos campos, inactivos y no-op", async () => {
  const update = await http("PATCH", `${catalogo}/${extra}`, { nombre: "  Uñas  ", activo: false });
  assert.equal(update.status, 200);
  assert.deepEqual(JSON.parse(update.body), { id: extra, nombre: "Uñas", activo: 0 });
  const rename = await http("PATCH", `${catalogo}/${extra}`, { nombre: "Limado" });
  assert.deepEqual(JSON.parse(rename.body), { id: extra, nombre: "Limado", activo: 0 });
  for (let i = 0; i < 2; i++) {
    const result = await http("PATCH", `${catalogo}/${extra}`, { activo: true });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { id: extra, nombre: "Limado", activo: 1 });
  }
});

test("PATCH duplicado revierte nombre y activo", async () => {
  const result = await http("PATCH", `${catalogo}/${extra}`, { nombre: "Deslanado", activo: false });
  assert.equal(result.status, 409);
  const rows = JSON.parse((await http("GET", catalogo)).body) as Extra[];
  assert.deepEqual(rows.find(r => r.id === extra), { id: extra, nombre: "Corte de uñas", activo: 1 });
});

test("PATCH catálogo rechaza activo no boolean, payload vacío y campos protegidos", async () => {
  for (const activo of [0, 1, "false", "true", null, {}, []]) {
    assert.equal((await http("PATCH", `${catalogo}/${extra}`, { activo })).status, 400);
  }
  assert.equal((await http("PATCH", `${catalogo}/${extra}`, {})).status, 400);
  for (const campo of ["id", "local_id", "created_at", "updated_at", "precio", "duracion", "otro"]) {
    assert.equal((await http("PATCH", `${catalogo}/${extra}`, { nombre: "X", [campo]: 1 })).status, 400);
  }
});

test("Catálogo ajeno/inexistente responde 404 en PATCH/DELETE", async () => {
  for (const id of [otroExtra, 2147483647]) {
    assert.equal((await http("PATCH", `${catalogo}/${id}`, { nombre: "X" })).status, 404);
    assert.equal((await http("DELETE", `${catalogo}/${id}`)).status, 404);
  }
  const other = JSON.parse((await http("GET", catalogo, undefined, locales[1])).body) as Extra[];
  assert.equal(other[0].nombre, "Extra ajeno");
});

test("Hard delete 204 limpia relaciones por CASCADE y conserva mascota", async () => {
  await asignar();
  const result = await http("DELETE", `${catalogo}/${extra}`);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  const config = await http("GET", path());
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body), []);
  assert.equal((await http("DELETE", `${catalogo}/${extra}`)).status, 404);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM extras WHERE id = ? AND local_id = ?", [extra, locales[0]]);
  assert.equal(rows.length, 0);
});

test("Sin relación, configuración vacía; no se habilita automáticamente el catálogo", async () => {
  const result = await http("GET", path());
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), []);
});

test("Asociación devuelve duración explícita y recurso; GET la conserva", async () => {
  const expected = { id: extra, nombre: "Corte de uñas", activo: 1, duracion_minutos: 20 };
  assert.deepEqual(await asignar(), expected);
  assert.deepEqual(JSON.parse((await http("GET", path())).body), [expected]);
});

test("Duración es específica por mascota para el mismo extra", async () => {
  const id = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Toby", locales[0]]);
  await asignar(20);
  assert.equal((await http("POST", path(id), { extraId: extra, duracionMinutos: 40 })).status, 201);
  assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 20);
  assert.equal(JSON.parse((await http("GET", path(id))).body)[0].duracion_minutos, 40);
});

test("Asociación rechaza padres ajenos o inexistentes con 404", async () => {
  for (const [m, e] of [[otraMascota, extra], [mascota, otroExtra], [2147483647, extra], [mascota, 2147483647]]) {
    assert.equal((await http("POST", path(m), { extraId: e, duracionMinutos: 20 })).status, 404);
  }
});

test("Duplicado responde 409 y no reemplaza duración", async () => {
  await asignar();
  assert.equal((await http("POST", path(), { extraId: extra, duracionMinutos: 90 })).status, 409);
  assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 20);
});

test("Asociaciones concurrentes producen 201/409 sin duplicar", async () => {
  const results = await Promise.all([
    http("POST", path(), { extraId: extra, duracionMinutos: 20 }),
    http("POST", path(), { extraId: extra, duracionMinutos: 30 }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(JSON.parse((await http("GET", path())).body).length, 1);
});

test("Extra inactivo no permite nuevas asociaciones", async () => {
  assert.equal((await http("POST", path(), { extraId: inactivo, duracionMinutos: 20 })).status, 409);
  assert.deepEqual(JSON.parse((await http("GET", path())).body), []);
});

for (const value of [0, -1, 1.5, "20", true, null, {}, [], 2147483648, undefined]) {
  test(`Duración inválida POST/PATCH: ${JSON.stringify(value)}`, async () => {
    assert.equal((await http("POST", path(), { extraId: extra, duracionMinutos: value })).status, 400);
    await asignar();
    assert.equal((await http("PATCH", `${path()}/${extra}`, { duracionMinutos: value })).status, 400);
    assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 20);
  });
}

test("Límites INT positivo 1 y 2147483647 se aceptan como configuración", async () => {
  await asignar(1);
  const result = await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 2147483647 });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).duracion_minutos, 2147483647);
});

test("Rechaza campos extra/protegidos en asociación y edición", async () => {
  for (const campo of ["local_id", "mascota_id", "extra_id", "activo", "precio", "duracion", "otro"]) {
    assert.equal((await http("POST", path(), { extraId: extra, duracionMinutos: 20, [campo]: 1 })).status, 400);
    assert.equal((await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 20, [campo]: 1 })).status, 400);
  }
  assert.equal((await http("PATCH", `${path()}/${extra}`, { extraId: otroExtra, duracionMinutos: 20 })).status, 400);
});

test("IDs inválidos no se convierten parcialmente", async () => {
  for (const id of ["1abc", "0", "-1", "1.5", "2147483648"]) {
    assert.equal((await http("GET", `${base}/mascotas/${id}/extras`)).status, 400);
    assert.equal((await http("PATCH", `${catalogo}/${id}`, { activo: false })).status, 400);
    assert.equal((await http("DELETE", `${path()}/${id}`)).status, 400);
  }
  for (const extraId of ["1", 0, -1, 1.5, null, true, 2147483648]) {
    assert.equal((await http("POST", path(), { extraId, duracionMinutos: 20 })).status, 400);
  }
});

test("Inactivar extra conserva relación visible y duración editable; PATCH no-op es 200", async () => {
  await asignar();
  assert.equal((await http("PATCH", `${catalogo}/${extra}`, { activo: false })).status, 200);
  assert.equal(JSON.parse((await http("GET", path())).body)[0].activo, 0);
  for (let i = 0; i < 2; i++) {
    const result = await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 30 });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { id: extra, nombre: "Corte de uñas", activo: 0, duracion_minutos: 30 });
  }
});

test("Mascota inactiva permite consultar, asociar, editar y quitar extras", async () => {
  await pool.query("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [mascota, locales[0]]);
  await asignar();
  assert.equal((await http("GET", path())).status, 200);
  assert.equal((await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 30 })).status, 200);
  assert.equal((await http("DELETE", `${path()}/${extra}`)).status, 204);
});

test("Otro tenant no puede leer, editar ni eliminar una asociación existente", async () => {
  await asignar();
  assert.equal((await http("GET", path(), undefined, locales[1])).status, 404);
  assert.equal((await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 30 }, locales[1])).status, 404);
  assert.equal((await http("DELETE", `${path()}/${extra}`, undefined, locales[1])).status, 404);
  assert.equal(JSON.parse((await http("GET", path())).body)[0].duracion_minutos, 20);
});

test("Lectura mascota inexistente y relación ausente en PATCH/DELETE son 404", async () => {
  assert.equal((await http("GET", path(2147483647))).status, 404);
  assert.equal((await http("PATCH", `${path()}/${extra}`, { duracionMinutos: 30 })).status, 404);
  assert.equal((await http("DELETE", `${path()}/${extra}`)).status, 404);
});

test("DELETE relación responde 204 y conserva mascota y extra", async () => {
  await asignar();
  const result = await http("DELETE", `${path()}/${extra}`);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  const config = await http("GET", path());
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body), []);
  const rows = JSON.parse((await http("GET", catalogo)).body) as Extra[];
  assert.ok(rows.some(r => r.id === extra));
});

for (const duration of [0, -1]) {
  test(`MySQL CHECK rechaza duración ${duration}`, async () => {
    await assert.rejects(pool.query("INSERT INTO mascota_extras VALUES (?, ?, ?, ?)", [locales[0], mascota, extra, duration]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });
}

test("MySQL FKs compuestas rechazan cruces tenant, local falsificado y padres inexistentes", async () => {
  for (const values of [[locales[0], mascota, otroExtra], [locales[1], mascota, extra], [locales[0], otraMascota, extra], [locales[0], 2147483647, extra], [locales[0], mascota, 2147483647]]) {
    await assert.rejects(pool.query("INSERT INTO mascota_extras VALUES (?, ?, ?, 20)", values), { code: "ER_NO_REFERENCED_ROW_2" });
  }
});

test("MySQL PK rechaza relación duplicada", async () => {
  await asignar();
  await assert.rejects(pool.query("INSERT INTO mascota_extras VALUES (?, ?, ?, 30)", [locales[0], mascota, extra]), { code: "ER_DUP_ENTRY" });
});

test("MySQL UNIQUE nombre/local rechaza duplicados incluso sin API", async () => {
  await assert.rejects(pool.query("INSERT INTO extras (nombre, local_id) VALUES (?, ?)", ["Corte de uñas", locales[0]]), { code: "ER_DUP_ENTRY" });
});

test("MySQL CASCADE mascota elimina relaciones y conserva extra", async () => {
  const id = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Cascade", locales[0]]);
  await pool.query("INSERT INTO mascota_extras VALUES (?, ?, ?, 20)", [locales[0], id, extra]);
  await pool.query("DELETE FROM mascotas WHERE id = ? AND local_id = ?", [id, locales[0]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_extras WHERE mascota_id = ? AND local_id = ?", [id, locales[0]]);
  assert.equal(rows.length, 0);
  const [extras] = await pool.query<RowDataPacket[]>("SELECT id FROM extras WHERE id = ? AND local_id = ?", [extra, locales[0]]);
  assert.equal(extras.length, 1);
});

test("MySQL CASCADE extra elimina relaciones y conserva mascota", async () => {
  await asignar();
  await pool.query("DELETE FROM extras WHERE id = ? AND local_id = ?", [extra, locales[0]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_extras WHERE mascota_id = ? AND local_id = ?", [mascota, locales[0]]);
  assert.equal(rows.length, 0);
  assert.equal((await http("GET", path())).status, 200);
});

test("MySQL FK catálogo rechaza local inexistente", async () => {
  await assert.rejects(pool.query("INSERT INTO extras (nombre, local_id) VALUES (?, ?)", ["Huérfano", 2147483647]), { code: "ER_NO_REFERENCED_ROW_2" });
});
