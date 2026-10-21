import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import Module from "node:module";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../config/db";
import { assertNoMascotaFixtures } from "../pet/mascotas/mascotas.test-fixtures";

// Import real routers without loading .env or allowing any external provider.
for (const [name, moduleExports] of [
  ["dotenv", { config: () => ({ parsed: {} }) }],
  ["../../shared/services/email.service", { emailService: { enviarEmailRecuperacion: async () => { throw new Error("Email forbidden"); } } }],
  ["../notifications/infrastructure/whatsapp.provider", { sendWhatsApp: async () => {} }],
] as const) {
  const id = require.resolve(name);
  const stub = new Module(id);
  stub.filename = id;
  stub.loaded = true;
  stub.exports = moduleExports;
  require.cache[id] = stub;
}
const { TurnosRouter } = require("./turnos.routes") as typeof import("./turnos.routes");
const { EstilistasRouter } = require("../estilistas/estilistas.routes") as typeof import("../estilistas/estilistas.routes");
const { HorariosRouter } = require("../horarios/horarios.routes") as typeof import("../horarios/horarios.routes");
const { default: bloqueosRouter } = require("../bloqueos/bloqueos.routes") as typeof import("../bloqueos/bloqueos.routes");
const { default: clientesRouter } = require("../clientes/clientes.routes") as typeof import("../clientes/clientes.routes");
const { default: dashboardRouter } = require("../dashboard/dashboard.routes") as typeof import("../dashboard/dashboard.routes");
const { PublicRouter } = require("../public/public.routes") as typeof import("../public/public.routes");
const { default: petRouter } = require("../pet/pet.routes") as typeof import("../pet/pet.routes");
const { WhatsAppRouter } = require("../notifications/whatsapp.routes") as typeof import("../notifications/whatsapp.routes");
const { AuthRouter } = require("../auth/auth.routes") as typeof import("../auth/auth.routes");
const { default: suscripcionRouter } = require("../suscripcion/suscripcion.routes") as typeof import("../suscripcion/suscripcion.routes");
const { default: configuracionRouter } = require("../configuracion/configuracion.routes") as typeof import("../configuracion/configuracion.routes");
const { evolutionClient } = require("../notifications/infrastructure/evolution.client") as typeof import("../notifications/infrastructure/evolution.client");
const { pagosService } = require("../pagos/pagos.service") as typeof import("../pagos/pagos.service");

const secret = "M6C_FICTITIOUS_TEST_SECRET";
const prefix = `m6c-${randomUUID()}`;
const fecha = "2098-07-14";
const locales: Array<{ id: number; slug: string; staff: number; service: number; client: number }> = [];
let mascotaId: number;
let server: Server;
let port: number;
let providerCalls = 0;
const phone = "1123456789";

async function insert(sql: string, values: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}
function token(tenant: number | null = locales[0].id, rol = "admin") {
  return jwt.sign({ userId: 1, localId: tenant, rol }, secret, { expiresIn: "5m" });
}
async function call<T = Record<string, unknown>>(method: string, path: string, payload?: unknown, bearer: string | null = token()) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, data: JSON.parse(text) as T };
}
function booking(hora: string, staff = locales[0].staff) {
  return { fecha, hora, estilista_id: staff, servicio_id: locales[0].service,
    cliente_nombre: `${prefix} booking`, cliente_telefono: "1144556677", local_id: locales[1].id };
}

function observeTransaction(t: TestContext) {
  const events: string[] = [];
  const seen = new WeakSet<object>();
  const get = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get();
    if (seen.has(connection)) return connection;
    seen.add(connection);
    for (const method of ["beginTransaction", "commit", "rollback"] as const) {
      const original = connection[method].bind(connection);
      t.mock.method(connection, method, async () => { events.push(method); await original(); });
    }
    const query = connection.query.bind(connection);
    t.mock.method(connection, "query", (async (sql: string, values?: unknown[]) => {
      events.push(sql);
      return query(sql, values);
    }) as typeof connection.query);
    return connection;
  });
  return (success: boolean) => {
    assert.equal(events[0], "beginTransaction");
    const ownership = events.findIndex(sql => /SELECT id FROM estilistas.*local_id = \? FOR SHARE/.test(sql));
    assert.ok(ownership > 0, "ownership must be locked inside the writer transaction");
    const write = events.findIndex(sql => /INSERT INTO/.test(sql));
    if (success) assert.ok(write > ownership, "validate before any insert");
    else assert.equal(write, -1, "foreign/missing stylist cannot create clients or bookings");
    assert.equal(events[events.length - 1], success ? "commit" : "rollback");
    events.length = 0;
  };
}

