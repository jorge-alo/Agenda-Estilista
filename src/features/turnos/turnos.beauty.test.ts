import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../config/db";
import * as minutos from "../../helpers/sumarMinutos";
import * as horarios from "../../helpers/generarHorarios";
import { pagosService } from "../pagos/pagos.service";
import { createTurnoPublico } from "../public/public.service";
import { createTurno, getDisponibilidad, getDisponibilidadAdmin, reprogramarTurno } from "./turnos.service";

const locales: number[] = [];
const servicios: number[] = [];
const estilistas: number[] = [];
const turnos: number[] = [];
const slugs = Array.from({ length: 3 }, () => `m3b1-lectores-${randomUUID()}`);
const fecha = "2098-07-14";
const telefono = "1123456789";

async function insert(sql: string, values: unknown[]) {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

before(async () => {
  for (const [index, business] of ["BEAUTY", "BEAUTY", "PET_GROOMING"].entries()) {
    const localId = await insert(
      `INSERT INTO locales (nombre, slug, business_type, requiere_sena, activo, suscripcion_estado, suscripcion_vencimiento)
       VALUES (?, ?, ?, 0, 1, 'activo', '2099-12-31')`, ["Fixture M3B1 lectores", slugs[index], business]);
    locales.push(localId);
    servicios.push(await insert("INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)", ["M3B1 servicio", localId]));
    estilistas.push(await insert("INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)", ["M3B1 estilista", localId]));
    await pool.query("INSERT INTO horarios (estilista_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, '09:00', '12:00', 1)",
      [estilistas[index], new Date(2098, 6, 14).getDay()]);
  }
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.method(console, "log", () => {});
  turnos.length = 0;
  for (const [index, localId] of locales.entries()) {
    await pool.query("DELETE FROM turnos WHERE local_id = ?", [localId]);
    await pool.query("DELETE FROM clientes WHERE local_id = ?", [localId]);
    await pool.query("UPDATE servicios SET duracion = 30 WHERE id = ? AND local_id = ?", [servicios[index], localId]);
    turnos.push(await insert(
      `INSERT INTO turnos (fecha, hora, hora_fin, estilista_id, servicio_id, local_id, cliente_nombre, cliente_telefono, estado)
       VALUES (?, '09:00', '09:30', ?, ?, ?, 'Fixture M3B1', ?, 'activo')`,
      [fecha, estilistas[index], servicios[index], localId, telefono]));
  }
  // Debe conservarse ante cualquier rechazo de disponibilidad pública.
  await pool.query(
    `INSERT INTO turnos (fecha, hora, hora_fin, estilista_id, servicio_id, local_id, cliente_nombre, cliente_telefono, estado, created_at)
     VALUES (?, '11:30', '12:00', ?, ?, ?, 'Fixture M3B1 pendiente', ?, 'pendiente_pago', DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
    [fecha, estilistas[0], servicios[0], locales[0], telefono]);
});

after(async () => {
  try {
    for (const localId of locales) {
      await pool.query("DELETE FROM turnos WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM clientes WHERE local_id = ?", [localId]);
      await pool.query("DELETE h FROM horarios h JOIN estilistas e ON e.id = h.estilista_id WHERE e.local_id = ?", [localId]);
      await pool.query("DELETE FROM estilistas WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM servicios WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM locales WHERE id = ?", [localId]);
      assert.equal(rows[0].n, 0);
    }
  } finally { await pool.end(); }
});

function datos(servicioId: number, tenant: number) {
  return { fecha, hora: "10:00", estilista_id: estilistas[tenant], servicio_id: servicioId,
    local_id: locales[tenant], cliente_nombre: "Fixture M3B1 nuevo", cliente_telefono: telefono };
}

const lectores = [
  { nombre: "createTurno", run: (s: number, tenant = 0) => createTurno(datos(s, tenant)) },
  { nombre: "getDisponibilidad", run: (s: number, tenant = 0) => getDisponibilidad(slugs[tenant], fecha, estilistas[tenant], s) },
  { nombre: "getDisponibilidadAdmin", run: (s: number, tenant = 0) => getDisponibilidadAdmin(locales[tenant], fecha, estilistas[tenant], s) },
  { nombre: "reprogramarTurno", run: (s: number, tenant = 0) => reprogramarTurno({ ...datos(s, tenant), id: turnos[tenant] }) },
  { nombre: "createTurnoPublico", run: (s: number, tenant = 0) => createTurnoPublico({ ...datos(s, tenant), slug: slugs[tenant], local_id: locales[2] }) },
];

async function snapshot() {
  const result: unknown[] = [];
  for (const localId of locales) {
    for (const table of ["turnos", "clientes", "pagos"] as const) {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE local_id = ? ORDER BY id`, [localId]);
      result.push(rows);
    }
  }
  return result;
}

