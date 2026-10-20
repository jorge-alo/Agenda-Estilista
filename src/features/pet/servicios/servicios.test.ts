import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { before, beforeEach, after, afterEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import router from "../pet.routes";
import { ServiciosRouter } from "../../servicios/servicio.routes";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";
import * as catalogoService from "./servicios.service";
import { validarCrearServicio, validarEditarServicio, type ServicioCatalogo } from "./servicios.types";

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
const catalogo = `${base}/servicios`;
const creados: Array<{ id: number; localId: number }> = [];

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
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY", "PET_GROOMING"]) {
    locales.push(await insert("INSERT INTO locales (nombre, business_type) VALUES (?, ?)", ["Fixture PET03", business]));
  }
  mascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Rocky", locales[0]]);
  otraMascota = await insert("INSERT INTO mascotas (nombre, local_id) VALUES (?, ?)", ["Lola", locales[1]]);
  servicio = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Baño", 25, locales[0]]);
  otroServicio = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Otro", 30, locales[1]]);
  inactivo = await insert("INSERT INTO servicios (nombre, duracion, local_id, activo) VALUES (?, ?, ?, 0)", ["Inactivo", 35, locales[0]]);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(base, router);
  app.use("/api/servicios", ServiciosRouter);
  app.use(sanitizedErrorMiddleware);
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
  await pool.query("UPDATE servicios SET nombre = 'Baño', activo = 1, duracion = 25, precio = NULL WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  await pool.query("UPDATE mascotas SET activo = 1 WHERE id = ? AND local_id = ?", [mascota, locales[0]]);
});

afterEach(async () => {
  for (const { id, localId } of creados) {
    await pool.query("DELETE FROM servicios WHERE id = ? AND local_id = ?", [id, localId]);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM servicios WHERE id = ? AND local_id = ?", [id, localId]);
    assert.equal(rows.length, 0, "Fixture catálogo M.3B.3 limpiada por ID y tenant exactos");
  }
  creados.length = 0;
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

for (const [label, tenant, rol, status] of [
  ["sin auth", -1, "admin", 401], ["BEAUTY", 2, "admin", 403],
  ["PET no-admin", 0, "estilista", 403], ["PET superadmin", 0, "superadmin", 403],
] as const) {
  test(`M.3B.1 ${label}: protege las cinco rutas de servicios sin modificar configuración`, async () => {
    await asignar();
    const snapshot = async () => {
      const [catalogo] = await pool.query<RowDataPacket[]>("SELECT * FROM servicios WHERE local_id = ? ORDER BY id", [locales[0]]);
      const [relaciones] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE local_id = ? ORDER BY mascota_id, servicio_id", [locales[0]]);
      return { catalogo, relaciones };
    };
    const previo = await snapshot();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `${base}/servicios`], ["GET", path()],
      ["POST", path(), { servicioId: inactivo, duracionMinutos: 60 }],
      ["PATCH", `${path()}/${servicio}`, { duracionMinutos: 90 }],
      ["DELETE", `${path()}/${servicio}`],
    ];
    for (const [method, url, body] of routes) {
      assert.equal((await http(method, url, body, tenant < 0 ? null : locales[tenant], rol)).status, status);
      assert.deepEqual(await snapshot(), previo);
    }
  });
}

test("Catálogo tenant incluye activos/inactivos e ignora local_id de query", async () => {
  const result = await http("GET", `${base}/servicios?local_id=${locales[1]}`);
  assert.equal(result.status, 200);
  const rows = JSON.parse(result.body) as ServicioCatalogo[];
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["activo", "id", "nombre"]);
  assert.deepEqual(rows.map(r => r.id).sort((a, b) => a - b), [servicio, inactivo]);
  assert.equal(rows.find(r => r.id === inactivo)?.activo, 0);
  assert.deepEqual(rows.map(r => r.id), [servicio, inactivo]);
});

