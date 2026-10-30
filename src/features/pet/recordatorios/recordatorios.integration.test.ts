import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { cancelarTurnoPet } from "../turnos/turnos.service";
import { reclamarRecordatorioPet, seleccionarRecordatoriosPet, type RelojRecordatorioPet } from "./recordatorios.service";

const tag = `NOTIF01_${randomUUID()}`;
const fecha = "2026-10-30";
const hoy = "2026-10-29";
const clock: RelojRecordatorioPet = async () => new Date("2026-10-29T13:00:00.000Z");
const lateClock: RelojRecordatorioPet = async () => new Date("2026-10-29T15:00:00.000Z");
const ids: number[] = [];
interface Fixture { local: number; pet: number; client: number; service: number; stylist: number | null }
let pet!: Fixture;
let other!: Fixture;
let beauty!: Fixture;

async function insert(sql: string, params: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result.insertId;
}

async function fixture(kind: "PET_GROOMING" | "BEAUTY"): Promise<Fixture> {
  const local = await insert("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)",
    [tag, `${tag}-${ids.length}`, kind]);
  ids.push(local);
  const client = await insert(
    "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [local, tag, `11${String(local).padStart(8, "0")}`, `+54911${String(local).padStart(8, "0")}`],
  );
  const service = await insert("INSERT INTO servicios (local_id, nombre, duracion) VALUES (?, ?, 30)", [local, tag]);
  if (kind === "BEAUTY") {
    const stylist = await insert("INSERT INTO estilistas (local_id, nombre) VALUES (?, ?)", [local, tag]);
    return { local, pet: 0, client, service, stylist };
  }
  const petId = await insert("INSERT INTO mascotas (local_id, nombre) VALUES (?, ?)", [local, tag]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
    [local, petId, client]);
  return { local, pet: petId, client, service, stylist: null };
}

async function turno(f: Fixture, options: { date?: string; state?: string; created?: string | null } = {}): Promise<number> {
  return insert(
    `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, mascota_id,
       cliente_id, cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
       duracion_servicio_snapshot, alta_exigencia_snapshot, estado, created_at)
     VALUES (?, ?, '16:00', '16:30', ?, ?, ?, ?, 'no-usar-snapshot', ?, ?, ?, ?, ?, ?)`,
    [f.local, options.date ?? fecha, f.stylist, f.pet || null, f.client, tag, f.service,
      f.pet ? tag : null, f.pet ? 30 : null, f.pet ? 0 : null,
      options.state ?? "activo", options.created === undefined ? "2026-10-29 12:59:59" : options.created],
  );
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params);
  return result;
}