before(async () => {
  for (const [i, business, active] of [[0, "BEAUTY", 1], [1, "BEAUTY", 1], [2, "PET_GROOMING", 1], [3, "BEAUTY", 0]] as const) {
    const slug = `${prefix}-${i}`;
    const id = await insert(`INSERT INTO locales (nombre, slug, business_type, activo, requiere_sena, telefono,
      suscripcion_estado, suscripcion_vencimiento) VALUES (?, ?, ?, ?, 0, '1155550000', 'activo', '2099-12-31')`,
    [prefix, slug, business, active]);
    // Register immediately, including partial setup failures.
    const fixture = { id, slug, staff: 0, service: 0, client: 0 };
    locales.push(fixture);
    fixture.staff = await insert("INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)", [`${prefix} staff ${i}`, id]);
    fixture.service = await insert("INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)", [`${prefix} service ${i}`, id]);
    fixture.client = await insert("INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, '5491123456789', ?)", [prefix, phone, id]);
    await pool.query("INSERT INTO horarios (estilista_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, '09:00', '18:00', 1)",
      [fixture.staff, new Date(2098, 6, 14).getDay()]);
    if (i < 2) await insert(`INSERT INTO turnos (local_id, estilista_id, servicio_id, cliente_id, cliente_nombre, cliente_telefono,
      fecha, hora, hora_fin, estado) VALUES (?, ?, ?, ?, ?, ?, ?, '09:00', '09:30', 'completado')`,
    [id, fixture.staff, fixture.service, fixture.client, prefix, phone, i === 0 ? "2096-07-14" : "2097-07-14"]);
  }
  const pet = locales[2];
  mascotaId = await insert("INSERT INTO mascotas (local_id, nombre, activo, alta_exigencia) VALUES (?, ?, 1, 0)", [pet.id, prefix]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [pet.id, mascotaId, pet.client]);
  await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 30)", [pet.id, mascotaId, pet.service]);
  await pool.query("INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, '09:00', '18:00')",
    [pet.id, new Date(2098, 6, 14).getDay()]);
  const app = express();
  app.use(express.json());
  app.use("/api/turnos", TurnosRouter);
  app.use("/api/estilistas", EstilistasRouter);
  app.use("/api/horarios", HorariosRouter);
  app.use("/api/bloqueos", bloqueosRouter);
  app.use("/api/clientes", clientesRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/public", PublicRouter);
  app.use("/api/pet/admin", petRouter);
  app.use("/api/whatsapp", WhatsAppRouter);
  app.use("/api/auth", AuthRouter);
  app.use("/api/suscripcion", suscripcionRouter);
  app.use("/api/configuracion", configuracionRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  t.mock.method(console, "log", () => {});
  providerCalls = 0;
  t.mock.method(evolutionClient, "get", async () => { providerCalls++; return { data: { base64: "fixture-qr", instance: { state: "open" } } }; });
  t.mock.method(evolutionClient, "post", async () => { providerCalls++; return { data: {} }; });
  t.mock.method(pagosService, "crearPreference", async () => { throw new Error("Mercado Pago forbidden in M6C"); });
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const fixture of locales) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query<RowDataPacket[]>("SELECT slug FROM locales WHERE id = ? FOR UPDATE", [fixture.id]);
        assert.equal(rows[0]?.slug, fixture.slug, "Fixture identity mismatch: stop cleanup");
        for (const table of ["pagos", "pagos_suscripcion", "pet_access_tokens", "pet_client_sessions", "usuarios"] as const) {
          const [unexpected] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id = ?`, [fixture.id]);
          assert.equal(Number(unexpected[0].n), 0, `Unexpected fixture dependency: ${table}`);
        }
        // Explicit FK order. Every delete uses this process-owned tenant, never names/ranges.
        await connection.query("DELETE te FROM turno_extras te JOIN turnos t ON t.id = te.turno_id WHERE t.local_id = ?", [fixture.id]);
        for (const table of ["turnos", "solicitudes_pet", "mascota_extras", "mascota_servicios", "mascota_clientes",
          "bloqueos_horarios", "horarios_local", "bloqueos_local", "pet_settings"] as const) {
          await connection.query(`DELETE FROM ${table} WHERE local_id = ?`, [fixture.id]);
        }
        await connection.query("DELETE h FROM horarios h JOIN estilistas e ON e.id = h.estilista_id WHERE e.local_id = ?", [fixture.id]);
        await connection.query("DELETE es FROM estilista_servicios es JOIN estilistas e ON e.id = es.estilista_id WHERE e.local_id = ?", [fixture.id]);
        for (const table of ["mascotas", "clientes", "extras", "servicios", "estilistas"] as const) {
          await connection.query(`DELETE FROM ${table} WHERE local_id = ?`, [fixture.id]);
        }
        await connection.query("DELETE FROM locales WHERE id = ? AND slug = ?", [fixture.id, fixture.slug]);
        await connection.commit();
      } catch (error: unknown) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    }
    await assertNoMascotaFixtures(locales.map(f => f.id));
    for (const f of locales) {
      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM horarios WHERE estilista_id = ?", [f.staff]);
      assert.equal(Number(rows[0].n), 0, "Residual horarios fixture");
    }
    console.info("M6C cleanup: exact tenants and FK children verified, 0 residual fixtures");
  } finally { await pool.end(); }
});

const legacy = [
  ["GET", "/api/estilistas/admin"], ["POST", "/api/estilistas/admin"],
  ["PUT", "/api/estilistas/admin/1"], ["DELETE", "/api/estilistas/admin/1"],
  ["POST", "/api/horarios"], ["GET", "/api/horarios/1"], ["DELETE", "/api/horarios/1"], ["PATCH", "/api/horarios/1/toggle"],
  ["GET", "/api/bloqueos"], ["POST", "/api/bloqueos"], ["DELETE", "/api/bloqueos/1"],
  ["GET", "/api/clientes"], ["GET", "/api/dashboard/clientes"], ["GET", "/api/dashboard/resumen-dia"], ["GET", "/api/dashboard/reporte-mensual"],
  ["GET", "/api/turnos"], ["GET", "/api/turnos/rango"], ["GET", "/api/turnos/futuros"],
  ["GET", "/api/turnos/disponibilidad/Admin"], ["POST", "/api/turnos"], ["POST", "/api/turnos/admin"],
  ["PUT", "/api/turnos/1"], ["PATCH", "/api/turnos/1/cancelar"], ["PATCH", "/api/turnos/1/completar"],
] as const;
for (const [method, path] of legacy) test(`SEG-013 PET explicitly denied: ${method} ${path}`, async () => {
  const response = await call(method, path, undefined, token(locales[2].id));
  assert.equal(response.status, 403, JSON.stringify(response));
  assert.match(String(response.data.error), /solo para BEAUTY/);
  assert.equal((await call(method, path, undefined, null)).status, 401, "auth precedes vertical/controller");
});

test("SEG-013 shared auth/me, subscription and general settings remain available to PET admin", async () => {
  for (const path of ["/api/auth/me", "/api/suscripcion/estado", "/api/configuracion"]) {
    const response = await call("GET", path, undefined, token(locales[2].id));
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response)}`);
  }
});

