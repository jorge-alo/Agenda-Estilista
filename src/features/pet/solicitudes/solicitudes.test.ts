import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../../config/db";
import { solicitudesPublicRouter } from "./solicitudes.routes";
import petRouter from "../pet.routes";

const jwtSecret = "PET10B_SOLO_TESTS";
const prefix = `pet10b-${randomUUID()}`;
const ids: number[] = [];
let port: number;
let server: Server;
const slugs = [0, 1, 2].map(n => `${prefix}-${n}`);

const body = { responsable: { nombre: " Ana ", telefono: " 123456 " }, mascota: { nombre: " Rocky " } };
function token(localId = ids[0], rol = "admin") {
  return jwt.sign({ userId: 1, localId, rol }, jwtSecret);
}
async function call(method: string, path: string, payload?: unknown, auth?: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const publico = (slug = slugs[0]) => `/api/pet/public/${slug}/solicitudes`;
const admin = "/api/pet/admin/solicitudes";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pet/public", solicitudesPublicRouter);
  app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  port = addr.port;
  for (const [index, kind, active] of [[0, "PET_GROOMING", 1], [1, "PET_GROOMING", 1], [2, "PET_GROOMING", 1], [3, "BEAUTY", 1], [4, "PET_GROOMING", 0]] as const) {
    const [result]: any = await pool.query("INSERT INTO locales (nombre, slug, business_type, activo) VALUES (?, ?, ?, ?)",
      [prefix, `${prefix}-${index}`, kind, active]);
    ids.push(result.insertId);
  }
});
beforeEach(t => {
  if (!("mock" in t)) throw new Error("Mock unavailable");
  t.mock.property(process, "env", { ...process.env, JWT_SECRET: jwtSecret });
});
after(async () => {
  try {
    for (const id of ids) await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    const [rows]: any = await pool.query("SELECT COUNT(*) AS total FROM locales WHERE nombre = ? AND slug LIKE ?", [prefix, `${prefix}%`]);
    assert.equal(rows[0].total, 0, "sin locales fixture PET-10B");
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});

test("público: slug PET activo, body mínimo, snapshot y ninguna entidad real", async () => {
  const [antes]: any = await pool.query("SELECT (SELECT COUNT(*) FROM clientes WHERE local_id = ?) AS clientes, (SELECT COUNT(*) FROM mascotas WHERE local_id = ?) AS mascotas, (SELECT COUNT(*) FROM mascota_clientes WHERE local_id = ?) AS vinculos", [ids[0], ids[0], ids[0]]);
  const result = await call("POST", publico(), body);
  assert.deepEqual(result, { status: 201, data: { ok: true } });
  const [despues]: any = await pool.query("SELECT (SELECT COUNT(*) FROM clientes WHERE local_id = ?) AS clientes, (SELECT COUNT(*) FROM mascotas WHERE local_id = ?) AS mascotas, (SELECT COUNT(*) FROM mascota_clientes WHERE local_id = ?) AS vinculos", [ids[0], ids[0], ids[0]]);
  assert.deepEqual(despues, antes);
  const [rows]: any = await pool.query("SELECT * FROM solicitudes_pet WHERE local_id = ?", [ids[0]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estado, "NUEVA");
  assert.equal(rows[0].responsable_nombre, "Ana");
});

test("público: body completo y fecha calendario estricta", async () => {
  const complete = { responsable: { nombre: "Luz", telefono: "123", telefonoSecundario: "456" }, mascota: { nombre: "Sol", raza: "Caniche", fechaNacimiento: "2020-05-10", tamano: "mediano", sexo: "hembra" }, motivoContacto: " Baño y corte " };
  assert.equal((await call("POST", publico(slugs[1]), complete)).status, 201);
  const [rows]: any = await pool.query("SELECT DATE_FORMAT(mascota_fecha_nacimiento, '%Y-%m-%d') AS fecha, motivo_contacto, responsable_telefono_secundario FROM solicitudes_pet WHERE local_id = ?", [ids[1]]);
  assert.deepEqual([rows[0].fecha, rows[0].motivo_contacto, rows[0].responsable_telefono_secundario], ["2020-05-10", "Baño y corte", "456"]);
});

test("público: slug inexistente, BEAUTY e inactivo tienen la misma respuesta", async () => {
  const results = await Promise.all([`${prefix}-missing`, `${prefix}-3`, `${prefix}-4`].map(slug => call("POST", publico(slug), body)));
  assert.ok(results.every(r => r.status === 404));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.deepEqual(await call("POST", publico(`${prefix}-3`), {}), results[1]);
});

test("público: valida campos obligatorios, longitud, fecha, tamaño/sexo y rechaza extras", async () => {
  const invalid = [
    { ...body, responsable: { telefono: "1" } },
    { ...body, responsable: { nombre: "a", telefono: "" } },
    { ...body, responsable: { nombre: "a", telefono: "1", telefonoSecundario: "  " } },
    { ...body, responsable: { nombre: "a" } },
    { ...body, mascota: {} },
    { ...body, mascota: { nombre: "a", fechaNacimiento: "2024-02-30" } },
    { ...body, mascota: { nombre: "a", tamano: "x".repeat(21) } },
    { ...body, mascota: { nombre: "a", sexo: "x".repeat(21) } },
    { ...body, motivoContacto: "x".repeat(501) },
    { ...body, localId: ids[1] },
    { ...body, responsable: { ...body.responsable, clienteId: 123 } },
    { ...body, mascota: { ...body.mascota, servicioId: 1 } },
    { ...body, estado: "CONVERTIDA" },
  ];
  for (const [index, payload] of invalid.entries()) {
    const result = await call("POST", publico(slugs[index % 2]), payload);
    assert.equal(result.status, 400, `caso ${index}: ${JSON.stringify(result)}`);
  }
});

test("público: limiter por IP + slug (10 en 15 minutos)", async () => {
  const slug = `${prefix}-5`;
  const [r]: any = await pool.query("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')", [prefix, slug]);
  ids.push(r.insertId);
  for (let n = 0; n < 10; n++) assert.equal((await call("POST", publico(slug), body)).status, 201);
  assert.equal((await call("POST", publico(slug), body)).status, 429);
  assert.equal((await call("POST", publico(`${prefix}-6`), body)).status, 404);
});

test("DB: estado default, CHECK, FK e índice no permiten valores inválidos", async () => {
  const [rows]: any = await pool.query("SELECT estado FROM solicitudes_pet WHERE local_id = ? LIMIT 1", [ids[0]]);
  assert.equal(rows[0].estado, "NUEVA");
  await assert.rejects(pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre, estado) VALUES (?, ?, ?, ?, ?)", [ids[0], prefix, "1", "test", "INVALIDA"]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre) VALUES (?, ?, ?, ?)", [2147483647, prefix, "1", "test"]), { code: "ER_NO_REFERENCED_ROW_2" });
});

