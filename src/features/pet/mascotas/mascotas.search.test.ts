import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader } from "mysql2";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import petRouter from "../pet.routes";
import { buscarMascotas } from "./mascotas.service";
import type { MascotaSearchResult } from "./mascotas.types";

const secret = "PET09R_SEARCH_FICTITIOUS_TEST_SECRET";
const locales: number[] = [];
let server: Server | undefined;
let port: number;
let localId: number;
let foreignLocalId: number;
let beautyLocalId: number;
let firulaisId: number;
let duplicateId: number;
let noResponsibleId: number;
let legacyId: number;
let anaId: number;
let juanId: number;
const initialIds: number[] = [];

function token(tenant = localId, rol = "admin") {
  return jwt.sign({ userId: 1, localId: tenant, rol }, secret, { expiresIn: "1m" });
}

async function http(path = "", bearer: string | null = token()) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: `/api/pet/admin/mascotas/search${path}`,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function search(q: string, extra: Record<string, string> = {}) {
  const result = await http(`?${new URLSearchParams({ q, ...extra })}`);
  assert.equal(result.status, 200, result.body);
  return JSON.parse(result.body) as MascotaSearchResult[];
}

async function createLocal(businessType: string) {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO locales (nombre, business_type) VALUES (?, ?)", ["PET09R search fixture", businessType],
  );
  locales.push(result.insertId); // Register immediately so partial setup is cleaned too.
  return result.insertId;
}

async function createPet(tenant: number, nombre: string, raza: string | null = null, activo = 1) {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO mascotas (local_id, nombre, raza, activo, reserva_online_habilitada) VALUES (?, ?, ?, ?, 0)",
    [tenant, nombre, raza, activo],
  );
  return result.insertId;
}

async function createClient(tenant: number, nombre: string, telefono: string, canonical: string | null) {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [tenant, nombre, telefono, canonical],
  );
  return result.insertId;
}

async function link(tenant: number, pet: number, client: number) {
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [tenant, pet, client]);
}

before(async () => {
  // npm test preloads pagos.test.setup: it verifies Docker identity before ANY query/write.
  localId = await createLocal("PET_GROOMING");
  foreignLocalId = await createLocal("PET_GROOMING");
  beautyLocalId = await createLocal("BEAUTY");
  for (let index = 0; index < 25; index++) {
    initialIds.push(await createPet(localId, `AA fixture ${String(index).padStart(2, "0")}`));
  }
  firulaisId = await createPet(localId, "Firúláis", "Mestizo");
  duplicateId = await createPet(localId, "Firúláis");
  noResponsibleId = await createPet(localId, "Sin responsable");
  legacyId = await createPet(localId, "Luna legacy");
  await createPet(localId, "Firúláis inactivo", null, 0);
  for (const name of ["Literal % mascota", "Literal _ mascota", "Literal \\ mascota", "Literal ! mascota", "Literal X mascota", "D'Artagnan"]) {
    await createPet(localId, name);
  }
  anaId = await createClient(localId, "Ana Coincide", "(011) 15-2345-6789", normalizeClientPhone("+5491123456789"));
  juanId = await createClient(localId, "Juán Coincide", "11 7788-9900", normalizeClientPhone("1177889900"));
  const legacyClient = await createClient(localId, "Legacy", "11 4455-6677", null);
  // Insertion order intentionally differs from the required alphabetical order.
  await link(localId, firulaisId, juanId);
  await link(localId, firulaisId, anaId);
  await link(localId, duplicateId, anaId);
  await link(localId, legacyId, legacyClient);
  const foreignPet = await createPet(foreignLocalId, "Firúláis");
  const foreignClient = await createClient(foreignLocalId, "Exclusivo extranjero", "(011) 15-2345-6789", normalizeClientPhone("+5491123456789"));
  await link(foreignLocalId, foreignPet, foreignClient);

  const app = express();
  app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  } catch (error: unknown) { errors.push(error); }
  try {
    for (const id of locales) {
      try { await pool.query("DELETE FROM locales WHERE id = ?", [id]); }
      catch (error: unknown) { errors.push(error); }
    }
  } finally {
    try { await pool.end(); } catch (error: unknown) { errors.push(error); }
  }
  if (errors.length) throw Object.assign(new Error("Falló la limpieza de fixtures PET search"), { errors });
});

test("search route: vacío/whitespace y default 20, orden nombre/id, sin caer en /:id", async () => {
  const empty = await http();
  assert.equal(empty.status, 200);
  assert.deepEqual((JSON.parse(empty.body) as MascotaSearchResult[]).map(item => item.id), initialIds.slice(0, 20));
  assert.deepEqual(await search(""), JSON.parse(empty.body));
  assert.deepEqual(await search("   "), JSON.parse(empty.body));
});

test("search: substring y collation real insensible a case/acentos, duplicados conservan IDs", async () => {
  for (const q of ["firu", "FIRULAIS", "Firúláis", "rula"]) {
    const items = await search(q);
    assert.deepEqual(items.map(item => item.id), [firulaisId, duplicateId]);
  }
});

