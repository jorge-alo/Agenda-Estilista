import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, test, type TestContext } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import express from "express";
import jwt from "jsonwebtoken";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import petRouter from "../pet.routes";
import { editarMascota, editarReservaOnline, desasociarResponsable } from "./mascotas.service";
import { editarServicio, quitarConfiguracion } from "../servicios/servicios.service";
import { guardar } from "../settings/settings.service";
import { assertNoMascotaFixtures, cleanupMascotaFixture } from "./mascotas.test-fixtures";

const secret = "PET_M6B_FICTITIOUS_TEST_KEY";
const prefix = `pet-m6b-${randomUUID()}`;
const fixtureIds: number[] = [];
let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/pet/admin`;
});
after(async t => {
  try {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM locales WHERE slug LIKE ?", [`${prefix}%`]);
    assert.equal(rows.length, 0, "Todos los fixtures M.6B deben haberse limpiado por sus tests");
    await assertNoMascotaFixtures(fixtureIds);
    if ("diagnostic" in t) t.diagnostic(`M.6B cleanup read-only PASS; familia ${prefix}; locales ${fixtureIds.join(",")}; residuos 0`);
  } finally { await pool.end(); }
});

async function fixture(t: TestContext, options: {
  responsable?: boolean; canonical?: string | null; servicio?: boolean; activoServicio?: number | null;
  activa?: boolean; online?: boolean; alta?: boolean; settings?: "MIN_GAP" | "MAX_PER_DAY";
} = {}) {
  t.mock.property(process, "env", { JWT_SECRET: secret });
  const slug = `${prefix}-${randomUUID()}`;
  const [local] = await pool.query<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')", [prefix, slug],
  );
  const localId = local.insertId;
  fixtureIds.push(localId);
  t.after(() => cleanupMascotaFixture(localId, slug));
  const [mascota] = await pool.query<ResultSetHeader>(
    "INSERT INTO mascotas (local_id, nombre, activo, reserva_online_habilitada, alta_exigencia) VALUES (?, 'M6B', ?, ?, ?)",
    [localId, Number(options.activa !== false), Number(options.online === true), Number(options.alta === true)],
  );
  const mascotaId = mascota.insertId;
  let clienteId = 0; let servicioId = 0;
  if (options.responsable !== false) {
    const [cliente] = await pool.query<ResultSetHeader>(
      "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, 'M6B responsable', '1123456700', ?)",
      [localId, options.canonical === undefined ? normalizeClientPhone("1123456700") : options.canonical],
    );
    clienteId = cliente.insertId;
    await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [localId, mascotaId, clienteId]);
  }
  if (options.servicio !== false) {
    const [servicio] = await pool.query<ResultSetHeader>(
      "INSERT INTO servicios (local_id, nombre, duracion, precio, activo) VALUES (?, 'M6B servicio', NULL, NULL, ?)",
      [localId, options.activoServicio === undefined ? 1 : options.activoServicio],
    );
    servicioId = servicio.insertId;
    await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)", [localId, mascotaId, servicioId]);
  }
  if (options.settings) await guardar(localId, options.settings === "MIN_GAP"
    ? { highDemandRule: "MIN_GAP", highDemandGapMinutes: 30, highDemandMaxPerDay: null }
    : { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 1 });
  const token = jwt.sign({ userId: 1, localId, rol: "admin" }, secret, { expiresIn: "5m" });
  return {
    localId, mascotaId, clienteId, servicioId,
    patch: async (body: unknown, online = true) => {
      const response = await fetch(`${base}/mascotas/${mascotaId}${online ? "/reserva-online" : ""}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    state: async () => (await pool.query<RowDataPacket[]>(
      "SELECT nombre, activo, alta_exigencia, reserva_online_habilitada FROM mascotas WHERE id = ? AND local_id = ?", [mascotaId, localId],
    ))[0][0],
  };
}

