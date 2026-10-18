import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import {
  FECHA, SIGUIENTE, admin, body, counts, deferred, fixture, highDemand, horario, instrument, logout,
  pool, post, q, record, rejected, session, sessionState, useBookingHarness, waitForExpiry, waitForLock, watchdog,
  type ApiResult, type Fixture,
} from "./publicBooking.turnos.test-support";

useBookingHarness();
const isLocalLock = (sql: string) => /^SELECT id, business_type(?:,.*)? FROM locales WHERE id = \? FOR UPDATE$/.test(sql);

async function anotherOwner(f: Fixture): Promise<Fixture> {
  const client = await q<ResultSetHeader>("INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, 'PET12E Bea', '1123452001')", [f.localId]);
  const pet = await q<ResultSetHeader>("INSERT INTO mascotas (local_id, nombre, activo, reserva_online_habilitada) VALUES (?, 'PET12E Luna', 1, 1)", [f.localId]);
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [f.localId, pet.insertId, client.insertId]);
  await q("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 60)", [f.localId, pet.insertId, f.servicioId]);
  return { ...f, clienteId: client.insertId, mascotaId: pet.insertId, ...await session(f.localId, client.insertId) };
}

/** Retain A's REAL local lock; B must be observed waiting in InnoDB, not just launched. */
async function race(
  t: TestContext,
  f: Fixture,
  first: () => Promise<ApiResult>,
  second: () => Promise<ApiResult>,
  options: { independent?: boolean; failFirstExtra?: boolean } = {},
): Promise<[ApiResult, ApiResult]> {
  const firstLocked = deferred<number>();
  const secondAttempt = deferred<number>();
  const release = deferred();
  let firstConnection: PoolConnection | undefined;
  let secondAcquired = false;
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const sql = String(args[0]);
      if (isLocalLock(sql)) {
        if (!firstConnection) {
          firstConnection = conn;
          return query(...args).then(async result => { firstLocked.resolve(conn.threadId); await release.promise; return result; });
        }
        secondAttempt.resolve(conn.threadId);
        return query(...args).then(result => { secondAcquired = true; return result; });
      }
      if (options.failFirstExtra && conn === firstConnection && sql.includes("INSERT INTO turno_extras")) throw new Error("PET12E_FORCED_ROLLBACK");
      return query(...args);
    }) as typeof conn.query);
  });
  const a = first();
  let b: Promise<ApiResult> | undefined;
  try {
    const blocker = await watchdog(firstLocked.promise);
    b = second();
    const requester = await watchdog(secondAttempt.promise);
    if (options.independent) {
      assert.equal((await watchdog(b)).status, 201);
      assert.equal(secondAcquired, true);
    } else {
      await waitForLock(blocker, requester, "locales");
      assert.equal(secondAcquired, false);
    }
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 }, "A mantiene su transacción sin filas visibles");
  } finally {
    release.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
  assert.ok(b);
  return Promise.all([a, b]);
}

test("PET-12E público vs público: dos responsables/sesiones compiten por el mismo slot", { timeout: 30000 }, async t => {
  const f = await fixture();
  const other = await anotherOwner(f);
  const [a, b] = await race(t, f, () => post(f), () => post(other));
  assert.equal(a.status, 201);
  rejected(b, 409, "PET_SLOT_UNAVAILABLE");
  assert.deepEqual(await counts(f), { turnos: 1, extras: 0 });
});

for (const adminFirst of [true, false]) {
  test(`PET-12E ${adminFirst ? "admin→público" : "público→admin"}: mismo slot, una reserva`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const [a, b] = await race(t, f, adminFirst ? () => admin(f) : () => post(f), adminFirst ? () => post(f) : () => admin(f));
    assert.equal(a.status, 201);
    assert.equal(b.status, 409);
    if (adminFirst) rejected(b, 409, "PET_SLOT_UNAVAILABLE");
    else assert.equal(record(b).code, "PET_SLOT_UNAVAILABLE");
    assert.deepEqual(await counts(f), { turnos: 1, extras: 0 });
  });
}

test("PET-12E doble request idéntico: 201/409 sin registro de idempotencia", { timeout: 30000 }, async t => {
  const f = await fixture();
  const [a, b] = await race(t, f, () => post(f), () => post(f));
  assert.equal(a.status, 201);
  rejected(b, 409, "PET_SLOT_UNAVAILABLE");
  assert.equal((await counts(f)).turnos, 1);
});