test("search: responsable por nombre, dos matches no duplican mascota y devuelve TODOS los responsables", async () => {
  const items = await search("coincide");
  assert.deepEqual(items.map(item => item.id), [firulaisId, duplicateId]);
  assert.deepEqual(items[0].responsables.map(item => item.id), [anaId, juanId]);
  const onlyJuanMatches = await search("juan coincide");
  assert.deepEqual(onlyJuanMatches.map(item => item.id), [firulaisId]);
  assert.deepEqual(onlyJuanMatches[0].responsables.map(item => item.id), [anaId, juanId]);
});

test("search: teléfonos canonical/display/parcial con el helper PET-11", async () => {
  for (const q of ["+5491123456789", "(011) 15-2345-6789", "112345"]) {
    assert.deepEqual((await search(q)).map(item => item.id), [firulaisId, duplicateId]);
  }
  assert.deepEqual((await search("1177889900")).map(item => item.id), [firulaisId]);
  // The display contains 011, but canonical rows must not use the legacy display fallback.
  assert.deepEqual(await search("011"), []);
});

test("search: fallback textual legacy NULL para display completo y parcial", async () => {
  for (const q of ["11 4455-6677", "4455", "11 4455"]) {
    assert.deepEqual((await search(q)).map(item => item.id), [legacyId]);
  }
});

test("search: sin responsables/raza null válido, DTO mínimo y online false incluido, inactiva excluida", async () => {
  assert.deepEqual(await search("Sin responsable"), [{ id: noResponsibleId, nombre: "Sin responsable", raza: null, responsables: [] }]);
  const items = await search("firulais");
  assert.equal(items.length, 2);
  assert.equal(items[0].raza, "Mestizo");
  assert.deepEqual(Object.keys(items[0]).sort(), ["id", "nombre", "raza", "responsables"]);
  assert.deepEqual(Object.keys(items[0].responsables[0]).sort(), ["id", "nombre", "telefono"]);
});

test("search: tenant JWT exclusivo incluso con nombres/teléfonos idénticos y localId query ajeno", async () => {
  assert.deepEqual(await search("Exclusivo extranjero", { localId: String(foreignLocalId) }), []);
  assert.deepEqual((await search("firulais", { localId: String(foreignLocalId) })).map(item => item.id), [firulaisId, duplicateId]);
  const foreign = await http("?q=firulais", token(foreignLocalId));
  const items = JSON.parse(foreign.body) as MascotaSearchResult[];
  assert.equal(foreign.status, 200);
  assert.equal(items.length, 1);
  assert.ok(![firulaisId, duplicateId].includes(items[0].id));
  assert.equal(items[0].responsables[0].nombre, "Exclusivo extranjero");
});

test("search: sin JWT 401, rol no-admin y BEAUTY 403", async () => {
  assert.equal((await http("?q=firu", null)).status, 401);
  assert.equal((await http("?q=firu", token(localId, "empleado"))).status, 403);
  assert.equal((await http("?q=firu", token(beautyLocalId))).status, 403);
});

test("search: límites 1/20 válidos, default 20", async () => {
  assert.equal((await search("AA fixture")).length, 20);
  assert.deepEqual((await search("AA fixture", { limit: "1" })).map(item => item.id), initialIds.slice(0, 1));
  assert.equal((await search("AA fixture", { limit: "20" })).length, 20);
});

for (const query of [
  "q=a", "q=%20a%20", `q=${"a".repeat(101)}`, "q=aa&q=bb", "q[x]=aa",
  "limit=21", "limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=", "limit=1&limit=2", "limit[x]=2",
]) {
  test(`search: consulta inválida devuelve 400 seguro (${query.slice(0, 30)})`, async () => {
    const result = await http(`?${query}`);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).code, "PET_MASCOTA_SEARCH_INVALID");
  });
}

test("search: longitud 100 aceptada y caracteres LIKE/comillas se buscan literalmente", async () => {
  assert.deepEqual(await search("a".repeat(100)), []);
  for (const [q, expected] of [["Literal %", "Literal % mascota"], ["Literal _", "Literal _ mascota"],
    ["Literal \\", "Literal \\ mascota"], ["Literal !", "Literal ! mascota"], ["D'Art", "D'Artagnan"]]) {
    assert.deepEqual((await search(q)).map(item => item.nombre), [expected]);
  }
  assert.deepEqual(await search("' OR 1=1 --"), []);
});

test("search service: dos queries constantes para 1 o 20 resultados y una para cero (sin N+1)", async t => {
  const spy = t.mock.method(pool, "query");
  for (const limit of [1, 20]) {
    const beforeCount = spy.mock.callCount();
    const items = await buscarMascotas(localId, { q: "AA fixture", limit });
    assert.equal(items.length, limit);
    assert.equal(spy.mock.callCount() - beforeCount, 2);
  }
  const beforeCount = spy.mock.callCount();
  assert.deepEqual(await buscarMascotas(localId, { q: "no-existe-PET09R", limit: 20 }), []);
  assert.equal(spy.mock.callCount() - beforeCount, 1);
});