test("M.3B.3 catálogo no incorpora hard delete PET", async () => {
  assert.equal((await http("DELETE", `${catalogo}/${servicio}`)).status, 404);
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

test("M.3B.1 legacy rechaza hard delete PET; SQL CASCADE conserva integridad", async () => {
  const id = await insert("INSERT INTO servicios (nombre, duracion, local_id) VALUES (?, ?, ?)", ["Cascade", 25, locales[0]]);
  await pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 60)", [locales[0], mascota, id]);
  assert.equal((await http("DELETE", `/api/servicios/${id}`)).status, 403);
  const [conservadas] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE servicio_id = ? AND local_id = ?", [id, locales[0]]);
  assert.equal(conservadas.length, 1);
  await pool.query("DELETE FROM servicios WHERE id = ? AND local_id = ?", [id, locales[0]]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE servicio_id = ? AND local_id = ?", [id, locales[0]]);
  assert.equal(rows.length, 0);
});

async function crearCatalogo(nombre: string, localId = locales[0]): Promise<ServicioCatalogo> {
  const result = await http("POST", catalogo, { nombre }, localId);
  assert.equal(result.status, 201, result.body);
  const dto = JSON.parse(result.body) as ServicioCatalogo;
  creados.push({ id: dto.id, localId });
  assert.deepEqual(Object.keys(dto).sort(), ["activo", "id", "nombre"]);
  return dto;
}

async function leerServicio(id = servicio, localId = locales[0]) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, nombre, activo, duracion, precio, local_id, created_at FROM servicios WHERE id = ? AND local_id = ?", [id, localId]
  );
  assert.equal(rows.length, 1);
  return { ...rows[0] };
}

function error400(result: { status: number; body: string }, mensaje?: string) {
  assert.equal(result.status, 400, result.body);
  const body = JSON.parse(result.body) as { error: string };
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  if (mensaje) assert.equal(body.error, mensaje);
}

test("M.3B.3 GET sin filas devuelve [] y no usa tenant de query", async () => {
  const result = await http("GET", `${catalogo}?local_id=${locales[0]}&localId=${locales[0]}`, undefined, locales[3]);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), []);
});

test("M.3B.3 GET ordena nombre ASC e id ASC, incluidos homónimos", async () => {
  const z = await crearCatalogo("ZZZ");
  const a = await crearCatalogo("AAA");
  const a2 = await crearCatalogo("AAA");
  const result = await http("GET", catalogo);
  assert.equal(result.status, 200);
  const rows = JSON.parse(result.body) as ServicioCatalogo[];
  assert.deepEqual(rows.map(row => row.id), [a.id, a2.id, servicio, inactivo, z.id]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["activo", "id", "nombre"]);
});

test("M.3B.3 activo NULL legacy se proyecta 0 sin normalizar al leer ni editar nombre", async () => {
  await pool.query("UPDATE servicios SET activo = NULL WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
  const rows = JSON.parse((await http("GET", catalogo)).body) as ServicioCatalogo[];
  assert.equal(rows.find(row => row.id === servicio)?.activo, 0);
  assert.equal((await leerServicio()).activo, null);
  const result = await http("PATCH", `${catalogo}/${servicio}`, { nombre: "Legacy NULL" });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { id: servicio, nombre: "Legacy NULL", activo: 0 });
  assert.equal((await leerServicio()).activo, null);
});

for (const nombre of ["Baño y corte", "  Con trim  ", "A", "A".repeat(100), "🐾".repeat(100)]) {
  test(`M.3B.3 POST válido (${[...nombre].length} caracteres) persiste NULLs, activo y tenant JWT`, async () => {
    const dto = await crearCatalogo(nombre);
    assert.deepEqual(dto, { id: dto.id, nombre: nombre.trim(), activo: 1 });
    const row = await leerServicio(dto.id);
    assert.equal(row.nombre, nombre.trim());
    assert.equal(row.duracion, null);
    assert.equal(row.precio, null);
    assert.equal(row.local_id, locales[0]);
    assert.equal(row.activo, 1);
    const [relations] = await pool.query<RowDataPacket[]>("SELECT * FROM mascota_servicios WHERE servicio_id = ? AND local_id = ?", [dto.id, locales[0]]);
    assert.deepEqual(relations, []);
  });
}

test("M.3B.3 POST nombres duplicados mismo tenant: dos 201 con IDs distintos", async () => {
  const first = await crearCatalogo("Duplicado permitido");
  const second = await crearCatalogo("Duplicado permitido");
  assert.notEqual(first.id, second.id);
  assert.equal((await leerServicio(first.id)).nombre, (await leerServicio(second.id)).nombre);
});