for (const adjacent of [false, true]) {
  test(`PET-12E intervalos ${adjacent ? "adyacentes confirman ambos" : "solapados con distinto inicio no duplican"}`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const other = await anotherOwner(f);
    const [a, b] = await race(t, f, () => post(f), () => post(other, body(other, { hora: adjacent ? "11:00" : "10:30" })));
    assert.equal(a.status, 201);
    if (adjacent) assert.equal(b.status, 201);
    else rejected(b, 409, "PET_SLOT_UNAVAILABLE");
    assert.equal((await counts(f)).turnos, adjacent ? 2 : 1);
  });
}

for (const laterFirst of [false, true]) {
  test(`PET-12E MIN_GAP interfecha: ${laterFirst ? "fecha posterior" : "fecha anterior"} gana primero`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const other = await anotherOwner(f);
    await highDemand(f, "MIN_GAP", 300);
    await q("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [other.mascotaId, f.localId]);
    await horario(f.localId, FECHA, "20:00", "23:00");
    await horario(f.localId, SIGUIENTE, "00:00", "02:00");
    const earlier = () => post(f, body(f, { hora: "21:00" }));
    const later = () => post(other, body(other, { fecha: SIGUIENTE, hora: "00:30" }));
    const [a, b] = await race(t, f, laterFirst ? later : earlier, laterFirst ? earlier : later);
    assert.equal(a.status, 201);
    rejected(b, 409, "PET_SLOT_UNAVAILABLE");
    assert.equal((await counts(f)).turnos, 1);
  });
}

test("PET-12E MAX_PER_DAY serializa aunque los slots no se solapen", { timeout: 30000 }, async t => {
  const f = await fixture();
  const other = await anotherOwner(f);
  await highDemand(f, "MAX_PER_DAY", 1);
  await q("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [other.mascotaId, f.localId]);
  const [a, b] = await race(t, f, () => post(f), () => post(other, body(other, { hora: "12:00" })));
  assert.equal(a.status, 201);
  rejected(b, 409, "PET_SLOT_UNAVAILABLE");
});

test("PET-12E distintos locales confirman independientemente bajo locks", { timeout: 30000 }, async t => {
  const f = await fixture();
  const other = await fixture();
  const [a, b] = await race(t, f, () => post(f), () => post(other), { independent: true });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal((await counts(f)).turnos, 1);
  assert.equal((await counts(other)).turnos, 1);
});

test("PET-12E rollback A libera B: sin turno/extra parcial y B puede reservar", { timeout: 30000 }, async t => {
  const f = await fixture();
  const before = await sessionState(f);
  const [a, b] = await race(t, f, () => post(f, body(f, { extraIds: f.extraIds })), () => post(f), { failFirstExtra: true });
  rejected(a, 500, "INTERNAL_SERVER_ERROR");
  assert.equal(b.status, 201);
  assert.deepEqual(await counts(f), { turnos: 1, extras: 0 });
  assert.deepEqual(await sessionState(f), before);
});

test("PET-12E logout confirma mientras booking espera local: revalidación rechaza", { timeout: 30000 }, async t => {
  const f = await fixture();
  const holder = await pool.getConnection();
  const attempted = deferred<number>();
  let pending: Promise<ApiResult> | undefined;
  try {
    await holder.beginTransaction();
    await holder.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [f.localId]);
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        if (isLocalLock(String(args[0]))) attempted.resolve(conn.threadId);
        return query(...args);
      }) as typeof conn.query);
    });
    pending = post(f);
    await waitForLock(holder.threadId, await watchdog(attempted.promise), "locales");
    assert.equal((await watchdog(logout(f))).status, 204, "logout no espera el lock local");
  } finally {
    try { await holder.rollback(); } finally { holder.release(); }
    if (pending) await Promise.allSettled([pending]);
  }
  assert.ok(pending);
  rejected(await pending, 401, "PET_SESSION_INVALID");
  assert.equal((await counts(f)).turnos, 0);
});

