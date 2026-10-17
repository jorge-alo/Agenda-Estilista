import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../../config/db";

type SenderArgs = { to: string; body: string; localId: string };
const senderCalls: SenderArgs[] = [];
let senderBehavior: (args: SenderArgs) => Promise<void> = async () => {};
const senderModuleId = require.resolve("../../notifications/infrastructure/whatsapp.provider");
const senderStub = new Module(senderModuleId);
senderStub.filename = senderModuleId;
senderStub.loaded = true;
senderStub.exports = {
  sendWhatsApp: async (to: string, body: string, localId: string) => {
    const args = { to, body, localId };
    senderCalls.push(args);
    return senderBehavior(args);
  },
};
require.cache[senderModuleId] = senderStub;
const { solicitudesPublicRouter } = require("./solicitudes.routes") as typeof import("./solicitudes.routes");
const { default: petRouter } = require("../pet.routes") as typeof import("../pet.routes");

const jwtSecret = "PET10B_SOLO_TESTS";
const prefix = `pet10b-${randomUUID()}`;
const ids: number[] = [];
let port: number;
let server: Server;
const slugs = [0, 1, 2].map(n => `${prefix}-${n}`);

const body = { responsable: { nombre: " Ana ", telefono: " 1123456789 " }, mascota: { nombre: " Rocky " } };
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
  for (const [index, kind, active, telefono] of [[0, "PET_GROOMING", 1, "011 5555-0000"], [1, "PET_GROOMING", 1, "011 5555-1111"], [2, "PET_GROOMING", 1, "011 5555-2222"], [3, "BEAUTY", 1, "011 5555-3333"], [4, "PET_GROOMING", 0, "011 5555-4444"], [5, "PET_GROOMING", 1, null], [6, "PET_GROOMING", 1, "   "], [7, "PET_GROOMING", 1, "sin número"]] as const) {
    const [result]: any = await pool.query("INSERT INTO locales (nombre, slug, business_type, activo, telefono) VALUES (?, ?, ?, ?, ?)",
      [prefix, `${prefix}-${index}`, kind, active, telefono]);
    ids.push(result.insertId);
  }
});
beforeEach(t => {
  if (!("mock" in t)) throw new Error("Mock unavailable");
  t.mock.property(process, "env", { ...process.env, JWT_SECRET: jwtSecret });
  senderCalls.length = 0;
  senderBehavior = async () => {};
});
after(async () => {
  try {
    for (const id of ids) {
      await pool.query("DELETE FROM solicitudes_pet WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    }
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
  assert.equal(senderCalls.length, 1);
  assert.deepEqual({ to: senderCalls[0].to, localId: senderCalls[0].localId }, { to: "5491155550000", localId: String(ids[0]) });
  assert.match(senderCalls[0].body, /Responsable: Ana/);
  assert.match(senderCalls[0].body, /Mascota: Rocky/);
  assert.match(senderCalls[0].body, /Teléfono: 5491123456789/);
  assert.doesNotMatch(senderCalls[0].body, /null|undefined|telefonoSecundario|localId|estado/i);
});

test("público: body completo y fecha calendario estricta", async () => {
  const complete = { responsable: { nombre: "Luz", telefono: "123", telefonoSecundario: "456" }, mascota: { nombre: "Sol", raza: "Caniche", fechaNacimiento: "2020-05-10", tamano: "mediano", sexo: "hembra" }, motivoContacto: " Baño y corte " };
  assert.equal((await call("POST", publico(slugs[1]), complete)).status, 201);
  const [rows]: any = await pool.query("SELECT DATE_FORMAT(mascota_fecha_nacimiento, '%Y-%m-%d') AS fecha, motivo_contacto, responsable_telefono_secundario FROM solicitudes_pet WHERE local_id = ?", [ids[1]]);
  assert.deepEqual([rows[0].fecha, rows[0].motivo_contacto, rows[0].responsable_telefono_secundario], ["2020-05-10", "Baño y corte", "456"]);
  assert.equal(senderCalls.length, 1);
  assert.match(senderCalls[0].body, /Raza: Caniche/);
  assert.match(senderCalls[0].body, /Motivo: Baño y corte/);
  assert.doesNotMatch(senderCalls[0].body, /456/);
});

test("sin raza ni motivo el mensaje omite campos opcionales", async () => {
  assert.deepEqual(await call("POST", publico(slugs[2]), body), { status: 201, data: { ok: true } });
  assert.equal(senderCalls.length, 1);
  assert.doesNotMatch(senderCalls[0].body, /Raza:|Motivo:|null|undefined/);
  assert.equal(senderCalls[0].body, [
    "Nueva solicitud de peluquería canina", "", "Responsable: Ana", "Mascota: Rocky", "Teléfono: 5491123456789",
  ].join("\n"));
});

test("sender se inicia después del INSERT; fallo no retrasa ni cambia el 201", async t => {
  let signalStarted!: () => void;
  let rejectSender!: (error: Error) => void;
  let signalCaught!: (args: unknown[]) => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const caught = new Promise<unknown[]>(resolve => { signalCaught = resolve; });
  const pending = new Promise<void>((_resolve, reject) => { rejectSender = reject; });
  senderBehavior = async () => { signalStarted(); return pending; };
  t.mock.method(console, "error", (...args: unknown[]) => { signalCaught(args); });

  const response = await call("POST", publico(), body);
  assert.deepEqual(response, { status: 201, data: { ok: true } });
  await started;
  const [rows]: any = await pool.query("SELECT id, estado FROM solicitudes_pet WHERE local_id = ? AND responsable_nombre = 'Ana' ORDER BY id DESC LIMIT 1", [ids[0]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estado, "NUEVA");
  rejectSender(new Error("Evolution fallo con contenido privado simulado"));
  assert.deepEqual(await caught, ["No se pudo enviar notificación de nueva solicitud PET", { solicitudId: rows[0].id }]);
});

test("local sin teléfono NULL, vacío o sin dígitos conserva solicitud y no llama al sender", async t => {
  let warning: unknown[] | null = null;
  t.mock.method(console, "warn", (...args: unknown[]) => { warning = args; });
  for (const index of [5, 6, 7]) {
    assert.deepEqual(await call("POST", publico(`${prefix}-${index}`), body), { status: 201, data: { ok: true } });
    const [rows]: any = await pool.query("SELECT id, estado FROM solicitudes_pet WHERE local_id = ?", [ids[index]]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estado, "NUEVA");
    assert.deepEqual(warning, ["Notificación PET omitida: el local no tiene teléfono válido", { solicitudId: rows[0].id }]);
  }
  assert.equal(senderCalls.length, 0);
});

test("fallo del INSERT no dispara notificación", async t => {
  const original = pool.query.bind(pool);
  const [before]: any = await original("SELECT COUNT(*) AS total FROM solicitudes_pet WHERE local_id = ? AND responsable_nombre = 'Ana'", [ids[0]]);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
    if (String(args[0]).includes("INSERT INTO solicitudes_pet")) return Promise.reject(new Error("fallo INSERT de prueba"));
    return original(...args);
  }) as typeof pool.query);
  assert.equal((await call("POST", publico(), body)).status, 500);
  assert.equal(senderCalls.length, 0);
  const [rows]: any = await original("SELECT id FROM solicitudes_pet WHERE local_id = ? AND responsable_nombre = 'Ana'", [ids[0]]);
  assert.equal(rows.length, before[0].total);
});

test("público: slug inexistente, BEAUTY e inactivo tienen la misma respuesta", async () => {
  const results = await Promise.all([`${prefix}-missing`, `${prefix}-3`, `${prefix}-4`].map(slug => call("POST", publico(slug), body)));
  assert.ok(results.every(r => r.status === 404));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.deepEqual(await call("POST", publico(`${prefix}-3`), {}), results[1]);
  assert.equal(senderCalls.length, 0);
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
  assert.equal(senderCalls.length, 0);
});

test("público: limiter por IP + slug (10 en 15 minutos)", async () => {
  const slug = `${prefix}-8`;
  const [r]: any = await pool.query("INSERT INTO locales (nombre, slug, business_type, telefono) VALUES (?, ?, 'PET_GROOMING', ?)", [prefix, slug, "011 5555-8888"]);
  ids.push(r.insertId);
  for (let n = 0; n < 10; n++) assert.equal((await call("POST", publico(slug), body)).status, 201);
  assert.equal((await call("POST", publico(slug), body)).status, 429);
  assert.equal((await call("POST", publico(`${prefix}-9`), body)).status, 404);
  assert.equal(senderCalls.length, 10);
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
  assert.deepEqual(rows.find(row => row.estado === "NUEVA").responsable, { nombre: "Ana", telefono: "1123456789", telefonoSecundario: null });
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
    const [r]: any = await pool.query("INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, mascota_nombre) VALUES (?, ?, ?, ?)", [ids[0], prefix, "1123456789", "test"]);
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
  assert.equal((await call("POST", `${admin}/${c}/convertir`, {}, token())).status, 201);
  assert.equal((await patch(c, "DESCARTADA")).status, 409);
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
