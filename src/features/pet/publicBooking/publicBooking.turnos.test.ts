import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { contextoTemporalArgentina, DisponibilidadPetError } from "../disponibilidad/disponibilidad.service";
import { crearReservaPublica } from "./publicBooking.service";
import { PublicBookingError, validarCreacionPublica } from "./publicBooking.types";
import {
  FECHA, SIGUIENTE, body, call, context, counts, deferred, existing, fixture, highDemand, horario,
  instrument, logs, post, q, record, rejected, session, sessionState, useBookingHarness, waitForExpiry, watchdog,
} from "./publicBooking.turnos.test-support";

useBookingHarness();

test("PET-12E DTO exacto: cinco campos, límites/formatos estrictos y extras normalizados sin mutación", () => {
  const raw = { mascotaId: 1, servicioId: 2147483647, extraIds: [5, 3], fecha: FECHA, hora: "09:15" };
  assert.deepEqual(validarCreacionPublica(raw), { ...raw, extraIds: [3, 5] });
  assert.deepEqual(raw.extraIds, [5, 3]);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(validarCreacionPublica({ ...raw, extraIds: hundred }).extraIds.length, 100);
  assert.deepEqual(validarCreacionPublica({ ...raw, extraIds: [] }).extraIds, []);
  const invalids: unknown[] = [null, [], "x", {}, { ...raw, extraIds: [...hundred, 101] },
    { ...raw, extraIds: [3, 3] }, { ...raw, extraIds: "3" }, { ...raw, extraIds: ["3"] },
    { ...raw, fecha: "2099-02-30" }, { ...raw, fecha: "2099-1-01" }, { ...raw, fecha: `${FECHA}\n` }];
  for (const key of Object.keys(raw)) {
    const missing: Record<string, unknown> = { ...raw };
    delete missing[key];
    invalids.push(missing);
  }
  for (const key of ["mascotaId", "servicioId"]) {
    for (const value of ["1", 0, -1, 1.5, 2147483648, NaN, Infinity, null, true]) invalids.push({ ...raw, [key]: value });
  }
  for (const value of [0, -1, 1.5, 2147483648, null, true]) invalids.push({ ...raw, extraIds: [value] });
  for (const hora of ["9:00", "09:00:00", "24:00", "12:60", "10:00 ", "10:00\n", 1000]) invalids.push({ ...raw, hora });
  for (const key of ["clienteId", "localId", "estado", "duracion", "horaFin", "altaExigencia", "estilistaId", "precio", "pago", "seña"]) {
    invalids.push({ ...raw, [key]: 1 });
  }
  for (const payload of invalids) assert.throws(() => validarCreacionPublica(payload), error =>
    error instanceof PublicBookingError && error.status === 400 && error.code === "PET_BOOKING_INVALID");
});