test("PET-12E logout obtiene X de sesión primero; booking espera y luego ve revocación", { timeout: 30000 }, async t => {
  const f = await fixture();
  const holder = await pool.getConnection();
  const locked = deferred();
  const release = deferred();
  const bookingAttempt = deferred<number>();
  const poolQuery = pool.query.bind(pool);
  let booking: Promise<ApiResult> | undefined;
  let loggingOut: Promise<ApiResult> | undefined;
  try {
    await holder.beginTransaction();
    // Execute the actual logout UPDATE in a retained transaction so its X lock
    // is observable before autocommit would normally finish. No production change.
    t.mock.method(pool, "query", (async (...args: Parameters<typeof pool.query>) => {
      if (String(args[0]).includes("UPDATE pet_client_sessions")) {
        const result = await holder.query(...args);
        locked.resolve();
        await release.promise;
        await holder.commit();
        return result;
      }
      return poolQuery(...args);
    }) as typeof pool.query);
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        if (String(args[0]).startsWith("SELECT id, revoked_at FROM pet_client_sessions")) bookingAttempt.resolve(conn.threadId);
        return query(...args);
      }) as typeof conn.query);
    });
    loggingOut = logout(f);
    await watchdog(locked.promise);
    booking = post(f);
    await waitForLock(holder.threadId, await watchdog(bookingAttempt.promise), "pet_client_sessions");
  } finally {
    release.resolve();
    await Promise.allSettled([...(booking ? [booking] : []), ...(loggingOut ? [loggingOut] : [])]);
    try { await holder.rollback(); } finally { holder.release(); }
  }
  assert.ok(booking !== undefined && loggingOut !== undefined);
  assert.equal((await loggingOut).status, 204);
  rejected(await booking, 401, "PET_SESSION_INVALID");
  assert.equal((await counts(f)).turnos, 0);
});

test("PET-12E booking obtiene SHARE primero: logout espera hasta commit y después revoca", { timeout: 30000 }, async t => {
  const f = await fixture();
  const locked = deferred<number>();
  const release = deferred();
  let logoutFinished = false;
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(async result => {
      if (String(args[0]).startsWith("SELECT id, revoked_at FROM pet_client_sessions")) {
        locked.resolve(conn.threadId);
        await release.promise;
      }
      return result;
    })) as typeof conn.query);
  });
  const booking = post(f);
  let loggingOut: Promise<ApiResult> | undefined;
  try {
    const blocker = await watchdog(locked.promise);
    loggingOut = logout(f);
    void loggingOut.then(() => { logoutFinished = true; });
    await waitForLock(blocker, null, "pet_client_sessions");
    assert.equal(logoutFinished, false);
  } finally {
    release.resolve();
    await Promise.allSettled([booking, ...(loggingOut ? [loggingOut] : [])]);
  }
  assert.ok(loggingOut);
  assert.equal((await booking).status, 201);
  assert.equal((await loggingOut).status, 204);
  assert.notEqual((await sessionState(f)).revoked, null);
});

for (const resource of ["locales", "pet_client_sessions", "servicios"] as const) {
  test(`PET-12E sesión expira esperando ${resource}: tiempo DB después del lock`, { timeout: 30000 }, async t => {
    const base = await fixture();
    const f = { ...base, ...await session(base.localId, base.clienteId, 5) };
    const before = await sessionState(f);
    const holder = await pool.getConnection();
    const attempted = deferred<number>();
    let pending: Promise<ApiResult> | undefined;
    try {
      await holder.beginTransaction();
      const [table, id] = resource === "locales" ? [resource, f.localId] : resource === "pet_client_sessions" ? [resource, f.sessionId] : [resource, f.servicioId];
      // Identifiers come only from the fixed test matrix, never request data.
      await holder.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
      instrument(t, conn => {
        const query = conn.query.bind(conn);
        t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
          const sql = String(args[0]);
          if ((resource === "locales" && isLocalLock(sql))
            || (resource === "pet_client_sessions" && sql.startsWith("SELECT id, revoked_at FROM pet_client_sessions"))
            || (resource === "servicios" && sql === "SELECT id FROM servicios WHERE id = ? AND local_id = ? FOR SHARE")) attempted.resolve(conn.threadId);
          return query(...args);
        }) as typeof conn.query);
      });
      pending = post(f);
      await waitForLock(holder.threadId, await watchdog(attempted.promise), resource);
      await waitForExpiry(f);
    } finally {
      try { await holder.rollback(); } finally { holder.release(); }
      if (pending) await Promise.allSettled([pending]);
    }
    assert.ok(pending);
    rejected(await pending, 401, "PET_SESSION_INVALID");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
    assert.deepEqual(await sessionState(f), before);
  });
}