before(async () => { pet = await fixture("PET_GROOMING"); other = await fixture("PET_GROOMING"); beauty = await fixture("BEAUTY"); });
after(async () => {
  try {
    for (const id of ids) {
      const [local] = await rows("SELECT slug FROM locales WHERE id = ?", [id]);
      assert.ok(local?.slug?.startsWith(tag), "fixture identity before cleanup");
      await pool.query("DELETE FROM turnos WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM mascotas WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM clientes WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM estilistas WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM servicios WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    }
  } finally { await pool.end(); }
});

test("schema: tipos, CHECK de identidad/estado, UNIQUE independientes y FK tenant-aware", async () => {
  const [table] = await rows("SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recordatorios'");
  assert.equal(table.ENGINE, "InnoDB");
  assert.equal(table.TABLE_COLLATION, "utf8mb4_0900_ai_ci");
  const [idx] = await rows("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turnos' AND INDEX_NAME = 'uq_turnos_id_local_recordatorios'");
  assert.equal(idx.n, 2);
  const [column] = await rows("SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recordatorios' AND COLUMN_NAME = 'cliente_local_id'");
  assert.deepEqual([column.DATA_TYPE, column.IS_NULLABLE], ["int", "YES"]);
  const recipientFk = await rows(
    `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'pet_recordatorios'
       AND k.REFERENCED_TABLE_NAME = 'clientes' ORDER BY k.ORDINAL_POSITION`,
  );
  assert.deepEqual(recipientFk.map(row => [row.CONSTRAINT_NAME, row.COLUMN_NAME, row.REFERENCED_COLUMN_NAME, row.DELETE_RULE]), [
    ["fk_pet_recordatorios_destinatario", "cliente_id", "id", "SET NULL"],
    ["fk_pet_recordatorios_destinatario", "cliente_local_id", "local_id", "SET NULL"],
  ]);
  const triggers = await rows(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'pet_recordatorios' ORDER BY TRIGGER_NAME`,
  );
  assert.deepEqual(triggers.map(row => [row.TRIGGER_NAME, row.EVENT_MANIPULATION, row.ACTION_TIMING]), [
    ["trg_pet_recordatorios_destinatario_bi", "INSERT", "BEFORE"],
    ["trg_pet_recordatorios_destinatario_bu", "UPDATE", "BEFORE"],
  ]);
  const a = await turno(pet);
  const b = await turno(pet, { state: "cancelado" });
  const valid = () => insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, a],
  );
  await valid();
  await assert.rejects(valid(), { code: "ER_DUP_ENTRY" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', NULL, 'pending', UTC_TIMESTAMP(3))`, [pet.local],
  ), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, 'failed', UTC_TIMESTAMP(3))`, [pet.local, b],
  ), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, 'sending', UTC_TIMESTAMP(3))`, [pet.local, b],
  ), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  const pending = await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, b],
  );
  await pool.query("UPDATE pet_recordatorios SET estado = 'sending', claimed_at = UTC_TIMESTAMP(3) WHERE id = ? AND local_id = ?", [pending, pet.local]);
  await pool.query("UPDATE pet_recordatorios SET estado = 'unknown' WHERE id = ? AND local_id = ?", [pending, pet.local]);
  await pool.query("UPDATE pet_recordatorios SET estado = 'sent', accepted_at = UTC_TIMESTAMP(3) WHERE id = ? AND local_id = ?", [pending, pet.local]);
  assert.equal((await rows("SELECT estado FROM pet_recordatorios WHERE id = ?", [pending]))[0].estado, "sent");
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, 'pending', UTC_TIMESTAMP(3))`, [other.local, a],
  ), { code: "ER_NO_REFERENCED_ROW_2" });
  const completed = await turno(pet, { date: hoy, state: "completado" });
  const recurrence = () => insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, ultimo_turno_completado_id, estado, created_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, pet.pet, completed],
  );
  await recurrence();
  await assert.rejects(recurrence(), { code: "ER_DUP_ENTRY" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, estado, created_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, pet.pet],
  ), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, ultimo_turno_completado_id, estado, created_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, ?, 'pending', UTC_TIMESTAMP(3))`, [other.local, other.pet, completed],
  ), { code: "ER_NO_REFERENCED_ROW_2" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, mascota_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, b, pet.pet],
  ), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
    [pet.local, await turno(pet, { state: "cancelado" }), other.client, pet.local],
  ), { code: "ER_NO_REFERENCED_ROW_2" });
  const nextCycle = await turno(pet, { date: hoy, state: "completado" });
  await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, ultimo_turno_completado_id, estado, created_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, ?, 'pending', UTC_TIMESTAMP(3))`, [pet.local, pet.pet, nextCycle],
  );
  await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [a, pet.local]);
  assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE turno_id = ?", [a])).length, 0,
    "existing SuperAdmin DELETE turnos order cascades reminder");
});

test("triggers y FK: par nulo o del propio tenant permitido; combinaciones inválidas rechazadas", async () => {
  const nullRecipientTurn = await turno(pet, { state: "cancelado" });
  const nullRecipient = await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, NULL, NULL, 'pending', UTC_TIMESTAMP(3))`,
    [pet.local, nullRecipientTurn],
  );
  const valid = await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
    [pet.local, await turno(pet, { state: "cancelado" }), pet.client, pet.local],
  );
  assert.equal((await rows("SELECT cliente_id, cliente_local_id FROM pet_recordatorios WHERE id = ?", [valid]))[0].cliente_local_id, pet.local);
  const badRecipient = async (cliente: number | null, local: number | null) => insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
    [pet.local, await turno(pet, { state: "cancelado" }), cliente, local],
  );
  for (const [cliente, local] of [[pet.client, null], [null, pet.local], [pet.client, other.local], [other.client, other.local]] as const) {
    await assert.rejects(badRecipient(cliente, local), { code: "ER_SIGNAL_EXCEPTION" });
  }
  await assert.rejects(badRecipient(other.client, pet.local), { code: "ER_NO_REFERENCED_ROW_2" });
  await assert.rejects(pool.query(
    "UPDATE pet_recordatorios SET cliente_local_id = NULL WHERE id = ? AND local_id = ?", [valid, pet.local],
  ), { code: "ER_SIGNAL_EXCEPTION" });
  await assert.rejects(pool.query(
    "UPDATE pet_recordatorios SET cliente_id = ? WHERE id = ? AND local_id = ?", [other.client, valid, pet.local],
  ), { code: "ER_NO_REFERENCED_ROW_2" });
  await pool.query("UPDATE pet_recordatorios SET cliente_id = NULL, cliente_local_id = NULL WHERE id = ? AND local_id = ?", [valid, pet.local]);
  assert.equal((await rows("SELECT cliente_id, cliente_local_id FROM pet_recordatorios WHERE id = ?", [valid]))[0].cliente_id, null);
  assert.equal((await rows("SELECT cliente_id, cliente_local_id FROM pet_recordatorios WHERE id = ?", [nullRecipient]))[0].cliente_local_id, null);
});