test("PET-12E HTTP DTO: faltante, protegido, duplicado y 101 extras son 400 sin escrituras", async () => {
  const f = await fixture();
  const missing: Record<string, unknown> = body(f);
  delete missing.extraIds;
  for (const payload of [missing, body(f, { clienteId: f.clienteId }), body(f, { extraIds: [1, 1] }),
    body(f, { extraIds: Array.from({ length: 101 }, (_, i) => i + 1) }), body(f, { hora: "10:00:00" })]) {
    rejected(await post(f, payload), 400, "PET_BOOKING_INVALID");
  }
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("PET-12E auth: ausente/JWT/revocada/expirada/slug ajeno no crean turno", async () => {
  const f = await fixture();
  const other = await fixture();
  rejected(await post(f, body(f), null), 401, "PET_SESSION_INVALID");
  rejected(await post(f, body(f), "aaa.bbb.ccc"), 401, "PET_SESSION_INVALID");
  rejected(await post({ ...f, slug: other.slug }), 401, "PET_SESSION_INVALID");
  rejected(await post(f, body(f), other.secret), 401, "PET_SESSION_INVALID");
  const expired = await session(f.localId, f.clienteId, -1);
  rejected(await post(f, body(f), expired.secret), 401, "PET_SESSION_INVALID");
  await q("UPDATE pet_client_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND local_id = ?", [f.sessionId, f.localId]);
  rejected(await post(f), 401, "PET_SESSION_INVALID");
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("PET-12E autoridad persistida: sessionId/localId/clienteId deben corresponder y slug se revalida", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const authority of [
    { ...context(f), sessionId: 2147483647 },
    { ...context(f), clienteId: other.clienteId },
    { ...context(f), localId: other.localId },
  ]) {
    await assert.rejects(crearReservaPublica(authority, f.slug, validarCreacionPublica(body(f))), error =>
      error instanceof PublicBookingError && error.status === 401 && error.code === "PET_SESSION_INVALID");
  }
  await assert.rejects(crearReservaPublica(context(f), other.slug, validarCreacionPublica(body(f))), error =>
    error instanceof PublicBookingError && error.code === "PET_SESSION_INVALID");
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("PET-12E éxito: 201 mínimo, activo, snapshots personalizados, extras y sesión sin modificar", async () => {
  const f = await fixture();
  const before = await sessionState(f);
  const result = await post(f, body(f, { extraIds: [...f.extraIds].reverse() }));
  assert.equal(result.status, 201);
  assert.equal(result.noStore, true);
  const payload = record(result);
  assert.deepEqual(payload, { id: payload.id, fecha: FECHA, hora: "10:00", horaFin: "11:40", estado: "activo" });
  assert.equal(typeof payload.id, "number");
  const [row] = await q<RowDataPacket[]>(
    `SELECT estilista_id, pago_id, mascota_id, cliente_id, servicio_id, cliente_nombre, cliente_telefono,
       servicio_nombre_snapshot, duracion_servicio_snapshot, alta_exigencia_snapshot, estado,
       TIME_FORMAT(hora_fin, '%H:%i') AS fin FROM turnos WHERE id = ? AND local_id = ?`, [payload.id, f.localId]);
  assert.deepEqual({ ...row }, { estilista_id: null, pago_id: null, mascota_id: f.mascotaId, cliente_id: f.clienteId,
    servicio_id: f.servicioId, cliente_nombre: "PET12E Ana", cliente_telefono: "1123452000",
    servicio_nombre_snapshot: "PET12E Baño", duracion_servicio_snapshot: 60, alta_exigencia_snapshot: 0, estado: "activo", fin: "11:40" });
  const extras = await q<RowDataPacket[]>(
    "SELECT extra_id, nombre_snapshot, duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY extra_id", [payload.id]);
  assert.deepEqual(extras.map(row => ({ ...row })), [
    { extra_id: f.extraIds[0], nombre_snapshot: "PET12E Uñas", duracion_minutos: 15 },
    { extra_id: f.extraIds[1], nombre_snapshot: "PET12E Perfume", duracion_minutos: 25 },
  ]);
  assert.deepEqual(await sessionState(f), before);
  assert.equal(logs.length, 0);
});

test("PET-12E mascota compartida: cada responsable conserva su propia autoridad", async () => {
  const f = await fixture();
  const client = await q<ResultSetHeader>(
    "INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, 'PET12E Bea', '1123452001')", [f.localId]);
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [f.localId, f.mascotaId, client.insertId]);
  const other = await session(f.localId, client.insertId);
  assert.equal((await post(f)).status, 201);
  const result = await post(f, body(f, { hora: "11:00" }), other.secret);
  assert.equal(result.status, 201);
  const [row] = await q<RowDataPacket[]>("SELECT cliente_id, cliente_nombre FROM turnos WHERE id = ? AND local_id = ?", [record(result).id, f.localId]);
  assert.equal(row.cliente_id, client.insertId);
  assert.equal(row.cliente_nombre, "PET12E Bea");
});

for (const change of ["inactiva", "offline", "desvinculada", "inexistente", "otro tenant"] as const) {
  test(`PET-12E mascota ${change}: 404 uniforme`, async () => {
    const f = await fixture();
    let mascotaId = f.mascotaId;
    if (change === "inactiva") await q("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [mascotaId, f.localId]);
    if (change === "offline") await q("UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", [mascotaId, f.localId]);
    if (change === "desvinculada") await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [mascotaId, f.clienteId, f.localId]);
    if (change === "inexistente") mascotaId = 2147483647;
    if (change === "otro tenant") mascotaId = (await fixture()).mascotaId;
    rejected(await post(f, body(f, { mascotaId })), 404, "PET_MASCOTA_UNAVAILABLE");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  });
}

test("PET-12E mascota de otro responsable del mismo tenant es 404", async () => {
  const f = await fixture();
  const client = await q<ResultSetHeader>("INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, 'PET12E Otra', '1123452001')", [f.localId]);
  const stranger = await session(f.localId, client.insertId);
  rejected(await post(f, body(f), stranger.secret), 404, "PET_MASCOTA_UNAVAILABLE");
});

for (const change of ["inactivo", "no asociado", "inexistente", "otro tenant"] as const) {
  test(`PET-12E servicio ${change}: 404 uniforme`, async () => {
    const f = await fixture();
    let servicioId = f.servicioId;
    if (change === "inactivo") await q("UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", [servicioId, f.localId]);
    if (change === "no asociado") await q("DELETE FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? AND local_id = ?", [f.mascotaId, servicioId, f.localId]);
    if (change === "inexistente") servicioId = 2147483647;
    if (change === "otro tenant") servicioId = (await fixture()).servicioId;
    rejected(await post(f, body(f, { servicioId })), 404, "PET_SERVICE_UNAVAILABLE");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  });
}

for (const change of ["inactivo", "no asociado", "inexistente", "otro tenant"] as const) {
  test(`PET-12E extra ${change}: ningún extra válido se aplica parcialmente`, async () => {
    const f = await fixture();
    let extra = f.extraIds[1];
    if (change === "inactivo") await q("UPDATE extras SET activo = 0 WHERE id = ? AND local_id = ?", [extra, f.localId]);
    if (change === "no asociado") await q("DELETE FROM mascota_extras WHERE mascota_id = ? AND extra_id = ? AND local_id = ?", [f.mascotaId, extra, f.localId]);
    if (change === "inexistente") extra = 2147483647;
    if (change === "otro tenant") extra = (await fixture()).extraIds[0];
    rejected(await post(f, body(f, { extraIds: [f.extraIds[0], extra] })), 404, "PET_EXTRA_UNAVAILABLE");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  });
}

test("PET-12E slots: sin extras, retry idéntico 409, adyacente válido y cierre exacto", async () => {
  const f = await fixture();
  assert.equal((await post(f)).status, 201);
  rejected(await post(f), 409, "PET_SLOT_UNAVAILABLE");
  const adjacent = await post(f, body(f, { hora: "11:00" }));
  assert.equal(adjacent.status, 201);
  const closing = await post(f, body(f, { hora: "12:00" }));
  assert.equal(closing.status, 201);
  assert.equal(record(closing).horaFin, "13:00");
  assert.deepEqual(await counts(f), { turnos: 3, extras: 0 });
});

test("PET-12E un extra suma la duración personalizada sin usar duración genérica", async () => {
  const f = await fixture();
  const result = await post(f, body(f, { extraIds: [f.extraIds[0]] }));
  assert.equal(result.status, 201);
  assert.equal(record(result).horaFin, "11:15");
  assert.deepEqual(await counts(f), { turnos: 1, extras: 1 });
});

test("PET-12E slots: grilla, fuera de horario, fecha e inicio pasados son 409", async () => {
  const f = await fixture();
  const today = contextoTemporalArgentina();
  for (const payload of [body(f, { hora: "09:15" }), body(f, { hora: "08:00" }), body(f, { hora: "12:30" }),
    body(f, { fecha: "2000-01-01" }), body(f, { fecha: today.fecha, hora: "00:00" })]) {
    rejected(await post(f, payload), 409, "PET_SLOT_UNAVAILABLE");
  }
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("PET-12E slots :15 se aceptan cuando la franja está anclada en :15", async () => {
  const f = await fixture();
  await q("DELETE FROM horarios_local WHERE local_id = ?", [f.localId]);
  await horario(f.localId, FECHA, "09:15", "10:15");
  const result = await post(f, body(f, { hora: "09:15" }));
  assert.equal(result.status, 201);
  assert.equal(record(result).horaFin, "10:15");
});

for (const full of [false, true]) {
  test(`PET-12E bloqueo ${full ? "completo" : "parcial"} se revalida antes del insert`, async () => {
    const f = await fixture();
    await q("INSERT INTO bloqueos_local (local_id, fecha, es_dia_completo, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?)",
      [f.localId, FECHA, full ? 1 : 0, full ? null : "10:30", full ? null : "11:30"]);
    rejected(await post(f), 409, "PET_SLOT_UNAVAILABLE");
  });
}

for (const state of ["activo", "pendiente_pago", "cancelado", "completado"]) {
  test(`PET-12E ocupación ${state} conserva política física PET-07`, async () => {
    const f = await fixture();
    await existing(f, "10:30", "11:30", FECHA, state);
    const result = await post(f);
    if (["activo", "pendiente_pago"].includes(state)) rejected(result, 409, "PET_SLOT_UNAVAILABLE");
    else assert.equal(result.status, 201);
  });
}

for (const scenario of ["intradía", "interfecha anterior", "interfecha posterior", "MAX_PER_DAY", "missing settings"] as const) {
  test(`PET-12E alta exigencia ${scenario} usa reglas compartidas`, async () => {
    const f = await fixture();
    if (scenario === "missing settings") {
      await q("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
      rejected(await post(f), 409, "PET_BOOKING_UNAVAILABLE");
    } else {
      await highDemand(f, scenario === "MAX_PER_DAY" ? "MAX_PER_DAY" : "MIN_GAP", scenario === "MAX_PER_DAY" ? 1 : 300);
      if (scenario === "intradía" || scenario === "MAX_PER_DAY") await existing(f, "08:00", "09:00", FECHA, "completado", 1);
      if (scenario === "interfecha anterior") {
        await horario(f.localId, SIGUIENTE, "00:00", "04:00");
        await existing(f, "21:00", "22:00", FECHA, "completado", 1);
      }
      if (scenario === "interfecha posterior") {
        await horario(f.localId, FECHA, "18:00", "21:00");
        await existing(f, "00:00", "01:00", SIGUIENTE, "pendiente_pago", 1);
      }
      const payload = scenario === "interfecha anterior" ? body(f, { fecha: SIGUIENTE, hora: "02:30" })
        : scenario === "interfecha posterior" ? body(f, { hora: "18:30" }) : body(f);
      rejected(await post(f, payload), 409, "PET_SLOT_UNAVAILABLE");
      if (scenario === "interfecha anterior") assert.equal((await post(f, body(f, { fecha: SIGUIENTE, hora: "03:00" }))).status, 201);
      if (scenario === "interfecha posterior") assert.equal((await post(f, body(f, { hora: "18:00" }))).status, 201);
    }
  });
}

test("PET-12E preflight: todas las lecturas son locking y extras se bloquean ASC antes del snapshot", async t => {
  const f = await fixture();
  const reads: string[] = [];
  const lockedExtras: number[] = [];
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
      const sql = String(args[0]);
      if (/^\s*SELECT/.test(sql)) reads.push(sql);
      if (sql === "SELECT id FROM extras WHERE id = ? AND local_id = ? FOR SHARE") {
        lockedExtras.push(Number((args[1] as unknown[])[0]));
      }
      return query(...args);
    }) as typeof conn.query);
  });
  assert.equal((await post(f, body(f, { extraIds: [...f.extraIds].reverse() }))).status, 201);
  const domainRead = reads.findIndex(sql => sql.startsWith("SELECT id, activo, alta_exigencia FROM mascotas"));
  assert.ok(domainRead > 0);
  assert.ok(reads.slice(0, domainRead).every(sql => /FOR (UPDATE|SHARE)/.test(sql)
    || (sql.startsWith("SELECT CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3)") && !/\bFROM\b/.test(sql))));
  assert.deepEqual(lockedExtras, f.extraIds);
});

for (const failure of ["afterAuth", "turno", "firstExtra", "secondExtra", "commit"] as const) {
  test(`PET-12E atomicidad ${failure}: rollback completo y sesión intacta`, async t => {
    const f = await fixture();
    const before = await sessionState(f);
    let extraCount = 0;
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        const sql = String(args[0]);
        if ((failure === "afterAuth" && sql.startsWith("SELECT activo, reserva_online_habilitada"))
          || (failure === "turno" && /INSERT INTO turnos\s*\(/.test(sql))) throw new Error("PET12E_FAILURE_SENTINEL");
        if (sql.includes("INSERT INTO turno_extras")) {
          extraCount++;
          if ((failure === "firstExtra" && extraCount === 1) || (failure === "secondExtra" && extraCount === 2)) {
            throw new Error("PET12E_FAILURE_SENTINEL");
          }
        }
        return query(...args);
      }) as typeof conn.query);
      if (failure === "commit") t.mock.method(conn, "commit", async () => { throw new Error("PET12E_FAILURE_SENTINEL"); });
    });
    rejected(await post(f, body(f, { extraIds: f.extraIds })), 500, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
    assert.deepEqual(await sessionState(f), before);
    const rendered = JSON.stringify(logs);
    assert.ok(!rendered.includes("PET12E_FAILURE_SENTINEL") && !rendered.includes(f.secret));
  });
}