interface Mutation { name: string; sql: string; values: (f: Fixture) => unknown[]; status: number; error?: string; fin?: string }
const mutations: Mutation[] = [
  { name: "online false", sql: "UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", values: f => [f.mascotaId, f.localId], status: 404, error: "PET_MASCOTA_UNAVAILABLE" },
  { name: "mascota inactiva", sql: "UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", values: f => [f.mascotaId, f.localId], status: 404, error: "PET_MASCOTA_UNAVAILABLE" },
  { name: "vínculo eliminado", sql: "DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", values: f => [f.mascotaId, f.clienteId, f.localId], status: 404, error: "PET_MASCOTA_UNAVAILABLE" },
  { name: "servicio inactivo", sql: "UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", values: f => [f.servicioId, f.localId], status: 404, error: "PET_SERVICE_UNAVAILABLE" },
  { name: "mascota_servicio eliminado", sql: "DELETE FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? AND local_id = ?", values: f => [f.mascotaId, f.servicioId, f.localId], status: 404, error: "PET_SERVICE_UNAVAILABLE" },
  { name: "extra inactivo", sql: "UPDATE extras SET activo = 0 WHERE id = ? AND local_id = ?", values: f => [f.extraIds[0], f.localId], status: 404, error: "PET_EXTRA_UNAVAILABLE" },
  { name: "extra eliminado", sql: "DELETE FROM extras WHERE id = ? AND local_id = ?", values: f => [f.extraIds[0], f.localId], status: 404, error: "PET_EXTRA_UNAVAILABLE" },
  { name: "mascota_extra eliminado", sql: "DELETE FROM mascota_extras WHERE mascota_id = ? AND extra_id = ? AND local_id = ?", values: f => [f.mascotaId, f.extraIds[0], f.localId], status: 404, error: "PET_EXTRA_UNAVAILABLE" },
  { name: "duración servicio cambia", sql: "UPDATE mascota_servicios SET duracion_minutos = 90 WHERE mascota_id = ? AND servicio_id = ? AND local_id = ?", values: f => [f.mascotaId, f.servicioId, f.localId], status: 201, fin: "11:45" },
  { name: "duración extra cambia", sql: "UPDATE mascota_extras SET duracion_minutos = 30 WHERE mascota_id = ? AND extra_id = ? AND local_id = ?", values: f => [f.mascotaId, f.extraIds[0], f.localId], status: 201, fin: "11:30" },
  { name: "local inactivo", sql: "UPDATE locales SET activo = 0 WHERE id = ?", values: f => [f.localId], status: 401, error: "PET_SESSION_INVALID" },
  { name: "local cambia tipo", sql: "UPDATE locales SET business_type = 'BEAUTY' WHERE id = ?", values: f => [f.localId], status: 401, error: "PET_SESSION_INVALID" },
  { name: "local cambia slug", sql: "UPDATE locales SET slug = CONCAT(slug, '-changed') WHERE id = ?", values: f => [f.localId], status: 401, error: "PET_SESSION_INVALID" },
];

for (const change of mutations) {
  test(`PET-12E espera local y revalida ${change.name}`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const holder = await pool.getConnection();
    const attempted = deferred<number>();
    let pending: Promise<ApiResult> | undefined;
    try {
      await holder.beginTransaction();
      await holder.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [f.localId]);
      instrument(t, conn => {
        const query = conn.query.bind(conn);
        t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
          if (isLocalLock(String(args[0]))) attempted.resolve(conn.threadId);
          return query(...args);
        }) as typeof conn.query);
      });
      pending = post(f, body(f, { extraIds: [f.extraIds[0]] }));
      await waitForLock(holder.threadId, await watchdog(attempted.promise), "locales");
      await holder.query(change.sql, change.values(f));
      await holder.commit();
    } finally {
      try { await holder.rollback(); } finally { holder.release(); }
      if (pending) await Promise.allSettled([pending]);
    }
    assert.ok(pending);
    const result = await pending;
    if (change.error) rejected(result, change.status, change.error);
    else {
      assert.equal(result.status, 201);
      assert.equal(record(result).horaFin, change.fin);
    }
    assert.equal((await counts(f)).turnos, change.status === 201 ? 1 : 0);
  });
}