test("DELETE cliente no borra sent ni sending; otro responsable no puede recrear el mismo ciclo", async () => {
  const f = await fixture("PET_GROOMING");
  const completed = await turno(f, { date: hoy, state: "completado" });
  const future = await turno(f);
  const recurrence = await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, ultimo_turno_completado_id,
       cliente_id, cliente_local_id, estado, created_at, claimed_at, accepted_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, ?, ?, ?, 'sent', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [f.local, f.pet, completed, f.client, f.local],
  );
  const appointment = await insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id,
       estado, created_at, claimed_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'sending', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [f.local, future, f.client, f.local],
  );
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ? AND mascota_id = ? AND cliente_id = ?", [f.local, f.pet, f.client]);
  assert.equal((await rows("SELECT cliente_id FROM pet_recordatorios WHERE id = ?", [recurrence]))[0].cliente_id, f.client,
    "unlink must not alter a persisted reminder");
  await pool.query("DELETE FROM clientes WHERE id = ? AND local_id = ?", [f.client, f.local]);
  const surviving = await rows(
    "SELECT id, local_id, tipo, estado, turno_id, mascota_id, ultimo_turno_completado_id, cliente_id, cliente_local_id, claimed_at, accepted_at FROM pet_recordatorios WHERE id IN (?, ?) ORDER BY id",
    [recurrence, appointment],
  );
  assert.equal(surviving.length, 2);
  const cycle = surviving.find(row => row.id === recurrence);
  const reminder = surviving.find(row => row.id === appointment);
  assert.deepEqual([cycle?.local_id, cycle?.tipo, cycle?.estado, cycle?.mascota_id, cycle?.ultimo_turno_completado_id, cycle?.cliente_id, cycle?.cliente_local_id],
    [f.local, "RECURRENCE_DAY_30", "sent", f.pet, completed, null, null]);
  assert.ok(cycle?.claimed_at && cycle?.accepted_at);
  assert.deepEqual([reminder?.local_id, reminder?.estado, reminder?.turno_id, reminder?.cliente_id, reminder?.cliente_local_id],
    [f.local, "sending", future, null, null]);
  assert.ok(reminder?.claimed_at);
  const client2 = await insert("INSERT INTO clientes (local_id, nombre, telefono) VALUES (?, ?, ?)",
    [f.local, tag, `22${String(f.local).padStart(8, "0")}`]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [f.local, f.pet, client2]);
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, mascota_id, ultimo_turno_completado_id,
       cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'RECURRENCE_DAY_30', ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
    [f.local, f.pet, completed, client2, f.local],
  ), { code: "ER_DUP_ENTRY" });
  await assert.rejects(insert(
    `INSERT INTO pet_recordatorios (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
     VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
    [f.local, future, client2, f.local],
  ), { code: "ER_DUP_ENTRY" });
  await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [future, f.local]);
  assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE id = ?", [appointment])).length, 0);
  await pool.query("DELETE FROM turnos WHERE id = ? AND local_id = ?", [completed, f.local]);
  assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE id = ?", [recurrence])).length, 0);
  // A real pet with a historical completed turn cannot be hard-deleted before its turns:
  // the existing turnos.mascota_id FK is RESTRICT. After the turns, deletion cleans the pet.
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ? AND mascota_id = ?", [f.local, f.pet]);
  await pool.query("DELETE FROM mascotas WHERE id = ? AND local_id = ?", [f.pet, f.local]);
  await pool.query("DELETE FROM clientes WHERE local_id = ?", [f.local]);
  await pool.query("DELETE FROM servicios WHERE local_id = ?", [f.local]);
  await pool.query("DELETE FROM locales WHERE id = ?", [f.local]);
  assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE local_id = ?", [f.local])).length, 0);
  assert.equal((await rows("SELECT id FROM locales WHERE id = ?", [f.local])).length, 0);
  ids.splice(ids.indexOf(f.local), 1);
});

test("selector: corte estricto, NULL, fecha, estado, tenant, teléfono y ventana", async () => {
  const eligible = await turno(pet);
  const previous = await turno(pet, { created: "2026-10-28 22:00:00" });
  const boundary = await turno(pet, { created: "2026-10-29 13:00:00" });
  await turno(pet, { created: "2026-10-29 13:05:00" });
  await turno(pet, { created: null });
  await turno(pet, { date: "2026-10-31" });
  for (const state of ["cancelado", "completado", "pendiente_pago"]) await turno(pet, { state });
  await turno(beauty);
  const otherTurno = await turno(other);
  const selected = await seleccionarRecordatoriosPet(clock);
  assert.deepEqual(selected.map(row => row.turnoId).sort((a, b) => a - b), [eligible, previous, otherTurno].sort((a, b) => a - b));
  assert.equal(selected.find(row => row.turnoId === eligible)?.localId, pet.local);
  assert.equal(selected.find(row => row.turnoId === otherTurno)?.localId, other.local);
  assert.ok(!selected.some(row => row.turnoId === boundary));
  assert.deepEqual(await seleccionarRecordatoriosPet(lateClock), []);
  const invalid = await turno(pet);
  await pool.query("UPDATE clientes SET telefono_normalizado = NULL WHERE id = ? AND local_id = ?", [pet.client, pet.local]);
  assert.ok(!(await seleccionarRecordatoriosPet(clock)).some(row => row.turnoId === invalid));
  await pool.query("UPDATE clientes SET telefono_normalizado = 'invalido' WHERE id = ? AND local_id = ?", [pet.client, pet.local]);
  assert.equal(await reclamarRecordatorioPet(pet.local, invalid, clock), null);
  await pool.query("UPDATE clientes SET telefono_normalizado = ? WHERE id = ? AND local_id = ?",
    [`+54911${String(pet.local).padStart(8, "0")}`, pet.client, pet.local]);
});

test("comparación temporal SQL estricta: 09:59:59.999 ART entra y 10:00:00.000 no", async () => {
  // The existing turnos.created_at is TIMESTAMP(0), so it cannot store milliseconds;
  // verify the strict SQL boundary at DATETIME(3) precision without changing that column.
  const compared = await rows(
    `SELECT CAST(? AS DATETIME(3)) < CAST(? AS DATETIME(3)) AS beforeCutoff,
            CAST(? AS DATETIME(3)) < CAST(? AS DATETIME(3)) AS atCutoff,
            CAST(? AS DATETIME(3)) < CAST(? AS DATETIME(3)) AS afterCutoff`,
    ["2026-10-29 12:59:59.999", "2026-10-29 13:00:00.000",
      "2026-10-29 13:00:00.000", "2026-10-29 13:00:00.000",
      "2026-10-29 13:05:00.000", "2026-10-29 13:00:00.000"],
  );
  assert.deepEqual([compared[0].beforeCutoff, compared[0].atCutoff, compared[0].afterCutoff], [1, 0, 0]);
});

test("reclamo revalida cancelación, reprogramación, vínculo, teléfono, fecha y tenant", async () => {
  const canceled = await turno(pet);
  const rescheduled = await turno(pet);
  const unlinked = await turno(other);
  const candidates = await seleccionarRecordatoriosPet(clock);
  assert.ok(candidates.some(candidate => candidate.turnoId === canceled));
  assert.ok(candidates.some(candidate => candidate.turnoId === rescheduled));
  assert.ok(candidates.some(candidate => candidate.turnoId === unlinked));
  await cancelarTurnoPet(pet.local, canceled);
  await pool.query("UPDATE turnos SET fecha = '2026-10-31' WHERE id = ? AND local_id = ?", [rescheduled, pet.local]);
  await pool.query("DELETE FROM mascota_clientes WHERE local_id = ? AND mascota_id = ? AND cliente_id = ?",
    [other.local, other.pet, other.client]);
  assert.equal(await reclamarRecordatorioPet(pet.local, canceled, clock), null);
  assert.equal(await reclamarRecordatorioPet(pet.local, rescheduled, clock), null);
  assert.equal(await reclamarRecordatorioPet(other.local, unlinked, clock), null);
  assert.equal(await reclamarRecordatorioPet(other.local, rescheduled, clock), null);
  assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE turno_id IN (?, ?, ?)",
    [canceled, rescheduled, unlinked])).length, 0);
  // Reprogramming keeps original created_at and uses CURRENT date, not the selector snapshot.
  await pool.query("UPDATE turnos SET fecha = ? WHERE id = ? AND local_id = ?", [fecha, rescheduled, pet.local]);
  const won = await reclamarRecordatorioPet(pet.local, rescheduled, clock);
  assert.equal(won?.clienteId, pet.client);
  assert.equal(won?.telefonoCanonical, `+54911${String(pet.local).padStart(8, "0")}`);
  const [persisted] = await rows("SELECT estado, claimed_at, accepted_at, cliente_id, cliente_local_id FROM pet_recordatorios WHERE id = ?", [won?.recordatorioId]);
  assert.deepEqual([persisted.estado, persisted.cliente_id, persisted.cliente_local_id], ["sending", pet.client, pet.local]);
  assert.equal(await reclamarRecordatorioPet(pet.local, rescheduled, clock), null);
  assert.ok(!(await seleccionarRecordatoriosPet(clock)).some(candidate => candidate.turnoId === rescheduled));
  assert.equal(await reclamarRecordatorioPet(pet.local, await turno(pet), lateClock), null);
});

test("reclamo iniciado con writer activo relee cancelación bajo el lock existente", async () => {
  const id = await turno(pet);
  const selected = await seleccionarRecordatoriosPet(clock);
  assert.ok(selected.some(candidate => candidate.turnoId === id));
  const writer = await pool.getConnection();
  try {
    await writer.beginTransaction();
    await writer.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [pet.local]);
    await writer.query("SELECT id FROM turnos WHERE id = ? AND local_id = ? FOR UPDATE", [id, pet.local]);
    await writer.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [id, pet.local]);
    const claim = reclamarRecordatorioPet(pet.local, id, clock);
    await new Promise(resolve => setTimeout(resolve, 40));
    await writer.commit();
    assert.equal(await claim, null);
    assert.equal((await rows("SELECT id FROM pet_recordatorios WHERE turno_id = ?", [id])).length, 0);
  } finally { writer.release(); }
});

test("dos workers independientes: una identidad y un único derecho a procesar", async () => {
  const id = await turno(pet);
  const [first, second] = await Promise.all([
    reclamarRecordatorioPet(pet.local, id, clock), reclamarRecordatorioPet(pet.local, id, clock),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  const saved = await rows("SELECT id, estado, claimed_at FROM pet_recordatorios WHERE local_id = ? AND turno_id = ?", [pet.local, id]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].estado, "sending");
  assert.ok(saved[0].claimed_at);
});

test("selector y reclamo restauran el timezone original de la conexión compartida", async t => {
  const connection = await pool.getConnection();
  const release = connection.release.bind(connection);
  try {
    await connection.query("SET time_zone = '+02:00'");
    t.mock.method(connection, "release", () => {});
    t.mock.method(pool, "getConnection", async () => connection);
    await seleccionarRecordatoriosPet(clock);
    let [current] = await connection.query<RowDataPacket[]>("SELECT @@session.time_zone AS zone");
    assert.equal(current[0].zone, "+02:00");
    await reclamarRecordatorioPet(pet.local, -1, clock);
    [current] = await connection.query<RowDataPacket[]>("SELECT @@session.time_zone AS zone");
    assert.equal(current[0].zone, "+02:00");
  } finally {
    t.mock.restoreAll();
    await connection.query("SET time_zone = 'SYSTEM'");
    release();
  }
});