test("M.3B.3 POST toma JWT aunque query indique otro tenant", async () => {
  const result = await http("POST", `${catalogo}?local_id=${locales[0]}`, { nombre: "Tenant JWT" }, locales[1]);
  assert.equal(result.status, 201);
  const dto = JSON.parse(result.body) as ServicioCatalogo;
  creados.push({ id: dto.id, localId: locales[1] });
  assert.equal((await leerServicio(dto.id, locales[1])).local_id, locales[1]);
  assert.equal((JSON.parse((await http("GET", catalogo)).body) as ServicioCatalogo[]).some(row => row.id === dto.id), false);
});

for (const nombre of [undefined, "", "   ", "A".repeat(101), "🐾".repeat(101), 123, null, false, {}, []]) {
  test(`M.3B.3 nombre inválido POST/PATCH: ${JSON.stringify(nombre)}`, async () => {
    const before = await leerServicio();
    error400(await http("POST", catalogo, { nombre }));
    error400(await http("PATCH", `${catalogo}/${servicio}`, { nombre }));
    assert.deepEqual(await leerServicio(), before);
  });
}

for (const body of [[], ["nombre"], null, "texto", 1, true]) {
  test(`M.3B.3 validadores rechazan body no objeto: ${JSON.stringify(body)}`, () => {
    for (const validar of [validarCrearServicio, validarEditarServicio]) {
      assert.throws(() => validar(body), { status: 400, message: "Payload inválido" });
    }
  });
}

test("M.3B.3 HTTP rechaza body array y body ausente con {error}", async () => {
  for (const body of [[], undefined]) {
    error400(await http("POST", catalogo, body));
    error400(await http("PATCH", `${catalogo}/${servicio}`, body));
  }
});

for (const body of [null, "texto", 123, true]) {
  test(`M.3B.3 HTTP primitivo ${JSON.stringify(body)}: excepción aprobada 400 INVALID_JSON sin escrituras`, async t => {
    t.mock.method(console, "error", () => undefined);
    const snapshot = async () => (await pool.query<RowDataPacket[]>(
      "SELECT * FROM servicios WHERE local_id IN (?, ?, ?, ?) ORDER BY id", locales
    ))[0];
    const before = await snapshot();
    for (const [method, url] of [["POST", catalogo], ["PATCH", `${catalogo}/${servicio}`]]) {
      const result = await http(method, url, body);
      assert.equal(result.status, 400, result.body);
      assert.deepEqual(JSON.parse(result.body), { code: "INVALID_JSON" });
      assert.deepEqual(await snapshot(), before);
    }
  });
}

for (const campo of ["duracion", "precio", "local_id", "localId", "business_type", "id", "created_at", "extra"]) {
  test(`M.3B.3 POST/PATCH rechazan campo ${campo} sin escritura`, async () => {
    const before = await leerServicio();
    error400(await http("POST", catalogo, { nombre: "No persistir", [campo]: 1 }), "Campos no permitidos");
    error400(await http("PATCH", `${catalogo}/${servicio}`, { nombre: "No editar", [campo]: 1 }), "Campos no permitidos");
    assert.deepEqual(await leerServicio(), before);
  });
}

test("M.3B.3 POST rechaza activo incluso boolean", async () => {
  for (const activo of [true, false, 1]) error400(await http("POST", catalogo, { nombre: "No crear", activo }), "Campos no permitidos");
});

for (const [label, tenant, rol, status] of [
  ["sin auth", -1, "admin", 401], ["BEAUTY", 2, "admin", 403],
  ["PET no-admin", 0, "estilista", 403], ["PET superadmin", 0, "superadmin", 403],
] as const) {
  test(`M.3B.3 ${label}: GET/POST/PATCH protegidos sin escrituras`, async () => {
    const snapshot = async () => (await pool.query<RowDataPacket[]>("SELECT * FROM servicios WHERE local_id IN (?, ?, ?, ?) ORDER BY id", locales))[0];
    const before = await snapshot();
    for (const [method, url, body] of [
      ["GET", catalogo, undefined], ["POST", catalogo, { nombre: "Denegado" }],
      ["PATCH", `${catalogo}/${servicio}`, { nombre: "Denegado", activo: false }],
    ] as const) {
      const result = await http(method, url, body, tenant < 0 ? null : locales[tenant], rol);
      assert.equal(result.status, status, result.body);
      assert.deepEqual(Object.keys(JSON.parse(result.body)), ["error"]);
      assert.deepEqual(await snapshot(), before);
    }
  });
}