for (const [label, method, path, payload, status] of [
  ["Mascotas", "GET", "/api/pet/admin/mascotas", undefined, 200],
  ["Responsables", "POST", "/api/pet/admin/responsables", { nombre: "M6C role", telefono: "1177778888" }, 201],
  ["Solicitudes", "GET", "/api/pet/admin/solicitudes", undefined, 200],
] as const) {
  for (const rol of ["admin", "estilista", "superadmin"]) test(`H09 ${label}: ${rol}`, async () => {
    const response = await call(method, path, payload, token(locales[2].id, rol));
    assert.equal(response.status, rol === "admin" ? status : 403, JSON.stringify(response));
  });
}

for (const action of ["conectar", "estado"]) {
  for (const rol of ["admin", "estilista", "superadmin"]) test(`H09 WhatsApp ${action}: ${rol}, both verticals`, async () => {
    for (const tenant of [locales[0].id, locales[2].id]) {
      const response = await call("GET", `/api/whatsapp/${action}/${tenant}`, undefined, token(tenant, rol));
      assert.equal(response.status, rol === "admin" ? 200 : 403, JSON.stringify(response));
    }
    assert.equal(providerCalls, rol === "admin" ? (action === "conectar" ? 4 : 2) : 0);
  });
  test(`H09 WhatsApp ${action}: foreign tenant/no tenant/anonymous never reach provider`, async () => {
    for (const bearer of [token(), token(null, "superadmin"), token(null), null]) {
      const result = await call("GET", `/api/whatsapp/${action}/${locales[2].id}`, undefined, bearer);
      assert.equal(result.status, bearer === null ? 401 : 403);
    }
    assert.equal(providerCalls, 0);
  });
}

