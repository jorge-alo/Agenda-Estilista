import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { procesarRecordatorioPet, recuperarRecordatoriosPet } from "./recordatorios.processing";
import { reclamarRecordatorioPet, seleccionarPaginaRecordatoriosPet,
  type CandidatoRecordatorioPet, type RelojRecordatorioPet } from "./recordatorios.service";
import { isPetReminderSchedulerEnabled, PET_REMINDER_BATCH_SIZE,
  PET_REMINDER_CRON, PET_REMINDER_TIMEZONE, runPetReminderCycle,
  startPetReminderScheduler, type PetReminderCycleDependencies } from "./recordatorios.scheduler";

const tag = `NOTIF1C_${randomUUID()}`;
const locales: number[] = [];
const clock: RelojRecordatorioPet = async () => new Date("2026-10-29T13:00:00Z");
const late: RelojRecordatorioPet = async () => new Date("2026-10-29T15:00:00Z");
const recovered = { pending: 0, skipped: 0, unknown: 0 };

async function insert(sql: string, params: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result.insertId;
}
async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params);
  return result;
}
async function cleanupLocal(local: number) {
  const [record] = await rows("SELECT slug FROM locales WHERE id = ?", [local]);
  assert.ok(record?.slug?.startsWith(tag));
  await pool.query("DELETE FROM turnos WHERE local_id = ?", [local]);
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [local]);
  await pool.query("DELETE FROM mascotas WHERE local_id = ?", [local]);
  await pool.query("DELETE FROM clientes WHERE local_id = ?", [local]);
  await pool.query("DELETE FROM locales WHERE id = ?", [local]);
  locales.splice(locales.indexOf(local), 1);
}
async function createFixture(t: TestContext) {
  const local = await insert("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')",
    [tag, `${tag}-${locales.length}`]);
  locales.push(local);
  t.after(async () => { await cleanupLocal(local); });
  const canonical = `+54911${String(local).padStart(8, "0")}`;
  const cliente = await insert("INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [local, tag, `11${String(local).padStart(8, "0")}`, canonical]);
  const mascota = await insert("INSERT INTO mascotas (local_id, nombre) VALUES (?, ?)", [local, tag]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
    [local, mascota, cliente]);
  return { local, mascota, cliente, canonical };
}
async function createTurno(f: { local: number; mascota: number; cliente: number }, cliente = f.cliente) {
  return insert(
    `INSERT INTO turnos (local_id, mascota_id, cliente_id, fecha, hora, hora_fin,
       cliente_nombre, cliente_telefono, servicio_nombre_snapshot, duracion_servicio_snapshot,
       alta_exigencia_snapshot, estado, created_at)
     VALUES (?, ?, ?, '2026-10-30', '16:00', '16:30', ?, 'no-usar-snapshot',
       'Baño', 30, 0, 'activo', '2026-10-29 12:59:59')`,
    [f.local, f.mascota, cliente, tag],
  );
}
after(async () => {
  try {
    for (const local of [...locales]) await cleanupLocal(local);
  } finally { await pool.end(); }
});

function candidate(turnoId: number): CandidatoRecordatorioPet {
  return { turnoId, localId: 1, clienteId: 1, telefonoCanonical: "+5491198765432" };
}

test("flag estricta: default/TRUE/1/yes/vacío no registran ni ejecutan ciclos", async () => {
  let schedules = 0;
  let cycles = 0;
  const schedule = (() => { schedules++; return { stop() {} }; }) as Parameters<typeof startPetReminderScheduler>[1];
  for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
    assert.equal(isPetReminderSchedulerEnabled(value), false);
    assert.equal(startPetReminderScheduler(value, schedule, async () => { cycles++; }), false);
  }
  assert.equal(schedules, 0);
  assert.equal(cycles, 0);
});

test("cycle ordena recovery, página, reclamo y processing; no candidato = cero procesamientos", async () => {
  const events: string[] = [];
  const deps: PetReminderCycleDependencies = {
    recover: async () => { events.push("recover"); return recovered; },
    page: async () => { events.push("page"); return { candidatos: [candidate(1)], cursor: null, hayMas: false }; },
    claim: async () => { events.push("claim"); return { recordatorioId: 11, turnoId: 1, localId: 1, clienteId: 1,
      telefonoCanonical: "+5491198765432" }; },
    process: async () => { events.push("process"); return "sent"; },
  };
  assert.deepEqual(await runPetReminderCycle(deps), { recovered, claimed: 1, itemErrors: 0 });
  assert.deepEqual(events, ["recover", "page", "claim", "process"]);
  events.length = 0;
  deps.page = async () => { events.push("page"); return { candidatos: [], cursor: null, hayMas: false }; };
  assert.equal((await runPetReminderCycle(deps)).claimed, 0);
  assert.deepEqual(events, ["recover", "page"]);
});

