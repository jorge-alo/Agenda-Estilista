import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "../../../config/db";
import { simularRecurrenciaPet, type ResolverAutorizacionRecurrenciaPet, type AutorizacionRecurrenciaPet } from "./recurrencia.service";
import { sumarDiasCalendarioPet } from "./recurrencia.time";

const hoy = "2026-11-19";
const d0 = "2026-10-20";
const now = "2026-11-19T13:00:00.000Z";
const phone = "+5491112345678";
const verified: ResolverAutorizacionRecurrenciaPet = async contacto => ({
  ...contacto, estado: "autorizada", verificadaAt: "2026-11-01T12:00:00.000Z", referenciaVerificacion: "evidence-fixture",
});

// CTEs shadow existing table names for THIS SELECT only. No INSERT/UPDATE/DDL or cleanup.
type Value = string | number | null;
interface Table { columns: string[]; rows: Value[][] }
type Escenario = Record<"turnos" | "locales" | "mascotas" | "clientes" | "mascota_clientes"
  | "mascota_servicios" | "servicios" | "pet_settings" | "pet_recordatorios" | "pet_recurrencia_contactos", Table>;
function escenario(): Escenario {
  return {
    turnos: { columns: ["id", "local_id", "mascota_id", "cliente_id", "fecha", "hora", "hora_fin", "estado"],
      rows: [[1, 1, 100, 10, d0, "10:00:00", "11:00:00", "completado"]] },
    locales: { columns: ["id", "business_type", "activo", "slug", "suscripcion_estado", "suscripcion_vencimiento"],
      rows: [[1, "PET_GROOMING", 1, "pet-fixture", "activo", "2099-12-31"]] },
    mascotas: { columns: ["id", "local_id", "activo", "reserva_online_habilitada", "alta_exigencia"],
      rows: [[100, 1, 1, 1, 0]] },
    clientes: { columns: ["id", "local_id", "telefono_normalizado"], rows: [[10, 1, phone]] },
    mascota_clientes: { columns: ["local_id", "mascota_id", "cliente_id"], rows: [[1, 100, 10]] },
    mascota_servicios: { columns: ["local_id", "mascota_id", "servicio_id", "duracion_minutos"], rows: [[1, 100, 50, 60]] },
    servicios: { columns: ["id", "local_id", "activo"], rows: [[50, 1, 1]] },
    pet_settings: { columns: ["local_id", "high_demand_rule", "high_demand_gap_minutes", "high_demand_max_per_day"], rows: [] },
    pet_recordatorios: { columns: ["local_id", "tipo", "mascota_id", "ultimo_turno_completado_id", "estado"], rows: [] },
    pet_recurrencia_contactos: { columns: ["local_id", "telefono_normalizado", "estado", "cliente_id_autorizado",
      "verificada_at", "referencia_verificacion"], rows: [] },
  };
}

function ctes(data: Escenario) {
  const values: Value[] = [];
  const definitions = Object.entries(data).map(([name, table]) => {
    const selections = table.rows.length ? table.rows.map(row => {
      assert.equal(row.length, table.columns.length);
      values.push(...row);
      return `SELECT ${row.map(() => "?").join(", ")}`;
    }).join(" UNION ALL ") : `SELECT ${table.columns.map(() => "NULL").join(", ")} WHERE FALSE`;
    return `${name} (${table.columns.join(", ")}) AS (${selections})`;
  });
  return { prefix: `WITH ${definitions.join(", ")} `, values };
}