test("H03 valid PET booking is indistinguishable from nonexistent ID to legacy public reader", async () => {
  const pet = locales[2];
  const created = await call("POST", "/api/pet/admin/turnos", {
    mascotaId, clienteId: pet.client, servicioId: pet.service, extraIds: [], fecha, hora: "09:00",
  }, token(pet.id));
  assert.equal(created.status, 201, JSON.stringify(created));
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM turnos WHERE local_id = ? AND mascota_id = ?", [pet.id, mascotaId]);
  assert.equal(rows.length, 1);
  const hidden = await call("GET", `/api/public/turno/${rows[0].id}`, undefined, null);
  assert.deepEqual(hidden, await call("GET", "/api/public/turno/2147483647", undefined, null));
  assert.deepEqual(hidden, { status: 404, data: { error: "Turno no encontrado" } });
});

test("H03 BEAUTY public reader preserves historical response fields", async () => {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM turnos WHERE local_id = ? ORDER BY id LIMIT 1", [locales[0].id]);
  const result = await call("GET", `/api/public/turno/${rows[0].id}`, undefined, null);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ["fecha", "hora", "cliente_nombre", "estado", "servicioNombre", "localNombre"].sort());
  assert.equal(result.data.cliente_nombre, prefix);
  assert.equal(result.data.servicioNombre, `${prefix} service 0`);
  assert.equal(result.data.estado, "completado");
});

test("H03 PET local with legacy no-mascota row is also hidden by explicit business type", async () => {
  const pet = locales[2];
  const id = await insert(`INSERT INTO turnos (local_id, estilista_id, servicio_id, cliente_nombre, cliente_telefono,
    fecha, hora, hora_fin, estado) VALUES (?, ?, ?, ?, ?, ?, '15:00', '15:30', 'activo')`,
  [pet.id, pet.staff, pet.service, prefix, phone, fecha]);
  assert.deepEqual(await call("GET", `/api/public/turno/${id}`, undefined, null),
    { status: 404, data: { error: "Turno no encontrado" } });
});

test("H04 same phone, two tenants: newer B cannot contaminate A and inverse stays B", async () => {
  for (const i of [0, 1]) {
    const response = await call<Array<Record<string, unknown>>>("GET", "/api/dashboard/clientes", undefined, token(locales[i].id));
    assert.equal(response.status, 200, JSON.stringify(response));
    const row = response.data.find(r => r.cliente_telefono === phone);
    assert.ok(row);
    assert.equal(row.ultimo_servicio, `${prefix} service ${i}`);
    assert.equal(row.visitas, 1);
  }
});

test("BEAUTY regression: stylist CRUD, schedules, clients and all dashboard readers", async () => {
  const created = await call("POST", "/api/estilistas/admin", { nombre: `${prefix} removable` });
  assert.equal(created.status, 200);
  const id = Number(created.data.id);
  assert.equal((await call("PUT", `/api/estilistas/admin/${id}`, { nombre: `${prefix} edited` })).status, 200);
  assert.equal((await call("GET", "/api/estilistas/admin")).status, 200);
  assert.equal((await call("DELETE", `/api/estilistas/admin/${id}`)).status, 200);
  const schedule = await call("POST", "/api/horarios", { estilista_id: locales[0].staff, dia_semana: 0, hora_inicio: "08:00", hora_fin: "09:00" });
  assert.equal(schedule.status, 200);
  assert.equal((await call("PATCH", `/api/horarios/${schedule.data.id}/toggle`)).status, 200);
  assert.equal((await call("DELETE", `/api/horarios/${schedule.data.id}`)).status, 200);
  for (const path of ["/api/clientes", `/api/dashboard/resumen-dia?fecha=${fecha}`, "/api/dashboard/clientes", "/api/dashboard/reporte-mensual"]) {
    assert.equal((await call("GET", path)).status, 200, path);
  }
});

test("SEG-013 public stylist catalogue rejects PET/inactive/missing, retains active BEAUTY tenant", async () => {
  for (const slug of [locales[2].slug, locales[3].slug, `${prefix}-missing`]) {
    assert.deepEqual((await call("GET", `/api/estilistas?slug=${slug}`, undefined, null)).data, []);
  }
  const response = await call<Array<{ id: number }>>("GET", `/api/estilistas?slug=${locales[0].slug}`, undefined, null);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.map(r => r.id), [locales[0].staff]);
});