for (const [label, options, code] of [
  ["inactiva", { activa: false }, "PET_MASCOTA_INACTIVE"],
  ["sin responsable", { responsable: false }, "PET_ONLINE_REQUIRES_RESPONSIBLE"],
  ["canonical NULL aunque display válido", { canonical: null }, "PET_ONLINE_REQUIRES_RESPONSIBLE"],
  ["canonical inválido", { canonical: "+123" }, "PET_ONLINE_REQUIRES_RESPONSIBLE"],
  ["teléfono no canónico", { canonical: "1123456700" }, "PET_ONLINE_REQUIRES_RESPONSIBLE"],
  ["sin servicio", { servicio: false }, "PET_ONLINE_REQUIRES_SERVICE"],
  ["servicio inactivo", { activoServicio: 0 }, "PET_ONLINE_REQUIRES_SERVICE"],
  ["servicio NULL legacy", { activoServicio: null }, "PET_ONLINE_REQUIRES_SERVICE"],
  ["alta exigencia sin settings", { alta: true }, "PET_ONLINE_REQUIRES_HIGH_DEMAND_SETTINGS"],
] as const) {
  test(`M.6B enable ${label}: 409 de dominio y flag intacto`, async t => {
    const f = await fixture(t, options); const before = await f.state();
    assert.deepEqual(await f.patch({ reservaOnlineHabilitada: true }), { status: 409, body: { error: code } });
    assert.deepEqual(await f.state(), before);
  });
}

for (const settings of [undefined, "MIN_GAP", "MAX_PER_DAY"] as const) {
  test(`M.6B enable válido ${settings ?? "normal sin settings"}, sin extras/horarios; idempotente`, async t => {
    const f = await fixture(t, { alta: settings !== undefined, settings });
    for (let i = 0; i < 2; i++) assert.deepEqual(await f.patch({ reservaOnlineHabilitada: true }), {
      status: 200, body: { id: f.mascotaId, reservaOnlineHabilitada: true },
    });
    assert.equal((await f.state()).reserva_online_habilitada, 1);
  });
}

test("M.6B basta un responsable utilizable y un servicio elegible entre otros inválidos", async t => {
  const f = await fixture(t, { canonical: null, activoServicio: 0 });
  const [cliente] = await pool.query<ResultSetHeader>(
    "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, 'Válido', '1123456701', ?)", [f.localId, normalizeClientPhone("1123456701")],
  );
  await pool.query("INSERT INTO mascota_clientes VALUES (?, ?, ?)", [f.localId, f.mascotaId, cliente.insertId]);
  const [servicio] = await pool.query<ResultSetHeader>(
    "INSERT INTO servicios (local_id, nombre, activo) VALUES (?, 'Válido', 1)", [f.localId],
  );
  await pool.query("INSERT INTO mascota_servicios VALUES (?, ?, ?, 45)", [f.localId, f.mascotaId, servicio.insertId]);
  assert.equal((await f.patch({ reservaOnlineHabilitada: true })).status, 200);
});

test("M.6B servicio del catálogo no asignado no habilita", async t => {
  const f = await fixture(t);
  await quitarConfiguracion(f.localId, f.mascotaId, f.servicioId);
  assert.deepEqual(await f.patch({ reservaOnlineHabilitada: true }), { status: 409, body: { error: "PET_ONLINE_REQUIRES_SERVICE" } });
});