async function simular(data: Escenario, resolver?: ResolverAutorizacionRecurrenciaPet, instant = now) {
  const fixture = ctes(data);
  const connection = await pool.getConnection();
  const statements: string[] = [];
  const read = (async (sql: string, params: Value[] = []) => {
    statements.push(sql);
    if (sql.startsWith("SELECT t.id AS turno_id") || /FROM pet_recurrencia_contactos/.test(sql)) {
      return connection.query(fixture.prefix + sql, [...fixture.values, ...params]);
    }
    assert.equal(sql, "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", "read-only SQL allowlist");
    return connection.query(sql);
  }) as PoolConnection["query"];
  let released = false;
  const proxy = new Proxy(connection, { get(target, prop) {
    if (prop === "query") return read;
    if (prop === "release") return () => { released = true; target.release(); };
    const value: unknown = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    const report = await simularRecurrenciaPet({ localId: 1, frontendUrl: "https://example.test", resolverAutorizacion: resolver },
      { getConnection: async () => proxy }, async () => new Date(instant));
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(phone), "phone never leaves simulation");
    assert.ok(!serialized.includes("evidence-fixture"), "permission evidence is not logged");
    return { report, statements };
  } finally { if (!released) connection.release(); }
}

after(async () => { await pool.end(); });

test("D30 exacto: no selecciona 29, 31, 40, 60 ni 365 días; mismo test al activar piloto", async () => {
  const data = escenario();
  data.turnos.rows = [];
  const edades = [29, 30, 31, 40, 60, 365];
  for (const [index, dias] of edades.entries()) {
    const petId = 100 + index;
    data.turnos.rows.push([index + 1, 1, petId, 10, sumarDiasCalendarioPet(hoy, -dias), "10:00:00", "11:00:00", "completado"]);
    if (index) {
      data.mascotas.rows.push([petId, 1, 1, 1, 0]);
      data.mascota_clientes.rows.push([1, petId, 10]);
      data.mascota_servicios.rows.push([1, petId, 50, 60]);
    }
  }
  const { report } = await simular(data, verified);
  assert.equal(report.examinados, 1);
  assert.equal(report.elegibles, 1);
  assert.equal(report.detalles[0].mascotaId, 101);
  assert.deepEqual([report.detalles[0].d0, report.detalles[0].d30, report.detalles[0].d35], [d0, hoy, "2026-11-24"]);
});

test("sin fuente aprobada: cero elegibles aunque el cliente exista y tenga historial", async () => {
  const { report } = await simular(escenario());
  assert.equal(report.examinados, 1);
  assert.equal(report.elegibles, 0);
  assert.equal(report.fuenteAutorizaciones, "persistida");
  assert.equal(report.exclusiones.AUTORIZACION_PENDIENTE, 1);
});

test("solo completados: activo, pendiente_pago o cancelado en D0 no prueban un servicio realizado", async () => {
  for (const state of ["activo", "pendiente_pago", "cancelado"]) {
    const data = escenario();
    data.turnos.rows[0][7] = state;
    assert.equal((await simular(data, verified)).report.examinados, 0, state);
  }
});

test("dos mascotas del mismo responsable conservan identidades separadas", async () => {
  const data = escenario();
  data.turnos.rows.push([2, 1, 101, 10, d0, "10:00:00", "11:00:00", "completado"]);
  data.mascotas.rows.push([101, 1, 1, 1, 0]);
  data.mascota_clientes.rows.push([1, 101, 10]);
  data.mascota_servicios.rows.push([1, 101, 50, 60]);
  const { report } = await simular(data, verified);
  assert.equal(report.elegibles, 2);
  assert.deepEqual(report.detalles.map(row => [row.mascotaId, row.turnoId]), [[100, 1], [101, 2]]);
});

test("al día siguiente no recupera D30 vencido ni borra la deduplicación", async () => {
  const { report, statements } = await simular(escenario(), verified, "2026-11-20T13:00:00.000Z");
  assert.equal(report.examinados, 0);
  assert.ok(statements.every(sql => sql.startsWith("SELECT") || sql.startsWith("START TRANSACTION")));
});

for (const instant of ["2026-11-19T12:59:59.999Z", "2026-11-19T15:00:00.000Z"]) {
  test(`fuera de ventana ${instant}: no autoriza ni consulta permisos`, async () => {
    const { report } = await simular(escenario(), async () => { assert.fail("no permission lookup outside window"); }, instant);
    assert.equal(report.elegibles, 0);
    assert.equal(report.exclusiones.FUERA_DE_VENTANA, 1);
  });
}

test("último completado se ordena por fecha/hora/ID, no por created_at ni MAX(id)", async () => {
  const data = escenario();
  data.turnos.rows.push([9999, 1, 100, 10, "2026-10-01", "18:00:00", "19:00:00", "completado"]);
  data.turnos.rows.push([2, 1, 100, 10, d0, "11:00:00", "12:00:00", "completado"]);
  data.turnos.rows.push([3, 1, 100, 10, d0, "11:00:00", "12:00:00", "completado"]);
  assert.deepEqual((await simular(data, verified)).report.detalles.map(row => row.turnoId), [3]);
  data.turnos.rows.push([4, 1, 100, 10, "2026-10-21", "09:00:00", "10:00:00", "completado"]);
  assert.equal((await simular(data, verified)).report.examinados, 0, "a more recent service resets the cycle");
});

test("completado futuro incoherente impide usar un servicio anterior como fallback", async () => {
  const data = escenario();
  data.turnos.rows.push([2, 1, 100, 10, "2026-11-20", "09:00:00", "10:00:00", "completado"]);
  assert.equal((await simular(data, verified)).report.examinados, 0);
});

for (const state of ["activo", "pendiente_pago"]) {
  test(`próxima reserva ${state} posterior a D35 excluye, aunque la hizo otro responsable`, async () => {
    const data = escenario();
    data.turnos.rows.push([2, 1, 100, 999, "2027-01-01", "10:00:00", "11:00:00", state]);
    const { report } = await simular(data, verified);
    assert.equal(report.exclusiones.PROXIMA_RESERVA, 1);
    assert.equal(report.elegibles, 0);
  });
}

test("cancelación deja reevaluar el mismo D30; reserva pasada no es una próxima reserva", async () => {
  const data = escenario();
  data.turnos.rows.push([2, 1, 100, 10, "2027-01-01", "10:00:00", "11:00:00", "cancelado"]);
  data.turnos.rows.push([3, 1, 100, 10, hoy, "08:00:00", "09:00:00", "activo"]);
  assert.equal((await simular(data, verified)).report.elegibles, 1);
  data.turnos.rows.push([4, 1, 100, 10, hoy, "09:30:00", "10:30:00", "activo"]);
  assert.equal((await simular(data, verified)).report.exclusiones.PROXIMA_RESERVA, 1, "ongoing counts too");
});

test("aislamiento local y mascota: reservas de otros pets/tenants no excluyen ni filtran datos", async () => {
  const data = escenario();
  data.turnos.rows.push([2, 1, 200, 10, "2027-01-01", "10:00:00", "11:00:00", "activo"]);
  data.turnos.rows.push([3, 2, 100, 10, "2027-01-01", "10:00:00", "11:00:00", "activo"]);
  data.turnos.rows.push([4, 2, 100, 10, "2026-10-21", "10:00:00", "11:00:00", "completado"]);
  data.turnos.rows.push([5, 2, 200, 10, d0, "10:00:00", "11:00:00", "completado"]);
  assert.equal((await simular(data, verified)).report.elegibles, 1);
  data.locales.rows[0][1] = "BEAUTY";
  assert.equal((await simular(data, verified)).report.examinados, 0);
});

test("sin fallback de responsable: cliente borrado/ajeno y vínculo perdido excluyen", async () => {
  for (const mutate of [
    (data: Escenario) => { data.mascota_clientes.rows = [[1, 100, 20]]; },
    (data: Escenario) => { data.turnos.rows[0][3] = null; },
    (data: Escenario) => { data.clientes.rows[0][1] = 2; },
  ]) {
    const data = escenario(); mutate(data);
    const { report } = await simular(data, verified);
    assert.equal(report.elegibles, 0);
    assert.ok(report.exclusiones.RESPONSABLE_NO_VINCULADO || report.exclusiones.TELEFONO_INVALIDO);
  }
});

for (const [label, mutate, reason] of [
  ["local inactivo", (d: Escenario) => { d.locales.rows[0][2] = 0; }, "LOCAL_NO_DISPONIBLE"],
  ["suscripción vencida", (d: Escenario) => { d.locales.rows[0][5] = "2026-11-18"; }, "LOCAL_NO_DISPONIBLE"],
  ["suscripción sin fecha", (d: Escenario) => { d.locales.rows[0][5] = null; }, "LOCAL_NO_DISPONIBLE"],
  ["slug vacío", (d: Escenario) => { d.locales.rows[0][3] = ""; }, "ENLACE_NO_DISPONIBLE"],
  ["mascota inactiva", (d: Escenario) => { d.mascotas.rows[0][2] = 0; }, "MASCOTA_NO_DISPONIBLE"],
  ["online deshabilitado", (d: Escenario) => { d.mascotas.rows[0][3] = 0; }, "MASCOTA_NO_DISPONIBLE"],
  ["teléfono sin canonical", (d: Escenario) => { d.clientes.rows[0][2] = null; }, "TELEFONO_INVALIDO"],
  ["teléfono inválido", (d: Escenario) => { d.clientes.rows[0][2] = "invalid"; }, "TELEFONO_INVALIDO"],
  ["servicio inactivo", (d: Escenario) => { d.servicios.rows[0][2] = 0; }, "SERVICIO_NO_DISPONIBLE"],
  ["servicio ajeno", (d: Escenario) => { d.servicios.rows[0][1] = 2; }, "SERVICIO_NO_DISPONIBLE"],
  ["sin duración", (d: Escenario) => { d.mascota_servicios.rows[0][3] = 0; }, "SERVICIO_NO_DISPONIBLE"],
  ["alta exigencia sin settings", (d: Escenario) => { d.mascotas.rows[0][4] = 1; }, "ALTA_EXIGENCIA_SIN_CONFIGURACION"],
] as const) {
  test(`exclusión: ${label}`, async () => {
    const data = escenario(); mutate(data);
    const { report } = await simular(data, verified);
    assert.equal(report.elegibles, 0);
    assert.equal(report.exclusiones[reason], 1);
  });
}

test("alta exigencia usa la validación existente y SaaS incluye el último día", async () => {
  const data = escenario();
  data.mascotas.rows[0][4] = 1;
  data.pet_settings.rows = [[1, "MIN_GAP", 60, null]];
  data.locales.rows[0][5] = hoy;
  assert.equal((await simular(data, verified)).report.elegibles, 1);
});

test("ciclo pending es simulable; sending/dispatching/sent/unknown/skipped no se recrean", async () => {
  const data = escenario();
  for (const state of ["pending", "sending", "dispatching", "sent", "unknown", "skipped"]) {
    data.pet_recordatorios.rows = [[1, "RECURRENCE_DAY_30", 100, 1, state]];
    assert.equal((await simular(data, verified)).report.elegibles, state === "pending" ? 1 : 0, state);
  }
  data.pet_recordatorios.rows = [[1, "APPOINTMENT_REMINDER", 100, 1, "sent"]];
  assert.equal((await simular(data, verified)).report.elegibles, 1, "appointment reminders are independent");
});

test("baja y autorización no verificable excluyen sin emitir evidencia ni errores crudos", async () => {
  assert.equal((await simular(escenario(), async () => ({ estado: "baja" }))).report.exclusiones.BAJA, 1);
  assert.equal((await simular(escenario(), async () => null)).report.exclusiones.AUTORIZACION_PENDIENTE, 1);
  for (const patch of [
    { localId: 2 }, { clienteId: 20 }, { telefonoCanonical: "+5491199999999" },
    { referenciaVerificacion: " " }, { verificadaAt: "2027-01-01T00:00:00.000Z" }, { verificadaAt: "invalid" },
  ]) {
    const resolver: ResolverAutorizacionRecurrenciaPet = async contacto => ({
      ...await verified(contacto), ...patch,
    } as AutorizacionRecurrenciaPet);
    assert.equal((await simular(escenario(), resolver)).report.exclusiones.AUTORIZACION_NO_VERIFICABLE, 1);
  }
  assert.equal((await simular(escenario(), async () => { throw new Error(`private ${phone}`); }))
    .report.exclusiones.AUTORIZACION_NO_VERIFICABLE, 1);
});

test("paginación avanza sobre excluidos y no omite al válido después de 50 filas", async () => {
  const data = escenario();
  data.turnos.rows = [];
  data.mascotas.rows = [];
  data.mascota_clientes.rows = [];
  data.mascota_servicios.rows = [];
  for (let id = 1; id <= 102; id++) {
    data.turnos.rows.push([id, 1, id, 10, d0, "10:00:00", "11:00:00", "completado"]);
    data.mascotas.rows.push([id, 1, 1, id === 51 ? 1 : 0, 0]);
    data.mascota_clientes.rows.push([1, id, 10]);
    data.mascota_servicios.rows.push([1, id, 50, 60]);
  }
  const { report, statements } = await simular(data, verified);
  assert.equal(report.examinados, 102);
  assert.equal(report.elegibles, 1);
  assert.equal(report.detalles.find(row => row.motivoExclusion === null)?.turnoId, 51);
  assert.equal(report.detalles.length, 100);
  assert.equal(report.detallesTruncados, true);
  assert.equal(statements.filter(sql => sql.startsWith("SELECT")).length, 3);
});

test("preflight rechaza URL insegura y tenant inválido antes de adquirir conexión", async () => {
  const db = { getConnection: async (): Promise<PoolConnection> => { assert.fail("no connection"); } };
  for (const frontendUrl of ["http://example.test", "https://example.test/?token=private", "https://user:pass@example.test", "invalid"]) {
    await assert.rejects(simularRecurrenciaPet({ localId: 1, frontendUrl }, db));
  }
  await assert.rejects(simularRecurrenciaPet({ localId: 0, frontendUrl: "https://example.test" }, db));
});

test("fallo de SELECT hace rollback; fallo de rollback destruye, no devuelve transacción al pool", async () => {
  for (const rollbackFails of [false, true]) {
    const calls: string[] = [];
    const connection = await pool.getConnection();
    const proxy = new Proxy(connection, { get(target, prop) {
      if (prop === "query") return async () => { calls.push("query"); if (calls.length > 1) throw new Error("read failed"); };
      if (prop === "rollback") return async () => { calls.push("rollback"); if (rollbackFails) throw new Error("rollback failed"); };
      if (prop === "destroy") return () => { calls.push("destroy"); target.destroy(); };
      if (prop === "release") return () => { calls.push("release"); target.release(); };
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(simularRecurrenciaPet({ localId: 1, frontendUrl: "https://example.test" },
      { getConnection: async () => proxy }, async () => new Date(now)));
    assert.deepEqual(calls.slice(-2), ["rollback", rollbackFails ? "destroy" : "release"]);
  }
});

test("SELECT real sobre esquema Docker existente: solo lectura y sin consentimiento implícito", async () => {
  // The new migration must NOT be applied in this task. This probe only uses the old schema.
  const report = await simularRecurrenciaPet({ localId: 2147483647, frontendUrl: "https://example.test",
    resolverAutorizacion: async () => null });
  assert.equal(report.simulacion, true);
  assert.equal(report.elegibles, 0);
  assert.equal(report.fuenteAutorizaciones, "inyectada");
});

test("fuente persistida: autorización exacta permite, baja/otro local/teléfono/titular excluyen", async () => {
  const data = escenario();
  data.pet_recurrencia_contactos.rows = [[1, phone, "autorizada", 10, "2026-11-01 12:00:00.000", "evidence-fixture"]];
  assert.equal((await simular(data)).report.elegibles, 1);
  data.pet_recurrencia_contactos.rows[0][2] = "baja";
  assert.equal((await simular(data)).report.exclusiones.BAJA, 1);
  data.pet_recurrencia_contactos.rows[0][0] = 2;
  assert.equal((await simular(data)).report.exclusiones.AUTORIZACION_PENDIENTE, 1);
  data.pet_recurrencia_contactos.rows[0] = [1, "+5491199999999", "autorizada", 10, "2026-11-01 12:00:00.000", "evidence-fixture"];
  assert.equal((await simular(data)).report.exclusiones.AUTORIZACION_PENDIENTE, 1);
  data.pet_recurrencia_contactos.rows[0][1] = phone;
  data.pet_recurrencia_contactos.rows[0][3] = 20;
  assert.equal((await simular(data)).report.exclusiones.AUTORIZACION_NO_VERIFICABLE, 1);
});

test("fuente persistida: la baja del número prevalece aunque el responsable haya sido recreado", async () => {
  const data = escenario();
  data.pet_recurrencia_contactos.rows = [[1, phone, "baja", 999, "2026-11-01 12:00:00.000", "evidence-fixture"]];
  assert.equal((await simular(data)).report.exclusiones.BAJA, 1);
});

test("CHECKs de la migración evaluados como SELECT: NULL parcial no concede permiso ni borra baja", async () => {
  // Executes only the actual CHECK expressions as SELECT, NOT CREATE TABLE/TRIGGER.
  const ddl = readFileSync(resolve(__dirname, "../../../../migrations/20261119_001_pet_recurrencia_contactos.sql"), "utf8");
  const names = ["telefono", "evidencia", "estado"];
  const expressions = names.map(name => {
    const match = ddl.match(new RegExp(`CONSTRAINT chk_pet_recurrencia_contacto_${name} CHECK \\(\\n([\\s\\S]*?)\\n  \\)`));
    assert.ok(match, `CHECK ${name}`);
    return `(${match[1]}) AS ${name}`;
  });
  const columns = ["telefono_normalizado", "estado", "cliente_id_autorizado", "verificada_at",
    "referencia_verificacion", "baja_at", "referencia_baja"];
  const cases: { values: Value[]; expected: number[] }[] = [
    { values: [phone, "autorizada", 10, "2026-11-01 12:00:00", "ref", null, null], expected: [1, 1, 1] },
    { values: [phone, "autorizada", null, "2026-11-01 12:00:00", "ref", null, null], expected: [1, 0, 0] },
    { values: [phone, "baja", null, null, null, "2026-11-02 12:00:00", "baja-ref"], expected: [1, 1, 1] },
    { values: [phone, "baja", 10, null, null, "2026-11-02 12:00:00", "baja-ref"], expected: [1, 0, 1] },
    { values: [phone, "baja", null, null, null, null, "baja-ref"], expected: [1, 1, 0] },
    { values: [phone, "autorizada", 10, "2026-11-01 12:00:00", "ref", "2026-11-02 12:00:00", "baja-ref"], expected: [1, 1, 0] },
    { values: ["invalid", "otro", null, null, null, null, null], expected: [0, 1, 0] },
  ];
  for (const item of cases) {
    const [rows] = await pool.query<(import("mysql2/promise").RowDataPacket & { telefono: number; evidencia: number; estado: number })[]>(
      `WITH fixture (${columns.join(", ")}) AS (SELECT ${columns.map(() => "?").join(", ")})
       SELECT ${expressions.join(", ")} FROM fixture`, item.values,
    );
    assert.deepEqual([rows[0].telefono, rows[0].evidencia, rows[0].estado], item.expected);
  }
});