test("admin: auth, rol y vertical", async () => {
  assert.equal((await call("GET", admin)).status, 401);
  assert.equal((await call("GET", admin, undefined, token(ids[0], "empleado"))).status, 403);
  assert.equal((await call("PATCH", `${admin}/1/estado`, { estado: "CONTACTADA" }, token(ids[0], "empleado"))).status, 403);
  assert.equal((await call("GET", admin, undefined, token(ids[3]))).status, 403);
});

test("admin: filtro estricto, snapshot, orden, estados y tenant", async () => {
  const auth = token();
  const [r]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre, estado, created_at) VALUES (?, ?, ?, ?, ?, ?)", [ids[0], prefix, "1", "test", "CONTACTADA", "2020-01-01 00:00:00"]);
  const [r2]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre, estado, created_at) VALUES (?, ?, ?, ?, ?, ?)", [ids[0], prefix, "1", "test", "DESCARTADA", "2020-01-01 00:00:00"]);
  const all = await call("GET", admin, undefined, auth);
  assert.equal(all.status, 200);
  const rows = all.data as any[];
  assert.ok(rows.find(row => row.id === r2.insertId));
  assert.ok(rows.find(row => row.id === r.insertId));
  assert.ok(rows.findIndex(row => row.id === r2.insertId) < rows.findIndex(row => row.id === r.insertId));
  assert.ok(rows.every(row => !("localId" in row)));
  assert.deepEqual(rows.find(row => row.estado === "NUEVA").responsable, { nombre: "Ana", telefono: "123456", telefonoSecundario: null });
  assert.deepEqual(rows.find(row => row.estado === "NUEVA").mascota, { nombre: "Rocky", raza: null, fechaNacimiento: null, tamano: null, sexo: null });
  for (const estado of ["NUEVA", "CONTACTADA", "CONVERTIDA", "DESCARTADA"]) {
    const filtered = await call("GET", `${admin}?estado=${estado}`, undefined, auth);
    assert.equal(filtered.status, 200);
    assert.ok((filtered.data as any[]).every(row => row.estado === estado));
  }
  for (const query of ["?estado=INVALIDA", "?extra=1", "?estado=NUEVA&estado=CONTACTADA"]) {
    assert.equal((await call("GET", `${admin}${query}`, undefined, auth)).status, 400);
  }
  const other = await call("GET", admin, undefined, token(ids[1]));
  assert.ok((other.data as any[]).every(row => row.responsable.nombre !== prefix));
});

