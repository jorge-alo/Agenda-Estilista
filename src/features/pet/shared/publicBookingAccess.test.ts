import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test, type TestContext } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  fechaArgentinaDb, fechaArgentinaDesdeUtcDb, publicBookingEnabled, type PetPublicBookingLocal,
} from "./publicBookingAccess";
import * as solicitudNotification from "../solicitudes/solicitudes.notification";
import * as accessNotification from "../session/session.notification";
import { cambiarEstado, listar } from "../solicitudes/solicitudes.service";
import { procesarPagoSuscripcion, type ResultadoPagoSuscripcion } from "../../suscripcion/suscripcion.pagos";
import {
  FECHA, admin, body, call, counts, deferred, fixture, instrument, logs, pool, post, q, record, rejected,
  sessionState, useBookingHarness, waitForLock, watchdog, type ApiResult, type Fixture,
} from "../publicBooking/publicBooking.turnos.test-support";

useBookingHarness();
let notifications = 0;
beforeEach(t => {
  if (!("mock" in t)) throw new Error("SAAS_MOCKS_UNAVAILABLE");
  notifications = 0;
  t.mock.method(solicitudNotification, "notificarNuevaSolicitud", async () => { notifications++; });
});

const isClock = (sql: string) => sql.startsWith("SELECT CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3)");
const isLocalLock = (sql: string) => /FROM locales WHERE id = \? FOR UPDATE$/.test(sql);
const OLD = "2026-10-19T02:59:59.000Z";
const NEW = "2026-10-19T03:00:00.000Z";

/** Run the real SQL, replacing only its clock result to test midnight deterministically. */
function clockAt(t: TestContext, value: () => string): void {
  const poolQuery = pool.query.bind(pool);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => poolQuery(...args).then(result =>
    isClock(String(args[0])) ? [[{ ahoraUtc: value() }], result[1]] : result)) as typeof pool.query);
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(result =>
      isClock(String(args[0])) ? [[{ ahoraUtc: value() }], result[1]] : result)) as typeof conn.query);
  });
}

async function commercial(f: Fixture, estado: string | null, fecha: string | null, reader: PoolConnection | typeof pool = pool): Promise<void> {
  await reader.query(
    "UPDATE locales SET suscripcion_estado = ?, suscripcion_vencimiento = ?, suscripcion_plan = 'PRIVATE_PLAN_SENTINEL' WHERE id = ?",
    [estado, fecha, f.localId]);
}

function options(f: Fixture): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/mascotas/${f.mascotaId}/opciones-reserva`, { headers: { Authorization: `Bearer ${f.secret}` } });
}
function availability(f: Fixture): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/disponibilidad`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.secret}` },
    body: JSON.stringify({ mascotaId: f.mascotaId, servicioId: f.servicioId, extraIds: [], fecha: FECHA }),
  });
}
function lead(f: Fixture): Promise<ApiResult> {
  return call(`/api/pet/public/${f.slug}/solicitudes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ responsable: { nombre: "SaaS fixture", telefono: "1123452000" }, mascota: { nombre: "SaaS fixture" } }),
  });
}
async function leadCount(f: Fixture): Promise<number> {
  const [row] = await q<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM solicitudes_pet WHERE local_id = ?", [f.localId]);
  return Number(row.total);
}

test("SaaS política pura: estado + fecha + tipo/activo; NULL nunca es ilimitado", () => {
  const valid: PetPublicBookingLocal = { activo: 1, business_type: "PET_GROOMING", suscripcion_estado: "activo", suscripcion_vencimiento: "2026-10-18" };
  assert.equal(publicBookingEnabled(valid, "2026-10-18"), true);
  assert.equal(publicBookingEnabled(valid, "2026-10-17"), true);
  assert.equal(publicBookingEnabled(valid, "2026-10-19"), false);
  for (const patch of [{ activo: 0 }, { business_type: "BEAUTY" }, { suscripcion_estado: "vencido" },
    { suscripcion_estado: "pendiente_pago" }, { suscripcion_estado: null }, { suscripcion_vencimiento: null }]) {
    assert.equal(publicBookingEnabled({ ...valid, ...patch }, "2026-10-18"), false);
  }
  assert.throws(() => publicBookingEnabled({ ...valid, suscripcion_vencimiento: "2026-02-30" }, "2026-10-18"));
  assert.throws(() => publicBookingEnabled({ ...valid, suscripcion_estado: "INVALID" }, "2026-10-18"));
  assert.throws(() => publicBookingEnabled(valid, "invalid"));
});