// La query SQL real se ejecuta; solo se simula su proyección corrupta (NULL no es
// persistible todavía). Los spies cubren cálculo, slots, pagos y todo SQL posterior.
function observar(t: TestContext, corrupt?: { duracion: unknown }) {
  const sqls: string[] = [];
  const transactions: string[] = [];
  const query = pool.query.bind(pool);
  t.mock.method(pool, "query", (async (sql: string, values?: unknown[]) => {
    sqls.push(sql);
    const [rows, fields] = await query(sql, values);
    if (corrupt && sql.includes("SELECT s.duracion")) {
      return [(rows as RowDataPacket[]).map(row => ({ ...row, duracion: corrupt.duracion })), fields];
    }
    return [rows, fields];
  }) as typeof pool.query);
  const getConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await getConnection();
    const begin = connection.beginTransaction.bind(connection);
    const commit = connection.commit.bind(connection);
    const rollback = connection.rollback.bind(connection);
    const release = connection.release.bind(connection);
    t.mock.method(connection, "beginTransaction", async () => { transactions.push("begin"); await begin(); });
    t.mock.method(connection, "commit", async () => { transactions.push("commit"); await commit(); });
    t.mock.method(connection, "rollback", async () => { transactions.push("rollback"); await rollback(); });
    t.mock.method(connection, "release", () => { transactions.push("release"); release(); });
    const connectionQuery = connection.query.bind(connection);
    t.mock.method(connection, "query", (async (sql: string, values?: unknown[]) => {
      sqls.push(sql);
      const [rows, fields] = await connectionQuery(sql, values);
      if (corrupt && sql.includes("SELECT s.duracion")) {
        return [(rows as RowDataPacket[]).map(row => ({ ...row, duracion: corrupt.duracion })), fields];
      }
      return [rows, fields];
    }) as typeof connection.query);
    return connection;
  });
  const sumar = t.mock.method(minutos, "sumarMinutos");
  const generar = t.mock.method(horarios, "generarHorarios");
  const pago = t.mock.method(pagosService, "crearPreference", async () => { throw new Error("Pago real prohibido en tests M3B1"); });
  return { sqls, sumar, generar, pago, transactions };
}