test("keyset real: misma fecha/hora e IDs distintos sobreviven al cambio de estado en página previa", async t => {
  const f = await createFixture(t);
  const ids = (await Promise.all([createTurno(f), createTurno(f), createTurno(f)])).sort((a, b) => a - b);
  const first = await seleccionarPaginaRecordatoriosPet(null, clock, 1);
  assert.deepEqual(first.candidatos.map(row => row.turnoId), [ids[0]]);
  assert.equal(first.hayMas, true);
  assert.ok(await reclamarRecordatorioPet(f.local, ids[0], clock));
  const second = await seleccionarPaginaRecordatoriosPet(first.cursor, clock, 1);
  assert.deepEqual(second.candidatos.map(row => row.turnoId), [ids[1]]);
  await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [ids[1], f.local]);
  const third = await seleccionarPaginaRecordatoriosPet(second.cursor, clock, 1);
  assert.deepEqual(third.candidatos.map(row => row.turnoId), [ids[2]]);
  assert.deepEqual((await seleccionarPaginaRecordatoriosPet(null, late, 1)).candidatos, []);
});

test("página inicial de 50 teléfonos inválidos no tapa el candidato válido posterior", async t => {
  const f = await createFixture(t);
  for (let i = 0; i < 50; i++) {
    const client = await insert("INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
      [f.local, tag, `x${f.local}-${i}`, `invalid-${i}`]);
    await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
      [f.local, f.mascota, client]);
    await createTurno(f, client);
  }
  const valid = await createTurno(f);
  const first = await seleccionarPaginaRecordatoriosPet(null, clock);
  assert.equal(first.candidatos.length, 0);
  assert.equal(first.hayMas, true);
  const second = await seleccionarPaginaRecordatoriosPet(first.cursor, clock);
  assert.deepEqual(second.candidatos.map(row => row.turnoId), [valid]);
  const sent: number[] = [];
  const result = await runPetReminderCycle({
    recover: async () => recovered,
    page: cursor => seleccionarPaginaRecordatoriosPet(cursor, clock),
    claim: (local, turno) => reclamarRecordatorioPet(local, turno, clock),
    process: async id => { sent.push(id); return "sent"; },
  });
  assert.equal(result.claimed, 1);
  assert.equal(sent.length, 1);
});

test("batch 20 cuenta reclamos ganados; >20 válidos quedan disponibles para corrida siguiente", async t => {
  assert.equal(PET_REMINDER_BATCH_SIZE, 20);
  const f = await createFixture(t);
  for (let i = 0; i < 25; i++) await createTurno(f);
  const processed: number[] = [];
  const deps: PetReminderCycleDependencies = {
    recover: async () => recovered,
    page: cursor => seleccionarPaginaRecordatoriosPet(cursor, clock, 7),
    claim: (local, turno) => reclamarRecordatorioPet(local, turno, clock),
    process: async id => { processed.push(id); return "sent"; },
  };
  assert.equal((await runPetReminderCycle(deps)).claimed, 20);
  assert.equal(processed.length, 20);
  assert.equal((await seleccionarPaginaRecordatoriosPet(null, clock)).candidatos.length, 5);
  assert.equal((await runPetReminderCycle(deps)).claimed, 5);
  assert.equal(processed.length, 25);
  assert.equal((await seleccionarPaginaRecordatoriosPet(null, clock)).candidatos.length, 0);
});

test("un candidato perdido por carrera y un item fallido no abortan siguientes", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const processed: number[] = [];
  const deps: PetReminderCycleDependencies = {
    recover: async () => recovered,
    page: async () => ({ candidatos: [candidate(1), candidate(2), candidate(3)], cursor: null, hayMas: false }),
    claim: async (_local, turno) => turno === 1 ? null : {
      recordatorioId: turno, turnoId: turno, localId: 1, clienteId: 1,
      telefonoCanonical: "+5491198765432",
    },
    process: async id => { processed.push(id); if (id === 2) throw new Error("SECRET_PHONE_MESSAGE"); return "unknown"; },
  };
  const result = await runPetReminderCycle(deps);
  assert.deepEqual([result.claimed, result.itemErrors, processed], [2, 1, [2, 3]]);
  assert.equal(JSON.stringify(logs).includes("SECRET_PHONE_MESSAGE"), false);
  assert.equal(logs.length, 1);
});