for (const payload of [
  { nombre: "  Nuevo nombre  " }, { activo: false }, { nombre: "Ambos", activo: false },
  { nombre: "Baño" }, { activo: true }, { nombre: "N" }, { nombre: "N".repeat(100) },
]) {
  test(`M.3B.3 PATCH parcial/no-op preserva legacy: ${JSON.stringify(payload)}`, async () => {
    await pool.query("UPDATE servicios SET duracion = 77, precio = 123.45 WHERE id = ? AND local_id = ?", [servicio, locales[0]]);
    const before = await leerServicio();
    const result = await http("PATCH", `${catalogo}/${servicio}`, payload);
    assert.equal(result.status, 200, result.body);
    const nombre = payload.nombre?.trim() ?? before.nombre;
    const activo = payload.activo === undefined ? before.activo : Number(payload.activo);
    assert.deepEqual(JSON.parse(result.body), { id: servicio, nombre, activo });
    assert.deepEqual(await leerServicio(), { ...before, nombre, activo });
  });
}

test("M.3B.3 PATCH reactiva y no-op de inactivo; nombre omitido se preserva", async () => {
  const before = await leerServicio(inactivo);
  for (const activo of [false, true, true, false]) {
    const result = await http("PATCH", `${catalogo}/${inactivo}`, { activo });
    assert.equal(result.status, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { id: inactivo, nombre: before.nombre, activo: Number(activo) });
    assert.deepEqual(await leerServicio(inactivo), { ...before, activo: Number(activo) });
  }
});

test("M.3B.3 PATCH permite nombre duplicado y conserva NULLs de nuevas altas", async () => {
  const dto = await crearCatalogo("Nuevo");
  const result = await http("PATCH", `${catalogo}/${dto.id}`, { nombre: "Baño", activo: false });
  assert.equal(result.status, 200, result.body);
  const row = await leerServicio(dto.id);
  assert.equal(row.duracion, null);
  assert.equal(row.precio, null);
  assert.equal(row.local_id, locales[0]);
});

for (const activo of [0, 1, "true", "false", null, [], {}]) {
  test(`M.3B.3 PATCH activo inválido: ${JSON.stringify(activo)}`, async () => {
    const before = await leerServicio();
    error400(await http("PATCH", `${catalogo}/${servicio}`, { activo }), "activo debe ser boolean");
    assert.deepEqual(await leerServicio(), before);
  });
}

test("M.3B.3 PATCH vacío es 400", async () => {
  error400(await http("PATCH", `${catalogo}/${servicio}`, {}), "No hay campos para actualizar");
});

for (const id of ["0", "-1", "1.5", "1abc", "1e2", "2147483648", "9007199254740993"]) {
  test(`M.3B.3 PATCH ID estricto: ${id}`, async () => {
    error400(await http("PATCH", `${catalogo}/${id}`, { activo: false }), "ID inválido");
  });
}

test("M.3B.3 PATCH ajeno/inexistente indistinguibles: 404 Servicio no encontrado", async () => {
  const before = await leerServicio(otroServicio, locales[1]);
  for (const id of [otroServicio, 2147483647]) {
    const result = await http("PATCH", `${catalogo}/${id}`, { nombre: "No editar", activo: false });
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.body), { error: "Servicio no encontrado" });
  }
  assert.deepEqual(await leerServicio(otroServicio, locales[1]), before);
});

test("M.3B.3 errores inesperados GET/POST/PATCH conservan 500 genérico {error}", async t => {
  const failure = () => { throw new Error("Detalle interno que no debe salir"); };
  t.mock.method(catalogoService, "listarCatalogo", failure);
  t.mock.method(catalogoService, "crearServicio", failure);
  t.mock.method(catalogoService, "editarServicio", failure);
  for (const [method, url, body] of [
    ["GET", catalogo, undefined], ["POST", catalogo, { nombre: "Error" }],
    ["PATCH", `${catalogo}/${servicio}`, { activo: false }],
  ] as const) {
    const result = await http(method, url, body);
    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(result.body), { error: "Error gestionando servicios de mascota" });
  }
});