// Updating after earlier current reads proves no REPEATABLE READ snapshot was
// established by preflight. The very first domain read must see these commits.
for (const table of ["servicios", "mascota_servicios", "extras", "mascota_extras"] as const) {
  test(`PET-12E espera ${table} después de auth: dominio ve configuración confirmada`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const holder = await pool.getConnection();
    const attempted = deferred<number>();
    let pending: Promise<ApiResult> | undefined;
    const mapping = {
      servicios: { lock: "SELECT id FROM servicios WHERE id = ? FOR UPDATE", ids: [f.servicioId],
        update: "UPDATE servicios SET activo = 0 WHERE id = ?", values: [f.servicioId], error: "PET_SERVICE_UNAVAILABLE" },
      mascota_servicios: { lock: "SELECT servicio_id FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? FOR UPDATE", ids: [f.mascotaId, f.servicioId],
        update: "DELETE FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ?", values: [f.mascotaId, f.servicioId], error: "PET_SERVICE_UNAVAILABLE" },
      extras: { lock: "SELECT id FROM extras WHERE id = ? FOR UPDATE", ids: [f.extraIds[0]],
        update: "UPDATE extras SET activo = 0 WHERE id = ?", values: [f.extraIds[0]], error: "PET_EXTRA_UNAVAILABLE" },
      mascota_extras: { lock: "SELECT extra_id FROM mascota_extras WHERE mascota_id = ? AND extra_id = ? FOR UPDATE", ids: [f.mascotaId, f.extraIds[0]],
        update: "DELETE FROM mascota_extras WHERE mascota_id = ? AND extra_id = ?", values: [f.mascotaId, f.extraIds[0]], error: "PET_EXTRA_UNAVAILABLE" },
    }[table];
    try {
      await holder.beginTransaction();
      await holder.query(mapping.lock, mapping.ids);
      instrument(t, conn => {
        const query = conn.query.bind(conn);
        t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
          if (String(args[0]).includes(`FROM ${table}\n`) || String(args[0]).includes(`FROM ${table} WHERE`)) attempted.resolve(conn.threadId);
          return query(...args);
        }) as typeof conn.query);
      });
      pending = post(f, body(f, { extraIds: [f.extraIds[0]] }));
      await waitForLock(holder.threadId, await watchdog(attempted.promise), table);
      await holder.query(mapping.update, mapping.values);
      await holder.commit();
    } finally {
      try { await holder.rollback(); } finally { holder.release(); }
      if (pending) await Promise.allSettled([pending]);
    }
    assert.ok(pending);
    rejected(await pending, 404, mapping.error);
    assert.equal((await counts(f)).turnos, 0);
  });
}

for (const [table, change] of [
  ["mascotas", mutations[0]], ["mascota_clientes", mutations[2]], ["servicios", mutations[3]],
  ["mascota_servicios", mutations[4]], ["extras", mutations[5]], ["mascota_extras", mutations[7]],
] as const) {
  test(`PET-12E SHARE estabiliza ${table}: writer espera al commit de booking`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const stable = deferred<number>();
    const release = deferred();
    let writerFinished = false;
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", (async (...args: Parameters<typeof conn.query>) => {
        if (String(args[0]).startsWith("SELECT id, activo, alta_exigencia FROM mascotas")) {
          stable.resolve(conn.threadId);
          await release.promise;
        }
        return query(...args);
      }) as typeof conn.query);
    });
    const booking = post(f, body(f, { extraIds: [f.extraIds[0]] }));
    let writer: Promise<unknown> | undefined;
    try {
      const blocker = await watchdog(stable.promise);
      writer = q(change.sql, change.values(f));
      void writer.then(() => { writerFinished = true; });
      await waitForLock(blocker, null, table);
      assert.equal(writerFinished, false);
    } finally {
      release.resolve();
      await Promise.allSettled([booking, ...(writer ? [writer] : [])]);
    }
    assert.ok(writer);
    assert.equal((await booking).status, 201);
    await writer;
    assert.equal(writerFinished, true);
    assert.deepEqual(await counts(f), { turnos: 1, extras: 1 });
  });
}