test("página completa ya no reclamable no bloquea la siguiente página", async () => {
  const processed: number[] = [];
  const deps: PetReminderCycleDependencies = {
    recover: async () => recovered,
    page: async cursor => cursor === null
      ? { candidatos: Array.from({ length: 50 }, (_, i) => candidate(i + 1)),
        cursor: { localId: 1, turnoId: 50 }, hayMas: true }
      : { candidatos: [candidate(51)], cursor: { localId: 1, turnoId: 51 }, hayMas: false },
    claim: async (_local, id) => id < 51 ? null
      : { ...candidate(id), recordatorioId: id },
    process: async id => { processed.push(id); return "sent"; },
  };
  const result = await runPetReminderCycle(deps);
  assert.equal(result.claimed, 1);
  assert.deepEqual(processed, [51]);
});

test("un local desconectado no consume todo el batch ni tapa otro tenant", async () => {
  const contacted: number[] = [];
  const deps: PetReminderCycleDependencies = {
    recover: async () => recovered,
    page: async () => ({ candidatos: [candidate(1), candidate(2), candidate(3),
      { ...candidate(4), localId: 2 }], cursor: null, hayMas: false }),
    claim: async (localId, turnoId) => ({ ...candidate(turnoId), localId, recordatorioId: turnoId }),
    process: async id => { contacted.push(id); return id < 4 ? "pending" : "sent"; },
  };
  assert.equal((await runPetReminderCycle(deps)).claimed, 2);
  assert.deepEqual(contacted, [1, 4]);
});

test("error DB estructural detiene corrida", async () => {
  const failure = Object.assign(new Error("TOKEN_PRIVATE"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
  const deps: PetReminderCycleDependencies = {
    recover: async () => recovered,
    page: async () => ({ candidatos: [candidate(1), candidate(2)], cursor: null, hayMas: false }),
    claim: async () => { throw failure; },
    process: async () => { throw new Error("unreachable"); },
  };
  await assert.rejects(runPetReminderCycle(deps), error => error === failure);
});

test("dos ciclos concurrentes usan MySQL como exclusión; un solo POST simulado", async t => {
  const f = await createFixture(t);
  await createTurno(f);
  let calls = 0;
  const provider = {
    connection: async () => "open" as const,
    send: async () => { calls++; return "FAKE_PROVIDER_ID"; },
  };
  const deps: PetReminderCycleDependencies = {
    recover: () => recuperarRecordatoriosPet(clock),
    page: cursor => seleccionarPaginaRecordatoriosPet(cursor, clock, 2),
    claim: (local, turno) => reclamarRecordatorioPet(local, turno, clock),
    process: id => procesarRecordatorioPet(id, clock, provider),
  };
  const [a, b] = await Promise.all([runPetReminderCycle(deps), runPetReminderCycle(deps)]);
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(calls, 1);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE local_id = ? AND estado = 'sent'", [f.local]))[0].n, 1);
});

test("registro true exacto configura */5 ART, no corre al registrarse y reporta error sano", async t => {
  assert.equal(isPetReminderSchedulerEnabled("true"), true);
  const scheduleCalls: unknown[][] = [];
  let callback: (() => Promise<void>) | undefined;
  let cycles = 0;
  const errorLogs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errorLogs.push(args); });
  const failure = new Error("TOKEN_PRIVATE");
  const schedule = ((expr: string, cb: () => Promise<void>, options: { timezone: string }) => {
    scheduleCalls.push([expr, options]); callback = cb; return { stop() {} };
  }) as Parameters<typeof startPetReminderScheduler>[1];
  assert.equal(startPetReminderScheduler("true", schedule, async () => { cycles++; throw failure; }), true);
  assert.deepEqual(scheduleCalls, [["*/5 * * * *", { timezone: "America/Argentina/Buenos_Aires" }]]);
  assert.equal(cycles, 0);
  assert.deepEqual([PET_REMINDER_CRON, PET_REMINDER_TIMEZONE], ["*/5 * * * *", "America/Argentina/Buenos_Aires"]);
  assert.ok(callback);
  await callback();
  assert.equal(cycles, 1);
  assert.equal(errorLogs.length, 1);
  assert.equal(JSON.stringify(errorLogs).includes("TOKEN_PRIVATE"), false);
  assert.equal(startPetReminderScheduler("true", schedule, async () => {}), true);
  assert.equal(scheduleCalls.length, 1);
});
