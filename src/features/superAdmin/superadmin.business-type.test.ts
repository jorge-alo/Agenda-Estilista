import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import Module from "node:module";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_TEST_SECRET = "SECRETO_JWT_FICTICIO_PET01_SOLO_TESTS";
const SUPERADMIN_ID = 1;
const ADMIN_ID = 2;

const queries: Array<{ sql: string; values: unknown[] }> = [];
const transactionCalls: string[] = [];
let connectionRequests = 0;

const connection = {
  async beginTransaction() { transactionCalls.push("begin"); },
  async commit() { transactionCalls.push("commit"); },
  async rollback() { transactionCalls.push("rollback"); },
  release() { transactionCalls.push("release"); },
  async query(sql: string, values: unknown[]) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: normalized, values: [...values] });
    if (normalized.startsWith("SELECT id FROM usuarios WHERE email")) {
      return [[], []];
    }
    if (normalized.startsWith("INSERT INTO locales")) {
      return [{ insertId: 999 }, []];
    }
    if (normalized.startsWith("INSERT INTO usuarios")) {
      return [{ insertId: 888 }, []];
    }
    throw new Error("Consulta inesperada en la prueba aislada de PET-01: " + normalized);
  },
};

const dbPath = require.resolve("../../config/db");
const originalDbModule = require.cache[dbPath];
const dbStub = new Module(dbPath);
dbStub.filename = dbPath;
dbStub.loaded = true;
dbStub.exports = {
  pool: {
    async getConnection() {
      connectionRequests++;
      return connection;
    },
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, values: [...values] });
      if (normalized.startsWith("SELECT ") && normalized.includes("FROM locales l") && normalized.includes("l.business_type")) {
        if (normalized.endsWith("WHERE l.id = ?")) {
          assert.equal(values.length, 1);
          const local = listarLocalesMock.find(l => l.id === values[0]);
          return [local ? [local] : [], []];
        }
        if (normalized.endsWith("ORDER BY l.created_at DESC")) {
          assert.deepEqual(values, []);
          return [listarLocalesMock, []];
        }
      }
      throw new Error("Consulta inesperada en pool.query: " + normalized);
    },
  },
};
require.cache[dbPath] = dbStub;

// Rutas de módulos para limpieza de caché
const servicePath = require.resolve("./superadmin.service");
const controllerPath = require.resolve("./superadmin.controller");
const routesPath = require.resolve("./superadmin.routes");

let routerSuperAdmin: any;
let server: Server;
let port: number;

before(async () => {
  // Limpiar cachés antes de importar el router
  delete require.cache[servicePath];
  delete require.cache[controllerPath];
  delete require.cache[routesPath];

  // Importar router DESPUÉS de configurar el mock
  const { default: router } = require("./superadmin.routes") as typeof import("./superadmin.routes");
  routerSuperAdmin = router;

  const app = express();
  app.use(express.json());
  app.use("/api/superAdmin", routerSuperAdmin);
  const serverInstance = app.listen(0, "127.0.0.1");
  await once(serverInstance, "listening");
  const address = serverInstance.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  server = serverInstance;
});
beforeEach((t) => {
  assert.ok("mock" in t);
  queries.length = 0;
  transactionCalls.length = 0;
  connectionRequests = 0;
  t.mock.property(process, "env", { JWT_SECRET: JWT_TEST_SECRET });
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    if (originalDbModule) require.cache[dbPath] = originalDbModule;
    else delete require.cache[dbPath];
    delete require.cache[servicePath];
    delete require.cache[controllerPath];
    delete require.cache[routesPath];
  }
});