for (const lector of lectores) {
  test(`M.3B.1 ${lector.nombre}: servicio BEAUTY del tenant conserva happy path`, async t => {
    const watch = observar(t);
    const result: unknown = await lector.run(servicios[0]);
    if (lector.nombre.startsWith("getDisponibilidad")) {
      assert.ok(result && typeof result === "object" && "duracion" in result && "disponibles" in result);
      assert.equal(result.duracion, 30);
      assert.ok(Array.isArray(result.disponibles) && result.disponibles.includes("10:00"));
    } else {
      const [rows] = await pool.query<RowDataPacket[]>("SELECT hora, hora_fin, local_id FROM turnos WHERE local_id = ? AND hora = '10:00'", [locales[0]]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hora_fin, "10:30:00");
      assert.equal(rows[0].local_id, locales[0]);
      if (lector.nombre === "createTurnoPublico") {
        assert.ok(result && typeof result === "object" && "localId" in result && "mpLink" in result);
        assert.equal(result.localId, locales[0], "local_id del cliente no es autoridad pública");
        assert.equal(result.mpLink, null);
      } else assert.equal(typeof result, "number");
    }
    assert.equal(watch.pago.mock.callCount(), 0);
    if (lector.nombre.startsWith("getDisponibilidad")) {
      assert.deepEqual(watch.transactions, []);
    } else {
      assert.deepEqual(watch.transactions, ["begin", "commit", "release"]);
      assert.ok(watch.sqls.some(sql => /FROM turnos/.test(sql) && /FOR UPDATE/.test(sql)));
      if (lector.nombre === "reprogramarTurno") {
        assert.ok(watch.sqls.some(sql => /WHERE id = \? AND local_id = \? FOR UPDATE/.test(sql)));
      }
    }
  });

  for (const caso of ["otro tenant", "servicio PET", "inexistente", "local PET"] as const) {
    test(`M.3B.1 ${lector.nombre}: rechaza ${caso} antes de cálculos/escrituras/pagos`, async t => {
      const previo = await snapshot();
      const watch = observar(t);
      const servicioId = caso === "otro tenant" ? servicios[1] : caso === "inexistente" ? 2147483647 : servicios[2];
      await assert.rejects(lector.run(servicioId, caso === "local PET" ? 2 : 0), /Servicio no encontrado|Local no encontrado/);
      assert.equal(watch.sumar.mock.callCount(), 0);
      assert.equal(watch.generar.mock.callCount(), 0);
      assert.equal(watch.pago.mock.callCount(), 0);
      assert.deepEqual(watch.transactions, lector.nombre.startsWith("getDisponibilidad") ? [] : ["begin", "rollback", "release"]);
      assert.ok(watch.sqls.every(sql => /^SELECT\b/i.test(sql.trim())));
      const lectura = watch.sqls.find(sql => sql.includes("SELECT s.duracion"));
      if (caso !== "local PET" || !lector.nombre.endsWith("Publico") && lector.nombre !== "getDisponibilidad") {
        assert.ok(lectura);
        assert.match(lectura, /s\.id = \? AND s\.local_id = \?/);
        assert.match(lectura, /l\.business_type = 'BEAUTY'/);
      }
      assert.deepEqual(await snapshot(), previo);
    });
  }

  for (const duracion of [null, 0, -1, 1.5, "30", NaN, Infinity, 2147483648]) {
    test(`M.3B.1 ${lector.nombre}: duración corrupta ${String(duracion)} se rechaza antes de efectos`, async t => {
      const previo = await snapshot();
      const watch = observar(t, { duracion });
      await assert.rejects(lector.run(servicios[0]), /Servicio no encontrado/);
      assert.equal(watch.sumar.mock.callCount(), 0);
      assert.equal(watch.generar.mock.callCount(), 0);
      assert.equal(watch.pago.mock.callCount(), 0);
      assert.deepEqual(watch.transactions, lector.nombre.startsWith("getDisponibilidad") ? [] : ["begin", "rollback", "release"]);
      assert.ok(watch.sqls.every(sql => /^SELECT\b/i.test(sql.trim())), "No limpiar pendientes ni escribir con duración inválida");
      assert.deepEqual(await snapshot(), previo);
    });
  }
}

test("M.3B.1 disponibilidad válida mantiene limpieza y su orden antes de leer ocupación", async t => {
  const watch = observar(t);
  await getDisponibilidad(slugs[0], fecha, estilistas[0], servicios[0]);
  const servicioIndex = watch.sqls.findIndex(sql => sql.includes("SELECT s.duracion"));
  const limpiezaIndex = watch.sqls.findIndex(sql => /UPDATE turnos/.test(sql));
  const ocupacionIndex = watch.sqls.findIndex(sql => /SELECT hora, hora_fin/.test(sql));
  assert.ok(servicioIndex >= 0 && limpiezaIndex > servicioIndex && ocupacionIndex > limpiezaIndex);
  assert.match(watch.sqls[limpiezaIndex], /created_at <= DATE_SUB\(NOW\(\), INTERVAL 15 MINUTE\)/);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT estado FROM turnos WHERE local_id = ? AND hora = '11:30'", [locales[0]]);
  assert.equal(rows[0].estado, "cancelado");
});

for (const lector of lectores.filter(l => ["createTurno", "reprogramarTurno", "createTurnoPublico"].includes(l.nombre))) {
  test(`M.3B.1 ${lector.nombre}: conserva rechazo por solapamiento y rollback`, async t => {
    const previo = await snapshot();
    const pago = t.mock.method(pagosService, "crearPreference", async () => { throw new Error("Pago real prohibido"); });
    const ocupado = await insert(
      `INSERT INTO turnos (fecha, hora, hora_fin, estilista_id, servicio_id, local_id, cliente_nombre, cliente_telefono, estado)
       VALUES (?, '10:15', '10:45', ?, ?, ?, 'Fixture M3B1 overlap', ?, 'activo')`,
      [fecha, estilistas[0], servicios[0], locales[0], telefono]);
    await assert.rejects(lector.run(servicios[0]), /Ese horario ya está ocupado/);
    assert.equal(pago.mock.callCount(), 0);
    await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [ocupado, locales[0]]);
    assert.deepEqual(await snapshot(), previo);
  });
}