test("SEG-013 schedules require JWT tenant or active BEAUTY slug; no anonymous ID fallback", async () => {
  const path = `/api/horarios/${locales[0].staff}`;
  assert.equal((await call("GET", path, undefined, null)).status, 401);
  assert.equal((await call("GET", path)).status, 200);
  assert.deepEqual((await call("GET", `/api/horarios/${locales[1].staff}`)).data, []);
  assert.ok((await call<unknown[]>("GET", `${path}?slug=${locales[0].slug}`, undefined, null)).data.length > 0);
  for (const [staff, slug] of [[locales[1].staff, locales[0].slug], [locales[2].staff, locales[2].slug], [locales[3].staff, locales[3].slug], [locales[0].staff, `${prefix}-missing`]]) {
    assert.deepEqual((await call("GET", `/api/horarios/${staff}?slug=${slug}`, undefined, null)).data, []);
  }
  assert.equal((await call("GET", `${path}?slug=${locales[0].slug}`, undefined, token(locales[2].id))).status, 403);
  assert.equal((await call("GET", `${path}?slug=${locales[0].slug}`, undefined, "invalid")).status, 401);
});

test("H06 schedules and reprogramming retain existing tenant checks", async () => {
  assert.equal((await call("POST", "/api/horarios", { estilista_id: locales[1].staff, dia_semana: 0, hora_inicio: "08:00", hora_fin: "09:00" })).status, 400);
  const created = await call("POST", "/api/turnos", booking("10:00"));
  assert.equal(created.status, 200, JSON.stringify(created));
  const id = Number(created.data.turnoId);
  assert.equal((await call("PUT", `/api/turnos/${id}`, booking("10:30", locales[1].staff))).status, 400);
  assert.equal((await call("PUT", `/api/turnos/${id}`, booking("10:30"))).status, 200);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id, estilista_id, hora FROM turnos WHERE id = ? AND local_id = ?", [id, locales[0].id]);
  assert.equal(rows[0].estilista_id, locales[0].staff);
  assert.equal(rows[0].hora, "10:30:00");
});

test("H06 block writer permits own stylist, rejects foreign/missing equally before insert", async t => {
  const verify = observeTransaction(t);
  const data = { estilista_id: locales[0].staff, fecha, hora_inicio: "17:00", hora_fin: "18:00", motivo: prefix };
  assert.equal((await call("POST", "/api/bloqueos", data)).status, 200);
  verify(true);
  for (const staff of [locales[1].staff, 2147483647]) {
    assert.deepEqual(await call("POST", "/api/bloqueos", { ...data, estilista_id: staff }), { status: 404, data: { error: "Estilista no encontrado" } });
    verify(false);
  }
  const response = await call<Array<{ id: number }>>("GET", "/api/bloqueos");
  assert.equal(response.data.length, 1);
  assert.equal((await call("DELETE", `/api/bloqueos/${response.data[0].id}`)).status, 200);
});

for (const [path, hora, isPublic] of [["/api/turnos", "11:00", false], ["/api/turnos/admin", "12:00", false], ["/api/public/reservar", "13:00", true]] as const) {
  test(`H06 ${path}: own stylist OK, foreign/missing rejected, tenant authority retained`, async t => {
    const verify = observeTransaction(t);
    const auth = isPublic ? null : token();
    const data = { ...booking(hora), slug: locales[0].slug };
    for (const staff of [locales[1].staff, 2147483647]) {
      assert.deepEqual(await call("POST", path, { ...data, estilista_id: staff }, auth), { status: 404, data: { error: "Estilista no encontrado" } });
      verify(false);
    }
    assert.equal((await call("POST", path, data, auth)).status, 200);
    verify(true);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id, estilista_id FROM turnos WHERE local_id = ? AND fecha = ? AND hora = ?", [locales[0].id, fecha, hora]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estilista_id, locales[0].staff);
    assert.equal(rows[0].local_id, locales[0].id, "body local_id must not select B");
    const [foreign] = await pool.query<RowDataPacket[]>("SELECT id FROM turnos WHERE local_id = ? AND fecha = ? AND hora = ?", [locales[1].id, fecha, hora]);
    assert.equal(foreign.length, 0);
  });
}

test("SEG-013 legacy public turn list excludes PET even with a legacy stylist; availability cannot read another tenant schedule", async () => {
  const pet = await call("GET", `/api/turnos/publico?slug=${locales[2].slug}&fecha=${fecha}`, undefined, null);
  assert.notEqual(pet.status, 200);
  for (const admin of [false, true]) {
    const path = admin ? "/api/turnos/disponibilidad/Admin" : "/api/turnos/disponibilidad";
    const response = await call("GET", `${path}?slug=${locales[0].slug}&fecha=${fecha}&estilista_id=${locales[1].staff}&servicio_id=${locales[0].service}`, undefined, admin ? token() : null);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.disponibles, []);
  }
});