function token(payload: Record<string, unknown>): string {
  return jwt.sign({ userId: 1, rol: "admin", ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

function superadminToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: SUPERADMIN_ID, rol: "superadmin", ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

async function postRegister(body: Record<string, unknown>, accessToken?: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/superAdmin/register", headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function getLocales(accessToken?: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/superAdmin/locales", headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function getLocal(id: number, accessToken?: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    const req = request({ host: "127.0.0.1", port, method: "GET", path: `/api/superAdmin/locales/${id}`, headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function baseRegisterData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "nuevo@local.com",
    password: "password123",
    nombreLocal: "Nuevo Local",
    telefono: "+54 11 1234-5678",
    ...overrides,
  };
}

function verificarInsercionLocalEsperada(businessTypeEsperado: string) {
  const localInsert = queries.find(({ sql }) => sql.startsWith("INSERT INTO locales"));
  assert.ok(localInsert, "Debe haber INSERT INTO locales");
  const valores = localInsert.values;
  assert.equal(valores[3], businessTypeEsperado, `business_type debe ser ${businessTypeEsperado}`);
  assert.deepEqual(transactionCalls, ["begin", "commit", "release"], "Transacción debe commit");
  assert.equal(connectionRequests, 1);
}

function verificarSinInsercion() {
  assert.equal(connectionRequests, 0, "No debe solicitarse conexión ni iniciarse creación");
  assert.deepEqual(queries, []);
  assert.deepEqual(transactionCalls, []);
}

const listarLocalesMock = [
  {
    id: 1,
    nombre: "Local Beauty",
    slug: "local-beauty",
    telefono: "+54 11 1111-1111",
    activo: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    business_type: "BEAUTY",
    usuario_id: 10,
    email: "admin1@local.com",
    usuario_activo: 1,
  },
  {
    id: 2,
    nombre: "Local Pet",
    slug: "local-pet",
    telefono: "+54 11 2222-2222",
    activo: 1,
    created_at: "2026-01-02T00:00:00.000Z",
    business_type: "PET_GROOMING",
    usuario_id: 20,
    email: "admin2@local.com",
    usuario_activo: 1,
  },
];

function verificarListadoIncluyeBusinessType(body: unknown) {
  const locales = JSON.parse(body as string);
  assert.ok(Array.isArray(locales), "Respuesta debe ser array");
  assert.deepEqual(
    locales.map((local: { id: number; business_type: string }) => ({ id: local.id, business_type: local.business_type })),
    [{ id: 1, business_type: "BEAUTY" }, { id: 2, business_type: "PET_GROOMING" }],
    "El listado debe conservar ambos locales y sus tipos exactos"
  );
  for (const local of locales) {
    assert.ok("business_type" in local, "Cada local debe tener business_type");
    assert.ok(["BEAUTY", "PET_GROOMING"].includes(local.business_type), `business_type inválido: ${local.business_type}`);
  }
}

function verificarDetalleIncluyeBusinessType(body: unknown, id: number, businessTypeEsperado: string) {
  const local = JSON.parse(body as string);
  assert.ok(local, "Respuesta no debe ser null");
  assert.equal(local.id, id, "Debe devolver el local solicitado");
  assert.ok("business_type" in local, "Local debe tener business_type");
  assert.equal(local.business_type, businessTypeEsperado, `business_type debe ser ${businessTypeEsperado}`);
}

function verificarAutorizacionGetLocales() {
  test("PET-01B GET /api/superAdmin/locales: sin token devuelve 401", async () => {
    const result = await getLocales();
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
  });

  test("PET-01B GET /api/superAdmin/locales: admin normal devuelve 403", async () => {
    const result = await getLocales(token({ localId: 1 }));
    assert.equal(result.statusCode, 403);
    assert.deepEqual(JSON.parse(result.body), { error: "Acceso denegado" });
  });

  test("PET-01B GET /api/superAdmin/locales: token inválido devuelve 401", async () => {
    const firmaAjena = jwt.sign({ userId: SUPERADMIN_ID, rol: "superadmin" }, "OTRO_SECRETO_FICTICIO_PET01_SOLO_TESTS");
    for (const accessToken of ["token-invalido", firmaAjena]) {
      const result = await getLocales(accessToken);
      assert.equal(result.statusCode, 401);
      assert.deepEqual(JSON.parse(result.body), { error: "Token inválido" });
    }
  });
}

function verificarAutorizacionGetLocal(id: number) {
  test(`PET-01B GET /api/superAdmin/locales/${id}: sin token devuelve 401`, async () => {
    const result = await getLocal(id);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
  });

  test(`PET-01B GET /api/superAdmin/locales/${id}: admin normal devuelve 403`, async () => {
    const result = await getLocal(id, token({ localId: 1 }));
    assert.equal(result.statusCode, 403);
    assert.deepEqual(JSON.parse(result.body), { error: "Acceso denegado" });
  });

  test(`PET-01B GET /api/superAdmin/locales/${id}: token inválido devuelve 401`, async () => {
    const firmaAjena = jwt.sign({ userId: SUPERADMIN_ID, rol: "superadmin" }, "OTRO_SECRETO_FICTICIO_PET01_SOLO_TESTS");
    for (const accessToken of ["token-invalido", firmaAjena]) {
      const result = await getLocal(id, accessToken);
      assert.equal(result.statusCode, 401);
      assert.deepEqual(JSON.parse(result.body), { error: "Token inválido" });
    }
  });
}

function verificarContenidoGetLocales() {
  test("PET-01B GET /api/superAdmin/locales: superadmin recibe lista con business_type", async () => {
    const result = await getLocales(superadminToken());
    assert.equal(result.statusCode, 200);
    verificarListadoIncluyeBusinessType(result.body);
  });
}

function verificarContenidoGetLocal(id: number, businessTypeEsperado: string) {
  test(`PET-01B GET /api/superAdmin/locales/${id}: superadmin recibe detalle con business_type ${businessTypeEsperado}`, async () => {
    const result = await getLocal(id, superadminToken());
    assert.equal(result.statusCode, 200);
    verificarDetalleIncluyeBusinessType(result.body, id, businessTypeEsperado);
  });
}

// Tests de alta con business_type

test("PET-01B POST /api/superAdmin/register: campo omitido crea BEAUTY por defecto", async () => {
  const result = await postRegister(baseRegisterData(), superadminToken());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { status: "Ok", message: "Usuario creado", userId: 888 });
  verificarInsercionLocalEsperada("BEAUTY");
});

test("PET-01B POST /api/superAdmin/register: BEAUTY explícito crea BEAUTY", async () => {
  const result = await postRegister({ ...baseRegisterData(), business_type: "BEAUTY" }, superadminToken());
  assert.equal(result.statusCode, 200);
  verificarInsercionLocalEsperada("BEAUTY");
});

test("PET-01B POST /api/superAdmin/register: PET_GROOMING explícito crea PET_GROOMING", async () => {
  const result = await postRegister({ ...baseRegisterData(), business_type: "PET_GROOMING" }, superadminToken());
  assert.equal(result.statusCode, 200);
  verificarInsercionLocalEsperada("PET_GROOMING");
});

// Tests de invalidación

const businessTypesInvalidos: Array<{ nombre: string; valor: unknown }> = [
  { nombre: "null", valor: null },
  { nombre: "string vacío", valor: "" },
  { nombre: "valor desconocido", valor: "OTRO" },
  { nombre: "minúsculas beauty", valor: "beauty" },
  { nombre: "minúsculas pet_grooming", valor: "pet_grooming" },
  { nombre: "número", valor: 123 },
  { nombre: "array", valor: ["BEAUTY"] },
  { nombre: "objeto", valor: { tipo: "BEAUTY" } },
];

for (const { nombre, valor } of businessTypesInvalidos) {
  test(`PET-01B POST /api/superAdmin/register: business_type ${nombre} inválido devuelve 400 sin inserción`, async () => {
    const result = await postRegister({ ...baseRegisterData(), business_type: valor }, superadminToken());
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "Tipo de negocio inválido" });
    verificarSinInsercion();
  });
}

// Tests de autorización

test("PET-01B POST /api/superAdmin/register: sin token devuelve 401 sin creación", async () => {
  const result = await postRegister(baseRegisterData());
  assert.equal(result.statusCode, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
  verificarSinInsercion();
});

test("PET-01B POST /api/superAdmin/register: admin normal (no superadmin) devuelve 403 sin creación", async () => {
  const result = await postRegister(baseRegisterData(), token({ localId: 1 }));
  assert.equal(result.statusCode, 403);
  assert.deepEqual(JSON.parse(result.body), { error: "Acceso denegado" });
  verificarSinInsercion();
});

test("PET-01B POST /api/superAdmin/register: token inválido devuelve 401 sin creación", async () => {
  const firmaAjena = jwt.sign({ userId: SUPERADMIN_ID, rol: "superadmin" }, "OTRO_SECRETO_FICTICIO_PET01_SOLO_TESTS");
  for (const accessToken of ["token-invalido", firmaAjena]) {
    const result = await postRegister(baseRegisterData(), accessToken);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "Token inválido" });
    verificarSinInsercion();
  }
});

// Test de transacción: fallo al crear usuario debe hacer rollback del local

test("PET-01B POST /api/superAdmin/register: fallo al crear usuario hace rollback del local", async () => {
  // Hacemos TODA la sustitución del módulo DB ANTES de importar el router,
  // siguiendo el patrón de turnos.security.test.ts. También limpiamos
  // los módulos superadmin que dependen del DB para que usen el nuevo stub.
  const connectionWithUserFailure = {
    async beginTransaction() { transactionCalls.push("begin"); },
    async commit() { transactionCalls.push("commit"); },
    async rollback() { transactionCalls.push("rollback"); },
    release() { transactionCalls.push("release"); },
    async query(sql: string, values: unknown[]) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, values: [...values] });
      if (normalized.startsWith("SELECT id FROM usuarios WHERE email")) {
        return [[], []];
      }
      if (normalized.startsWith("INSERT INTO locales")) {
        return [{ insertId: 999 }, []];
      }
      if (normalized.startsWith("INSERT INTO usuarios")) {
        throw new Error("Fallo simulado al crear usuario");
      }
      throw new Error("Consulta inesperada: " + normalized);
    },
  };

  const dbStubFail = new Module(dbPath);
  dbStubFail.filename = dbPath;
  dbStubFail.loaded = true;
  dbStubFail.exports = {
    pool: {
      async getConnection() {
        connectionRequests++;
        return connectionWithUserFailure;
      },
      query() { throw new Error("Pool.query no permitido"); },
    },
  };
  require.cache[dbPath] = dbStubFail;

  // Limpiar caches de los módulos superadmin para que re-importen con el nuevo DB
  const servicePath = require.resolve("./superadmin.service");
  const controllerPath = require.resolve("./superadmin.controller");
  const routesPath = require.resolve("./superadmin.routes");
  delete require.cache[servicePath];
  delete require.cache[controllerPath];
  delete require.cache[routesPath];

  // Ahora importamos el router DESPUÉS de reemplazar el cache
  const { default: routerFail } = require("./superadmin.routes") as typeof import("./superadmin.routes");
  const appFail = express();
  appFail.use(express.json());
  appFail.use("/api/superAdmin", routerFail);
  const serverFail = appFail.listen(0, "127.0.0.1");
  await once(serverFail, "listening");
  const addressFail = serverFail.address();
  assert.ok(addressFail && typeof addressFail !== "string");
  const portFail = addressFail.port;

  try {
    const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${superadminToken()}` };
      const req = request({ host: "127.0.0.1", port: portFail, method: "POST", path: "/api/superAdmin/register", headers }, (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { responseBody += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(JSON.stringify(baseRegisterData()));
    });

    assert.equal(result.statusCode, 500);
    assert.deepEqual(transactionCalls, ["begin", "rollback", "release"], "Debe hacer rollback en fallo de usuario");
  } finally {
    await new Promise<void>((resolve) => serverFail.close(() => resolve()));
    require.cache[dbPath] = originalDbModule;
    // Restaurar caches de módulos superadmin
    delete require.cache[servicePath];
    delete require.cache[controllerPath];
    delete require.cache[routesPath];
  }
});

// Tests de autorización para GET /api/superAdmin/locales
verificarAutorizacionGetLocales();

// Tests de autorización para GET /api/superAdmin/locales/:id
verificarAutorizacionGetLocal(1);
verificarAutorizacionGetLocal(2);

// Tests de contenido para GET /api/superAdmin/locales
verificarContenidoGetLocales();

// Tests de contenido para GET /api/superAdmin/locales/:id
verificarContenidoGetLocal(1, "BEAUTY");
verificarContenidoGetLocal(2, "PET_GROOMING");