test("admin: transiciones permitidas y terminales", async () => {
  const create = async () => {
    const [r]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre) VALUES (?, ?, ?, ?)", [ids[0], prefix, "1", "test"]);
    return r.insertId as number;
  };
  const patch = (id: number, estado: string, localId = ids[0]) => call("PATCH", `${admin}/${id}/estado`, { estado }, token(localId));
  const a = await create();
  assert.equal((await patch(a, "CONTACTADA")).status, 200);
  assert.equal((await patch(a, "NUEVA")).status, 409);
  assert.equal((await patch(a, "DESCARTADA")).status, 200);
  assert.equal((await patch(a, "CONTACTADA")).status, 409);
  const b = await create();
  assert.equal((await patch(b, "DESCARTADA")).status, 200);
  const c = await create();
  assert.equal((await patch(c, "CONVERTIDA")).status, 409);
  assert.equal((await patch(c, "INVALIDA")).status, 400);
  assert.equal((await call("PATCH", `${admin}/${c}/estado`, { estado: "CONTACTADA", extra: 1 }, token())).status, 400);
  assert.equal((await patch(c, "CONTACTADA", ids[1])).status, 404);
  assert.equal((await patch(2147483647, "CONTACTADA")).status, 404);
  const [r]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre, estado) VALUES (?, ?, ?, ?, 'CONVERTIDA')", [ids[0], prefix, "1", "test"]);
  assert.equal((await patch(r.insertId, "DESCARTADA")).status, 409);
});

test("admin: PATCH concurrentes con lectura inicial idéntica no pisan transición", async t => {
  const [r]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre) VALUES (?, ?, ?, ?)", [ids[0], prefix, "1", "test"]);
  const original = pool.query.bind(pool);
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(pool, "query", async (...args: Parameters<typeof pool.query>) => {
    const result = await original(...args);
    if (String(args[0]) === "SELECT estado FROM solicitudes_pet WHERE id = ? AND local_id = ?") {
      reads++;
      if (reads === 2) release();
      await barrier;
    }
    return result;
  });
  const responses = await Promise.all(["CONTACTADA", "DESCARTADA"].map(estado => call("PATCH", `${admin}/${r.insertId}/estado`, { estado }, token())));
  const [rows]: any = await original("SELECT estado FROM solicitudes_pet WHERE id = ? AND local_id = ?", [r.insertId, ids[0]]);
  assert.equal(reads, 2);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
  assert.equal(rows[0].estado, responses[0].status === 200 ? "CONTACTADA" : "DESCARTADA");
});