test("M.3B.3 catálogo NULL usa relación explícita; inactivar/reactivar conserva configuración", async () => {
  const dto = await crearCatalogo("Servicio sin duración genérica");
  const url = `${path()}/${dto.id}`;
  error400(await http("POST", path(), { servicioId: dto.id }));
  assert.equal((await http("POST", path(), { servicioId: dto.id, duracionMinutos: 45 })).status, 201);
  assert.equal((await http("PATCH", `${catalogo}/${dto.id}`, { activo: false })).status, 200);
  assert.deepEqual(JSON.parse((await http("GET", path())).body), [{ id: dto.id, nombre: dto.nombre, activo: 0, duracion_minutos: 45 }]);
  assert.equal((await http("POST", `${base}/mascotas/${otraMascota}/servicios`, { servicioId: dto.id, duracionMinutos: 50 })).status, 404);
  assert.equal((await http("POST", path(), { servicioId: dto.id, duracionMinutos: 50 })).status, 409);
  assert.equal((await http("PATCH", url, { duracionMinutos: 50 })).status, 200);
  assert.equal((await http("PATCH", `${catalogo}/${dto.id}`, { activo: true })).status, 200);
  assert.deepEqual(JSON.parse((await http("GET", path())).body), [{ id: dto.id, nombre: dto.nombre, activo: 1, duracion_minutos: 50 }]);
  assert.equal((await leerServicio(dto.id)).duracion, null);
  assert.equal((await http("DELETE", url)).status, 204);
  assert.deepEqual(JSON.parse((await http("GET", path())).body), []);
});

test("M.3B.3 dos PATCH parciales serializan lectura/escritura con lock InnoDB sin estado stale", { timeout: 20000 }, async t => {
  function barrier<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  const locked = barrier<void>();
  const release = barrier<void>();
  const secondAttempt = barrier<number>();
  let firstSeen = false;
  let secondAcquired = false;
  let polling = true;
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGetConnection();
    const originalQuery = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const sql: unknown = args[0];
      if (typeof sql === "string" && sql.includes("SELECT id, nombre, activo FROM servicios WHERE id = ? AND local_id = ? FOR UPDATE")) {
        const result = originalQuery(...args);
        if (!firstSeen) {
          firstSeen = true;
          return result.then(async rows => { locked.resolve(); await release.promise; return rows; });
        }
        secondAttempt.resolve(conn.threadId);
        return result.then(rows => { secondAcquired = true; return rows; });
      }
      return originalQuery(...args);
    }) as typeof conn.query);
    return conn;
  });
  const first = http("PATCH", `${catalogo}/${servicio}`, { nombre: "Nombre concurrente" });
  let second: ReturnType<typeof http> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("PATCH no alcanzó las barreras del lock de fila")), 15000);
  });
  try {
    await Promise.race([locked.promise, watchdog]);
    second = http("PATCH", `${catalogo}/${servicio}`, { activo: false });
    const threadId = await Promise.race([secondAttempt.promise, watchdog]);
    await Promise.race([(async () => {
      while (polling) {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
           JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
           WHERE t.PROCESSLIST_ID = ?`, [threadId]
        );
        if (rows[0].total > 0) return;
        await new Promise<void>(done => setImmediate(done));
      }
    })(), watchdog]);
    assert.equal(secondAcquired, false, "La segunda lectura debe esperar el commit de la primera");
  } finally {
    polling = false;
    release.resolve();
    if (timer) clearTimeout(timer);
    await Promise.all([first, second]);
  }
  assert.equal((await first).status, 200);
  assert.ok(second);
  const result = await second;
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(JSON.parse(result.body), { id: servicio, nombre: "Nombre concurrente", activo: 0 });
  const row = await leerServicio();
  assert.equal(row.nombre, "Nombre concurrente");
  assert.equal(row.activo, 0);
  assert.equal(row.duracion, 25);
  assert.equal(row.precio, null);
  assert.equal(row.local_id, locales[0]);
});