// CHECK/NOT NULL prevent corrupt stored durations/settings. Inject only the read
// result AFTER its real lock; never disable constraints or persist invalid rows.
async function corruptRead(t: TestContext, fragment: string, replacement: Record<string, unknown>) {
  const get = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get(); const query = connection.query.bind(connection);
    t.mock.method(connection, "query", async (...args: Parameters<PoolConnection["query"]>) => {
      const result = await query(...args);
      return String(args[0]).includes(fragment) ? [[replacement], result[1]] : result;
    });
    return connection;
  });
}
for (const duration of [null, 0, -1, 1.5, 2147483648]) {
  test(`M.6B duración almacenada inválida ${duration}: rechazo sin corromper DB`, async t => {
    const f = await fixture(t);
    await corruptRead(t, "SELECT duracion_minutos FROM mascota_servicios", { duracion_minutos: duration });
    assert.deepEqual(await f.patch({ reservaOnlineHabilitada: true }), { status: 409, body: { error: "PET_ONLINE_REQUIRES_SERVICE" } });
    assert.equal((await f.state()).reserva_online_habilitada, 0);
  });
}
for (const row of [
  { high_demand_rule: "MIN_GAP", high_demand_gap_minutes: 0, high_demand_max_per_day: null },
  { high_demand_rule: "MIN_GAP", high_demand_gap_minutes: 30, high_demand_max_per_day: 1 },
  { high_demand_rule: "MAX_PER_DAY", high_demand_gap_minutes: null, high_demand_max_per_day: null },
  { high_demand_rule: "MAX_PER_DAY", high_demand_gap_minutes: null, high_demand_max_per_day: 2 },
  { high_demand_rule: "MAX_PER_DAY", high_demand_gap_minutes: 1, high_demand_max_per_day: 2 },
  { high_demand_rule: "UNKNOWN", high_demand_gap_minutes: null, high_demand_max_per_day: 2 },
]) {
  test(`M.6B settings inválidos ${JSON.stringify(row)}: 409 recuperable`, async t => {
    const f = await fixture(t, { alta: true, settings: "MIN_GAP" });
    await corruptRead(t, "SELECT high_demand_rule, high_demand_gap_minutes", row);
    assert.deepEqual(await f.patch({ reservaOnlineHabilitada: true }), { status: 409, body: { error: "PET_ONLINE_REQUIRES_HIGH_DEMAND_SETTINGS" } });
  });
}

test("M.6B disable inactiva/alta exigencia sin dependencias; idempotente", async t => {
  const f = await fixture(t, { activa: false, online: true, alta: true, responsable: false, servicio: false });
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.patch({ reservaOnlineHabilitada: false }), {
    status: 200, body: { id: f.mascotaId, reservaOnlineHabilitada: false },
  });
  assert.equal((await f.state()).activo, 0);
});