test("SaaS reloj puro: límite argentino 02:59:59Z/03:00Z, sin timezone implícito", () => {
  assert.equal(fechaArgentinaDesdeUtcDb(OLD), "2026-10-18");
  assert.equal(fechaArgentinaDesdeUtcDb(NEW), "2026-10-19");
  assert.equal(fechaArgentinaDesdeUtcDb("2026-10-18T00:00:00.000Z"), "2026-10-17");
  for (const invalid of [null, undefined, "2026-10-18", "2026-10-18T00:00:00.000", "2026-02-30T00:00:00.000Z"]) {
    assert.throws(() => fechaArgentinaDesdeUtcDb(invalid));
  }
});

test("SaaS adaptador usa UTC_TIMESTAMP DB en SELECT sin FROM, no CURDATE/CONVERT_TZ", async t => {
  let observed = false;
  const query = pool.query.bind(pool);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
    const sql = String(args[0]);
    assert.equal(isClock(sql), true);
    assert.ok(!/\bFROM\b|CURDATE|CONVERT_TZ/.test(sql));
    observed = true;
    return query(...args);
  }) as typeof pool.query);
  assert.match(await fechaArgentinaDb(pool), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(observed, true);
});

for (const [name, estado, fecha, enabled] of [
  ["activo + futuro", "activo", "2026-10-20", true],
  ["activo + hoy Argentina", "activo", "2026-10-18", true],
  ["activo + pasado", "activo", "2026-10-17", false],
  ["activo + NULL", "activo", null, false],
  ["vencido + futuro", "vencido", "2026-10-20", false],
  ["pendiente_pago + futuro", "pendiente_pago", "2026-10-20", false],
  ["estado NULL + futuro", null, "2026-10-20", false],
] as const) {
  test(`SaaS matriz C/D/E/primera visita: ${name}`, async t => {
    const f = await fixture();
    await commercial(f, estado, fecha);
    const before = await sessionState(f);
    clockAt(t, () => OLD);
    const c = await options(f);
    const d = await availability(f);
    const e = await post(f);
    const solicitud = await lead(f);
    for (const [result, success] of [[c, 200], [d, 200], [e, 201], [solicitud, 201]] as const) {
      assert.equal(result.noStore, true);
      if (enabled) assert.equal(result.status, success);
      else rejected(result, 409, "PET_BOOKING_UNAVAILABLE");
      const rendered = JSON.stringify(result.data);
      for (const field of ["PRIVATE_PLAN_SENTINEL", "suscripcion", "deuda", fecha ?? "NO_DATE_SENTINEL"]) assert.ok(!rendered.includes(field));
    }
    assert.deepEqual(await counts(f), { turnos: enabled ? 1 : 0, extras: 0 });
    assert.equal(await leadCount(f), enabled ? 1 : 0);
    assert.equal(notifications, enabled ? 1 : 0);
    assert.deepEqual(await sessionState(f), before);
    if (enabled) assert.equal(record(e).fecha, FECHA, "cita posterior al vencimiento sigue permitida");
  });
}

test("SaaS reloj inválido es 500 sanitizado, no permiso ni indisponibilidad comercial", async t => {
  const f = await fixture();
  clockAt(t, () => "PRIVATE_CLOCK_SENTINEL");
  for (const result of [await options(f), await availability(f), await post(f)]) rejected(result, 500, "INTERNAL_SERVER_ERROR");
  const solicitud = await lead(f);
  assert.equal(solicitud.status, 500);
  assert.ok(!JSON.stringify(solicitud.data).includes("PRIVATE_CLOCK_SENTINEL"));
  assert.ok(!JSON.stringify(logs).includes("PRIVATE_CLOCK_SENTINEL"));
  assert.equal(notifications, 0);
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  assert.equal(await leadCount(f), 0);
});

test("SaaS C/D cambian de 200 a 409 exactamente al comenzar el día argentino siguiente", async t => {
  const f = await fixture();
  await commercial(f, "activo", "2026-10-18");
  let now = OLD;
  clockAt(t, () => now);
  assert.equal((await options(f)).status, 200);
  assert.equal((await availability(f)).status, 200);
  now = NEW;
  rejected(await options(f), 409, "PET_BOOKING_UNAVAILABLE");
  rejected(await availability(f), 409, "PET_BOOKING_UNAVAILABLE");
  assert.equal((await sessionState(f)).revoked, null);
});