test("PET-12E expiración en chequeo final revierte turno y extras sin modificar sesión", { timeout: 30000 }, async t => {
  const base = await fixture();
  const f = { ...base, ...await session(base.localId, base.clienteId, 4) };
  const before = await sessionState(f);
  let insertedExtras = 0;
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(async result => {
      if (String(args[0]).includes("INSERT INTO turno_extras") && ++insertedExtras === 2) await waitForExpiry(f);
      return result;
    })) as typeof conn.query);
  });
  rejected(await post(f, body(f, { extraIds: f.extraIds })), 401, "PET_SESSION_INVALID");
  assert.equal(insertedExtras, 2);
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  assert.deepEqual(await sessionState(f), before);
});

test("PET-12E no responde 201 ni publica filas antes de COMMIT exitoso", { timeout: 30000 }, async t => {
  const f = await fixture();
  const reached = deferred();
  const release = deferred();
  let responded = false;
  instrument(t, conn => {
    const commit = conn.commit.bind(conn);
    t.mock.method(conn, "commit", async () => { reached.resolve(); await release.promise; await commit(); });
  });
  const pending = post(f, body(f, { extraIds: f.extraIds }));
  void pending.then(() => { responded = true; }, () => { responded = true; });
  try {
    await watchdog(reached.promise);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(responded, false);
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  } finally { release.resolve(); await Promise.allSettled([pending]); }
  assert.equal((await pending).status, 201);
  assert.deepEqual(await counts(f), { turnos: 1, extras: 2 });
});