for (const [options, code] of [
  [{ responsable: false }, "PET_ONLINE_REQUIRES_RESPONSIBLE"],
  [{ servicio: false }, "PET_ONLINE_REQUIRES_SERVICE"],
  [{ alta: true }, "PET_ONLINE_REQUIRES_HIGH_DEMAND_SETTINGS"],
] as const) {
  test(`M.6B reactivar online rechaza ${code} y rollback de todo el PATCH`, async t => {
    const f = await fixture(t, { activa: false, online: true, ...options }); const before = await f.state();
    assert.deepEqual(await f.patch({ activo: true, nombre: "NO persistir" }, false), { status: 409, body: { error: code } });
    assert.deepEqual(await f.state(), before);
  });
}
test("M.6B reactivación online válida considera altaExigencia resultante", async t => {
  const f = await fixture(t, { activa: false, online: true }); const before = await f.state();
  assert.equal((await f.patch({ activo: true, altaExigencia: true, nombre: "NO" }, false)).status, 409);
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.patch({ activo: true }, false)).status, 200);
  assert.deepEqual(await f.state(), { ...before, activo: 1 });
});
test("M.6B sin reactivación efectiva no revalida/auto-disable; online=false reactiva sin dependencias", async t => {
  const f = await fixture(t, { online: true, responsable: false, servicio: false });
  assert.equal((await f.patch({ activo: true, altaExigencia: true }, false)).status, 200);
  assert.equal((await f.state()).reserva_online_habilitada, 1);
  assert.equal((await f.patch({ activo: false }, false)).status, 200);
  assert.equal((await f.state()).reserva_online_habilitada, 1);
  assert.equal((await f.patch({ reservaOnlineHabilitada: false })).status, 200);
  assert.equal((await f.patch({ activo: true }, false)).status, 200);
  assert.equal((await f.state()).reserva_online_habilitada, 0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function waitForLock(holder: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
       JOIN performance_schema.threads th ON th.THREAD_ID = w.BLOCKING_THREAD_ID
       WHERE th.PROCESSLIST_ID = ?`, [holder],
    );
    if (Number(rows[0].total) > 0) return;
    await nextTick();
  }
  throw new Error("M.6B: el competidor no llegó a esperar el lock InnoDB");
}

for (const kind of ["desactivar", "desasociar", "inactivarServicio", "quitarServicio", "deleteServicioLegacy"] as const) {
  for (const enableFirst of [true, false]) {
    test(`M.6B carrera enable vs ${kind}, primero ${enableFirst ? "enable" : "writer"}`, { timeout: 20000 }, async t => {
      const f = await fixture(t); const ready = deferred(); const release = deferred();
      let holderId = 0; let gated = false; let secondDone = false;
      const get = pool.getConnection.bind(pool);
      // Hold the first operation after its real locks/write, immediately before
      // commit. The second must be observed waiting in InnoDB, not via sleep.
      t.mock.method(pool, "getConnection", async () => {
        const connection = await get();
        if (!gated) {
          gated = true;
          const [ids] = await connection.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id"); holderId = Number(ids[0].id);
          const commit = connection.commit.bind(connection);
          t.mock.method(connection, "commit", async () => { ready.resolve(); await release.promise; return commit(); });
        }
        return connection;
      });
      const enable = () => editarReservaOnline(f.localId, f.mascotaId, { reservaOnlineHabilitada: true });
      const writer = async () => {
        if (kind === "desactivar") return editarMascota(f.localId, f.mascotaId, { activo: false });
        if (kind === "inactivarServicio") return editarServicio(f.localId, f.servicioId, { activo: false });
        if (kind === "quitarServicio") return quitarConfiguracion(f.localId, f.mascotaId, f.servicioId);
        if (enableFirst) {
          // Actual single-statement writers (no local lock): parent/link SHARE
          // locks alone must synchronize them with enable.
          if (kind === "desasociar") return desasociarResponsable(f.localId, f.mascotaId, f.clienteId);
          return pool.query("DELETE FROM servicios WHERE id = ? AND local_id = ?", [f.servicioId, f.localId]);
        }
        // Same autocommit statement held open for deterministic writer-first
        // ordering; no additional locks are acquired by the fixture.
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          if (kind === "desasociar") await connection.query("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [f.mascotaId, f.clienteId, f.localId]);
          else await connection.query("DELETE FROM servicios WHERE id = ? AND local_id = ?", [f.servicioId, f.localId]);
          await connection.commit();
        } catch (error: unknown) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      };
      const settle = (work: Promise<unknown>) => work.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
      const first = settle(enableFirst ? enable() : writer());
      let second: ReturnType<typeof settle> | undefined;
      try {
        await ready.promise;
        second = settle(enableFirst ? writer() : enable()).then(result => { secondDone = true; return result; });
        await waitForLock(holderId); assert.equal(secondDone, false);
      } finally { release.resolve(); await first; if (second) await second; }
      const a = await first; assert.equal(a.error, null);
      assert.ok(second); const b = await second;
      if (enableFirst) {
        assert.equal(b.error, null);
        assert.equal((await f.state()).reserva_online_habilitada, 1, "El cambio posterior no hace auto-disable");
      } else {
        const code = kind === "desactivar" ? "PET_MASCOTA_INACTIVE" : kind === "desasociar" ? "PET_ONLINE_REQUIRES_RESPONSIBLE" : "PET_ONLINE_REQUIRES_SERVICE";
        assert.ok(b.error instanceof Error && "code" in b.error); assert.equal(b.error.code, code);
        assert.equal((await f.state()).reserva_online_habilitada, 0);
      }
    });
  }
}