test("SaaS vencido conserva contexto/request/consume/me/logout y no revoca challenge ni sesión", async t => {
  const f = await fixture();
  await commercial(f, "vencido", "2000-01-01");
  const before = await sessionState(f);
  // The harness already replaced process.env with a per-test copy.
  Object.assign(process.env, { FRONTEND_URL: "https://pet-frontend.test", NODE_ENV: "test" });
  let delivery: accessNotification.PetAccessDelivery | undefined;
  t.mock.method(accessNotification, "startPetAccessDelivery", (value: accessNotification.PetAccessDelivery) => { delivery = value; });
  assert.equal((await call(`/api/public/local/${f.slug}`)).status, 200);
  const request = await call(`/api/pet/public/${f.slug}/session/request`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefono: "1123452000" }),
  });
  assert.equal(request.status, 202);
  assert.deepEqual(request.data, { ok: true });
  assert.ok(delivery !== undefined);
  rejected(await options(f), 409, "PET_BOOKING_UNAVAILABLE");
  rejected(await post(f), 409, "PET_BOOKING_UNAVAILABLE");
  const [state] = await q<(RowDataPacket & { active: number })[]>(
    "SELECT COUNT(*) AS active FROM pet_access_tokens WHERE local_id = ? AND consumed_at IS NULL AND revoked_at IS NULL", [f.localId]);
  assert.equal(state.active, 1);
  const consume = await call(`/api/pet/public/${f.slug}/session/consume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: delivery.secret }),
  });
  assert.equal(consume.status, 201);
  const secret = record(consume).sessionToken;
  assert.ok(typeof secret === "string");
  const me = await call(`/api/pet/public/${f.slug}/session/me`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(record(me)).sort(), ["cliente", "mascotas"]);
  const logout = await call(`/api/pet/public/${f.slug}/session/logout`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(logout.status, 204);
  assert.equal(logout.noStore, true);
  assert.deepEqual(await sessionState(f), before, "la sesión anterior no cambió por el gate ni por logout de otra sesión");
});

test("SaaS: sesión inválida sigue 401 aunque el local comercialmente esté vencido", async () => {
  const f = await fixture();
  await commercial(f, "vencido", null);
  rejected(await post(f, body(f), null), 401, "PET_SESSION_INVALID");
  await q("UPDATE pet_client_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND local_id = ?", [f.sessionId, f.localId]);
  rejected(await options(f), 401, "PET_SESSION_INVALID");
  rejected(await post(f), 401, "PET_SESSION_INVALID");
});

test("SaaS no afecta creación ADMIN ni gestión de solicitudes existentes", async () => {
  const f = await fixture();
  assert.equal((await lead(f)).status, 201);
  await commercial(f, "vencido", null);
  rejected(await lead(f), 409, "PET_BOOKING_UNAVAILABLE");
  assert.equal((await admin(f)).status, 201);
  const rows = await listar(f.localId, null);
  assert.equal(rows.length, 1);
  await cambiarEstado(f.localId, rows[0].id, "CONTACTADA");
  assert.equal((await listar(f.localId, "CONTACTADA")).length, 1);
});

async function whileWaitingLocal(
  t: TestContext, f: Fixture, start: () => Promise<ApiResult>, change: (holder: PoolConnection) => Promise<void>,
): Promise<ApiResult> {
  const holder = await pool.getConnection();
  const attempted = deferred<number>();
  let pending: Promise<ApiResult> | undefined;
  try {
    await holder.beginTransaction();
    await holder.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [f.localId]);
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        if (isLocalLock(String(args[0])) && (args[1] as number[])[0] === f.localId) attempted.resolve(conn.threadId);
        return query(...args);
      }) as typeof conn.query);
    });
    pending = start();
    await waitForLock(holder.threadId, await watchdog(attempted.promise), "locales");
    await change(holder);
    await holder.commit();
  } finally {
    try { await holder.rollback(); } finally { holder.release(); }
    if (pending) await Promise.allSettled([pending]);
  }
  assert.ok(pending);
  return pending;
}

for (const route of ["turnos", "solicitudes"] as const) {
  for (const renewal of [false, true]) {
    test(`SaaS ${route}: ${renewal ? "renovación" : "vencimiento"} confirmado mientras espera local`, { timeout: 30000 }, async t => {
      const f = await fixture();
      await commercial(f, renewal ? "vencido" : "activo", renewal ? null : "2099-12-31");
      const result = await whileWaitingLocal(t, f, () => route === "turnos" ? post(f) : lead(f),
        async holder => { await commercial(f, renewal ? "activo" : "vencido", renewal ? "2099-12-31" : null, holder); });
      if (renewal) assert.equal(result.status, 201);
      else rejected(result, 409, "PET_BOOKING_UNAVAILABLE");
      assert.equal((await counts(f)).turnos, route === "turnos" && renewal ? 1 : 0);
      assert.equal(await leadCount(f), route === "solicitudes" && renewal ? 1 : 0);
      assert.equal(notifications, route === "solicitudes" && renewal ? 1 : 0);
    });
  }

  test(`SaaS ${route}: cruce de día esperando local usa un reloj posterior al lock`, { timeout: 30000 }, async t => {
    const f = await fixture();
    await commercial(f, "activo", "2026-10-18");
    let now = OLD;
    let clockCalls = 0;
    clockAt(t, () => { clockCalls++; return now; });
    const result = await whileWaitingLocal(t, f, () => route === "turnos" ? post(f) : lead(f), async () => {
      assert.equal(clockCalls, 0, "no usar un reloj anterior a adquirir el local");
      now = NEW;
    });
    rejected(result, 409, "PET_BOOKING_UNAVAILABLE");
    assert.equal(clockCalls, 1);
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
    assert.equal(await leadCount(f), 0);
    assert.equal(notifications, 0);
  });

  test(`SaaS ${route}: cruce de día después del INSERT revierte antes del commit`, async t => {
    const f = await fixture();
    await commercial(f, "activo", "2026-10-18");
    const before = await sessionState(f);
    let now = OLD;
    let inserts = 0;
    let commits = 0;
    clockAt(t, () => now);
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      const commit = conn.commit.bind(conn);
      t.mock.method(conn, "commit", async () => { commits++; await commit(); });
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(result => {
        const sql = String(args[0]);
        if ((route === "turnos" && sql.includes("INSERT INTO turno_extras"))
          || (route === "solicitudes" && sql.includes("INSERT INTO solicitudes_pet"))) { inserts++; now = NEW; }
        return result;
      })) as typeof conn.query);
    });
    const result = route === "turnos" ? await post(f, body(f, { extraIds: [f.extraIds[0]] })) : await lead(f);
    rejected(result, 409, "PET_BOOKING_UNAVAILABLE");
    assert.equal(inserts, 1);
    assert.equal(commits, 0);
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
    assert.equal(await leadCount(f), 0);
    assert.equal(notifications, 0);
    assert.deepEqual(await sessionState(f), before);
  });

  test(`SaaS ${route}: el local bloqueado estabiliza suscripción hasta commit`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const locked = deferred<number>();
    const release = deferred();
    let firstClock = true;
    let writerFinished = false;
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(async result => {
        if (isClock(String(args[0])) && firstClock) { firstClock = false; locked.resolve(conn.threadId); await release.promise; }
        return result;
      })) as typeof conn.query);
    });
    const pending = route === "turnos" ? post(f) : lead(f);
    let writer: Promise<void> | undefined;
    try {
      const blocker = await watchdog(locked.promise);
      writer = commercial(f, "vencido", null);
      void writer.then(() => { writerFinished = true; }, () => {});
      await waitForLock(blocker, null, "locales");
      assert.equal(writerFinished, false);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, ...(writer ? [writer] : [])]);
    }
    assert.equal((await pending).status, 201);
    assert.ok(writer);
    await writer;
    assert.equal(writerFinished, true);
    rejected(route === "turnos" ? await post(f) : await lead(f), 409, "PET_BOOKING_UNAVAILABLE");
  });
}

test("SaaS booking: cruce de día esperando servicio llega al chequeo final y revierte", { timeout: 30000 }, async t => {
  const f = await fixture();
  await commercial(f, "activo", "2026-10-18");
  const holder = await pool.getConnection();
  const attempted = deferred<number>();
  let pending: Promise<ApiResult> | undefined;
  let now = OLD;
  let inserts = 0;
  clockAt(t, () => now);
  try {
    await holder.beginTransaction();
    await holder.query("SELECT id FROM servicios WHERE id = ? FOR UPDATE", [f.servicioId]);
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        const sql = String(args[0]);
        if (sql === "SELECT id FROM servicios WHERE id = ? AND local_id = ? FOR SHARE") attempted.resolve(conn.threadId);
        if (/INSERT INTO turnos\s*\(/.test(sql)) inserts++;
        return query(...args);
      }) as typeof conn.query);
    });
    pending = post(f);
    await waitForLock(holder.threadId, await watchdog(attempted.promise), "servicios");
    now = NEW;
  } finally {
    try { await holder.rollback(); } finally { holder.release(); }
    if (pending) await Promise.allSettled([pending]);
  }
  assert.ok(pending);
  rejected(await pending, 409, "PET_BOOKING_UNAVAILABLE");
  assert.equal(inserts, 1);
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("SaaS otro tenant puede reservar mientras el local vencido espera su lock", { timeout: 30000 }, async t => {
  const f = await fixture();
  const other = await fixture();
  await commercial(f, "vencido", null);
  const result = await whileWaitingLocal(t, f, () => post(f), async () => {
    assert.equal((await watchdog(post(other))).status, 201);
    assert.equal((await counts(other)).turnos, 1);
  });
  rejected(result, 409, "PET_BOOKING_UNAVAILABLE");
});

test("SaaS primera visita: ni HTTP ni notificación ni fila visible antes de commit", { timeout: 30000 }, async t => {
  const f = await fixture();
  const reached = deferred();
  const release = deferred();
  let responded = false;
  instrument(t, conn => {
    const commit = conn.commit.bind(conn);
    t.mock.method(conn, "commit", async () => { reached.resolve(); await release.promise; await commit(); });
  });
  const pending = lead(f);
  void pending.then(() => { responded = true; }, () => { responded = true; });
  try {
    await watchdog(reached.promise);
    assert.equal(responded, false);
    assert.equal(notifications, 0);
    assert.equal(await leadCount(f), 0);
  } finally { release.resolve(); await Promise.allSettled([pending]); }
  assert.equal((await pending).status, 201);
  assert.equal(notifications, 1);
  assert.equal(await leadCount(f), 1);
});

test("SaaS primera visita: fallo antes de commit no guarda ni notifica", async t => {
  const f = await fixture();
  instrument(t, conn => {
    t.mock.method(conn, "commit", async () => { throw new Error("PRIVATE_COMMIT_SENTINEL"); });
  });
  const result = await lead(f);
  assert.equal(result.status, 500);
  assert.equal(await leadCount(f), 0);
  assert.equal(notifications, 0);
  assert.ok(!JSON.stringify(result.data).includes("PRIVATE_COMMIT_SENTINEL"));
});

for (const route of ["turnos", "solicitudes"] as const) {
  for (const renewalFirst of [true, false]) {
    test(`SaaS ${route} vs renovación REAL: ${renewalFirst ? "renovación" : "público"} toma local primero sin inversión`, { timeout: 30000 }, async t => {
      const f = await fixture();
      await commercial(f, renewalFirst ? "vencido" : "activo", renewalFirst ? null : "2099-12-31");
      const reference = `suscripcion-${f.localId}-${randomUUID()}`;
      await q("INSERT INTO pagos_suscripcion (local_id, external_reference, monto, estado) VALUES (?, ?, 100, 'pendiente')", [f.localId, reference]);
      const locked = deferred<number>();
      const attempted = deferred<number>();
      const release = deferred();
      instrument(t, conn => {
        const query = conn.query.bind(conn);
        t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
          const sql = String(args[0]);
          const writerLocal = sql === "SELECT id FROM locales WHERE id = ? FOR UPDATE";
          if (isLocalLock(sql)) {
            if (writerLocal === renewalFirst) {
              return query(...args).then(async result => { locked.resolve(conn.threadId); await release.promise; return result; });
            }
            attempted.resolve(conn.threadId);
          }
          return query(...args);
        }) as typeof conn.query);
      });
      const startRenewal = () => procesarPagoSuscripcion({ externalReference: reference, status: "approved", mpPaymentId: `saas-fixture-${f.localId}` });
      const startPublic = () => route === "turnos" ? post(f) : lead(f);
      let renewing: Promise<ResultadoPagoSuscripcion> | undefined;
      let booking: Promise<ApiResult> | undefined;
      try {
        if (renewalFirst) renewing = startRenewal(); else booking = startPublic();
        const blocker = await watchdog(locked.promise);
        if (renewalFirst) booking = startPublic(); else renewing = startRenewal();
        await waitForLock(blocker, await watchdog(attempted.promise), "locales");
      } finally {
        release.resolve();
        await Promise.allSettled([...(renewing ? [renewing] : []), ...(booking ? [booking] : [])]);
      }
      assert.ok(renewing !== undefined && booking !== undefined);
      assert.equal(await renewing, "renovada");
      assert.equal((await booking).status, 201);
      assert.equal((await counts(f)).turnos, route === "turnos" ? 1 : 0);
      assert.equal(await leadCount(f), route === "solicitudes" ? 1 : 0);
    });
  }
}
