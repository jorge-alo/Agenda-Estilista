import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import Module from "node:module";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

const LOCAL_A = 101;
const LOCAL_B = 202;
const CLIENTE_ID = 901;
const TURNO_ID = 902;
const JWT_TEST_SECRET = "SECRETO_JWT_FICTICIO_SEG001_SOLO_TESTS";

const queries: Array<{ sql: string; values: unknown[] }> = [];
const transactionCalls: string[] = [];
let connectionRequests = 0;

// Sustituir config/db antes de importar el router: nunca cargar .env ni abrir
// una conexión real. Route, authMiddleware, controller y createTurno son reales.
const connection = {
  async beginTransaction() { transactionCalls.push("begin"); },
  async commit() { transactionCalls.push("commit"); },
  async rollback() { transactionCalls.push("rollback"); },
  release() { transactionCalls.push("release"); },
  async query(sql: string, values: unknown[]) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: normalized, values: [...values] });
    if (normalized.startsWith("SELECT s.duracion FROM servicios")) {
      assert.match(normalized, /s\.id = \? AND s\.local_id = \?/);
      assert.match(normalized, /l\.business_type = 'BEAUTY'/);
      assert.equal(values[1], LOCAL_A);
      return [[{ duracion: 30 }], []];
    }
    if (normalized === "SELECT id FROM estilistas WHERE id = ? AND local_id = ? FOR SHARE") {
      assert.deepEqual(values, [303, LOCAL_A]);
      return [[{ id: 303 }], []];
    }
    if (normalized.startsWith("SELECT id FROM turnos") || normalized.startsWith("SELECT id FROM clientes")) {
      return [[], []];
    }
    if (normalized.startsWith("INSERT INTO clientes")) return [{ insertId: CLIENTE_ID }, []];
    if (normalized.startsWith("INSERT INTO turnos")) return [{ insertId: TURNO_ID }, []];
    throw new Error("Consulta inesperada en la prueba aislada de SEG-001");
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
    async query(sql: string, values: unknown[]) {
      assert.equal(sql, "SELECT business_type FROM locales WHERE id = ?");
      assert.deepEqual(values, [LOCAL_A]);
      queries.push({ sql, values: [...values] });
      return [[{ business_type: "BEAUTY" }], []];
    },
  },
};
require.cache[dbPath] = dbStub;

const { TurnosRouter } = require("./turnos.routes") as typeof import("./turnos.routes");
let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/turnos", TurnosRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
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
  }
});

function datosTurno(): Record<string, unknown> {
  return {
    fecha: "2099-01-01", hora: "10:00",
    estilista_id: 303, servicio_id: 404,
    cliente_nombre: "Cliente ficticio SEG-001", cliente_telefono: "1123456789",
  };
}

function token(payload: Record<string, unknown>): string {
  return jwt.sign({ userId: 1, rol: "admin", ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

async function postTurno(body: Record<string, unknown>, accessToken?: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/turnos", headers }, (res) => {
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

function verificarTenantEfectivo() {
  const vertical = queries.find(({ sql }) => sql.startsWith("SELECT business_type"));
  const estilista = queries.find(({ sql }) => sql.startsWith("SELECT id FROM estilistas"));
  const clienteLookup = queries.find(({ sql }) => sql.startsWith("SELECT id FROM clientes"));
  const clienteInsert = queries.find(({ sql }) => sql.startsWith("INSERT INTO clientes"));
  const turnoInsert = queries.find(({ sql }) => sql.startsWith("INSERT INTO turnos"));
  assert.ok(clienteLookup);
  assert.ok(clienteInsert);
  assert.ok(turnoInsert);
  assert.deepEqual(vertical?.values, [LOCAL_A]);
  assert.deepEqual(estilista?.values, [303, LOCAL_A]);
  const tenants = [clienteLookup.values[1], clienteInsert.values[3], turnoInsert.values[5]];
  assert.deepEqual(tenants, [LOCAL_A, LOCAL_A, LOCAL_A]);
  assert.ok(tenants.every((tenant) => tenant !== LOCAL_B), "B nunca debe ser el tenant efectivo");
  assert.equal(connectionRequests, 1);
  assert.deepEqual(transactionCalls, ["begin", "commit", "release"]);
}

function verificarSinCreacion() {
  assert.equal(connectionRequests, 0, "No debe solicitarse conexión ni iniciarse creación");
  assert.deepEqual(queries, []);
  assert.deepEqual(transactionCalls, []);
}

test("SEG-001 POST /api/turnos: JWT A y body.local_id B usan A en lookup e INSERTs", async () => {
  const result = await postTurno({ ...datosTurno(), local_id: LOCAL_B }, token({ localId: LOCAL_A }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { message: "Turno creado", turnoId: TURNO_ID });
  verificarTenantEfectivo();
});

test("SEG-001 POST /api/turnos: JWT A sin local_id en body crea en A", async () => {
  const result = await postTurno(datosTurno(), token({ localId: LOCAL_A }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { message: "Turno creado", turnoId: TURNO_ID });
  verificarTenantEfectivo();
});

test("SEG-001 POST /api/turnos: JWT A y body.local_id A mantienen compatibilidad", async () => {
  const result = await postTurno({ ...datosTurno(), local_id: LOCAL_A }, token({ localId: LOCAL_A }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { message: "Turno creado", turnoId: TURNO_ID });
  verificarTenantEfectivo();
});

const tenantsInvalidos: Array<{ nombre: string; payload: Record<string, unknown> }> = [
  { nombre: "ausente", payload: {} },
  { nombre: "null", payload: { localId: null } },
  { nombre: "string numérico", payload: { localId: String(LOCAL_A) } },
  { nombre: "cero", payload: { localId: 0 } },
  { nombre: "negativo", payload: { localId: -1 } },
  { nombre: "fraccionario", payload: { localId: 1.5 } },
  { nombre: "entero no seguro", payload: { localId: Number.MAX_SAFE_INTEGER + 1 } },
  { nombre: "boolean", payload: { localId: true } },
  { nombre: "objeto", payload: { localId: {} } },
  { nombre: "array", payload: { localId: [LOCAL_A] } },
];

for (const { nombre, payload } of tenantsInvalidos) {
  test(`SEG-001 POST /api/turnos: JWT válido con localId ${nombre} devuelve 401 sin creación`, async () => {
    const result = await postTurno({ ...datosTurno(), local_id: LOCAL_A }, token(payload));
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
    verificarSinCreacion();
  });
}

test("SEG-001 POST /api/turnos: sin token devuelve 401 sin creación", async () => {
  const result = await postTurno({ ...datosTurno(), local_id: LOCAL_A });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
  verificarSinCreacion();
});

test("SEG-001 POST /api/turnos: token inválido devuelve 401 sin creación", async () => {
  const firmaAjena = jwt.sign({ localId: LOCAL_A }, "OTRO_SECRETO_FICTICIO_SEG001_SOLO_TESTS");
  for (const accessToken of ["token-invalido", firmaAjena]) {
    const result = await postTurno({ ...datosTurno(), local_id: LOCAL_A }, accessToken);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "Token inválido" });
    verificarSinCreacion();
  }
});