for (const failure of ["RangeError", "integrity", "unknownDomain", "duplicateSQL"] as const) {
  test(`PET-12E ${failure} llega a 500 sanitizado, nunca 4xx`, async t => {
    const f = await fixture();
    instrument(t, conn => {
      const query = conn.query.bind(conn);
      t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => {
        if (String(args[0]).startsWith("SELECT id, activo, alta_exigencia FROM mascotas")) {
          if (failure === "RangeError") throw new RangeError("PET12E_CORRUPTION_SENTINEL");
          if (failure === "integrity") throw new DisponibilidadPetError(500, "PET_AVAILABILITY_INTEGRITY_ERROR", "PET12E_CORRUPTION_SENTINEL");
          if (failure === "unknownDomain") throw new DisponibilidadPetError(409, "PET_FUTURE_UNKNOWN", "PET12E_CORRUPTION_SENTINEL");
          throw Object.assign(new Error("PET12E_CORRUPTION_SENTINEL"), { code: "ER_DUP_ENTRY" });
        }
        return query(...args);
      }) as typeof conn.query);
    });
    rejected(await post(f), 500, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
    assert.ok(!JSON.stringify(logs).includes("PET12E_CORRUPTION_SENTINEL"));
  });
}

test("PET-12E duración corrupta leída por PET-07 falla 500 sin alterar CHECKs ni persistir", async t => {
  const f = await fixture();
  instrument(t, conn => {
    const query = conn.query.bind(conn);
    t.mock.method(conn, "query", ((...args: Parameters<typeof conn.query>) => query(...args).then(result => {
      if (String(args[0]).startsWith("SELECT duracion_minutos FROM mascota_servicios")) {
        return [[{ duracion_minutos: 0 }], result[1]];
      }
      return result;
    })) as typeof conn.query);
  });
  rejected(await post(f), 500, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
});

test("PET-12E.1 C/D/E rechazan SaaS vencido uniformemente sin invalidar sesión", async () => {
  const f = await fixture();
  await q("UPDATE locales SET suscripcion_estado = 'vencido', suscripcion_vencimiento = '2000-01-01' WHERE id = ?", [f.localId]);
  const options = await call(`/api/pet/public/${f.slug}/mascotas/${f.mascotaId}/opciones-reserva`, { headers: { Authorization: `Bearer ${f.secret}` } });
  rejected(options, 409, "PET_BOOKING_UNAVAILABLE");
  const availability = await call(`/api/pet/public/${f.slug}/disponibilidad`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.secret}` },
    body: JSON.stringify({ mascotaId: f.mascotaId, servicioId: f.servicioId, extraIds: [], fecha: FECHA }),
  });
  rejected(availability, 409, "PET_BOOKING_UNAVAILABLE");
  rejected(await post(f), 409, "PET_BOOKING_UNAVAILABLE");
  assert.deepEqual(await counts(f), { turnos: 0, extras: 0 });
  assert.equal((await sessionState(f)).revoked, null);
});
