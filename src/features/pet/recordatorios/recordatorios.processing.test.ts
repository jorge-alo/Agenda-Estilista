import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { PET_REMINDER_STALE_MS, procesarRecordatorioPet, recuperarRecordatoriosPet } from "./recordatorios.processing";
import { reclamarRecordatorioPet, seleccionarRecordatoriosPet, type RelojRecordatorioPet } from "./recordatorios.service";

const tag = `NOTIF1B_${randomUUID()}`;
const clock: RelojRecordatorioPet = async () => new Date("2026-10-29T13:00:00.000Z");
const lateClock: RelojRecordatorioPet = async () => new Date("2026-10-29T15:00:00.000Z");
const ids: number[] = [];
interface Fixture { local: number; pet: number; client: number; turno: number; phone: string }
type Provider = NonNullable<Parameters<typeof procesarRecordatorioPet>[2]>;

async function query(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows;
}
async function insert(sql: string, params: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result.insertId;
}
async function fixture(): Promise<Fixture> {
  const local = await insert("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')",
    [tag, `${tag}-${ids.length}`]);
  ids.push(local);
  const phone = `+54911${String(local).padStart(8, "0")}`;
  const client = await insert("INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [local, tag, `11${String(local).padStart(8, "0")}`, phone]);
  const pet = await insert("INSERT INTO mascotas (local_id, nombre) VALUES (?, ?)", [local, `Pet_${tag}`]);
  await pool.query("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)", [local, pet, client]);
  const turno = await insert(
    `INSERT INTO turnos (local_id, mascota_id, cliente_id, fecha, hora, hora_fin, estado,
       cliente_nombre, cliente_telefono, servicio_nombre_snapshot, duracion_servicio_snapshot,
       alta_exigencia_snapshot, created_at)
     VALUES (?, ?, ?, '2026-10-30', '16:00', '16:30', 'activo', ?, 'snapshot-invalido',
       'Baño', 30, 0, '2026-10-29 12:59:59')`,
    [local, pet, client, tag],
  );
  return { local, pet, client, turno, phone };
}
async function claim(f: Fixture) {
  const result = await reclamarRecordatorioPet(f.local, f.turno, clock);
  assert.ok(result?.recordatorioId);
  return result.recordatorioId;
}
async function status(id: number) {
  const [row] = await query("SELECT estado, claimed_at, accepted_at, provider_message_id FROM pet_recordatorios WHERE id = ?", [id]);
  return row;
}
function mockProvider(state: "open" | "closed" | "unavailable" = "open") {
  let sends = 0;
  const provider: Provider = {
    connection: async () => state,
    send: async () => { sends++; return "EVOLUTION_TEST_ID"; },
  };
  return { provider, sends: () => sends };
}

after(async () => {
  try {
    for (const local of ids) {
      const [row] = await query("SELECT slug FROM locales WHERE id = ?", [local]);
      assert.ok(row?.slug?.startsWith(tag));
      await pool.query("DELETE FROM turnos WHERE local_id = ?", [local]);
      await pool.query("DELETE FROM mascota_clientes WHERE local_id = ?", [local]);
      await pool.query("DELETE FROM mascotas WHERE local_id = ?", [local]);
      await pool.query("DELETE FROM clientes WHERE local_id = ?", [local]);
      await pool.query("DELETE FROM locales WHERE id = ?", [local]);
    }
  } finally { await pool.end(); }
});

test("schema 003: estados y CHECKs de claimed_at en MySQL 8.4", async () => {
  const checks = await query(
    `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME IN
       ('chk_pet_recordatorios_estado', 'chk_pet_recordatorios_claim')`,
  );
  assert.equal(checks.length, 2);
  assert.ok(checks.some(row => row.CONSTRAINT_NAME === "chk_pet_recordatorios_estado"
    && row.CHECK_CLAUSE.includes("dispatching") && row.CHECK_CLAUSE.includes("skipped")));
  const f = await fixture();
  const id = await claim(f);
  await pool.query("UPDATE pet_recordatorios SET estado = 'dispatching' WHERE id = ? AND local_id = ?", [id, f.local]);
  assert.equal((await status(id)).estado, "dispatching");
  await pool.query("UPDATE pet_recordatorios SET estado = 'unknown' WHERE id = ? AND local_id = ?", [id, f.local]);
  assert.equal((await status(id)).estado, "unknown");
  await assert.rejects(pool.query("UPDATE pet_recordatorios SET estado = 'pending' WHERE id = ? AND local_id = ?", [id, f.local]),
    { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(pool.query("UPDATE pet_recordatorios SET estado = 'sent' WHERE id = ? AND local_id = ?", [id, f.local]),
    { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
});

test("éxito: solo receipt inequívoco pasa a sent; copy PET sin snapshot ni precios", async () => {
  const f = await fixture();
  const id = await claim(f);
  let calls = 0;
  const provider: Provider = {
    connection: async localId => { assert.equal(localId, String(f.local)); return "open"; },
    send: async (phone, message, localId) => {
      calls++;
      assert.equal(localId, String(f.local));
      assert.equal(phone, f.phone.slice(1));
      assert.ok(message.includes(`Pet_${tag}`) && message.includes(tag));
      assert.ok(message.includes("2026-10-30") && message.includes("16:00"));
      assert.ok(!message.includes("snapshot-invalido") && !message.includes("$") && !message.includes("http"));
      assert.equal((await status(id)).estado, "dispatching");
      return "EVOLUTION_ACCEPTED_ID";
    },
  };
  assert.equal(await procesarRecordatorioPet(id, clock, provider), "sent");
  const saved = await status(id);
  assert.equal(saved.estado, "sent");
  assert.ok(saved.accepted_at);
  assert.equal(saved.provider_message_id, "EVOLUTION_ACCEPTED_ID");
  assert.equal(await procesarRecordatorioPet(id, clock, provider), "not_owned");
  assert.equal(calls, 1);
});

test("cancelado, reprogramado, desvinculado, cliente borrado y teléfono inválido no envían", async () => {
  for (const change of ["cancel", "reschedule", "unlink", "delete", "phone-null", "phone-invalid"] as const) {
    const f = await fixture();
    const id = await claim(f);
    if (change === "cancel") await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [f.turno, f.local]);
    if (change === "reschedule") await pool.query("UPDATE turnos SET fecha = '2026-10-31' WHERE id = ? AND local_id = ?", [f.turno, f.local]);
    if (change === "unlink") await pool.query("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [f.pet, f.client, f.local]);
    if (change === "delete") await pool.query("DELETE FROM clientes WHERE id = ? AND local_id = ?", [f.client, f.local]);
    if (change.startsWith("phone")) await pool.query(
      "UPDATE clientes SET telefono_normalizado = ? WHERE id = ? AND local_id = ?",
      [change === "phone-null" ? null : "invalido", f.client, f.local],
    );
    const mock = mockProvider();
    assert.equal(await procesarRecordatorioPet(id, clock, mock.provider), "skipped", change);
    assert.equal((await status(id)).estado, "skipped");
    assert.equal(await procesarRecordatorioPet(id, clock, mock.provider), "not_owned");
    assert.equal(mock.sends(), 0);
  }
});

test("fuera de ventana no envía ni consulta conexión; fila terminal skipped", async () => {
  const f = await fixture();
  const id = await claim(f);
  const mock = mockProvider();
  assert.equal(await procesarRecordatorioPet(id, lateClock, mock.provider), "skipped");
  assert.equal(mock.sends(), 0);
});

test("desconexión explícita: pending re-reclamable sin duplicar identidad; vencida: skipped", async () => {
  const f = await fixture();
  const id = await claim(f);
  const disconnected = mockProvider("closed");
  assert.equal(await procesarRecordatorioPet(id, clock, disconnected.provider), "pending");
  assert.equal((await status(id)).claimed_at, null);
  assert.equal(disconnected.sends(), 0);
  assert.ok((await seleccionarRecordatoriosPet(clock)).some(row => row.turnoId === f.turno));
  const [a, b] = await Promise.all([
    reclamarRecordatorioPet(f.local, f.turno, clock), reclamarRecordatorioPet(f.local, f.turno, clock),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal((a ?? b)?.recordatorioId, id);
  assert.equal((await query("SELECT COUNT(*) AS n FROM pet_recordatorios WHERE turno_id = ?", [f.turno]))[0].n, 1);
  let now = new Date("2026-10-29T13:00:00Z");
  const dynamicClock: RelojRecordatorioPet = async () => now;
  const delayed: Provider = {
    connection: async () => { now = new Date("2026-10-29T15:00:00Z"); return "closed"; },
    send: async () => { throw new Error("SEND_MUST_NOT_START"); },
  };
  assert.equal(await procesarRecordatorioPet(id, dynamicClock, delayed), "skipped");
  assert.equal((await status(id)).estado, "skipped");
});

test("GET de conexión ambiguo antes del POST puede volver a pending", async () => {
  const f = await fixture();
  const id = await claim(f);
  const unavailable = mockProvider("unavailable");
  assert.equal(await procesarRecordatorioPet(id, clock, unavailable.provider), "pending");
  assert.equal(unavailable.sends(), 0);
});

test("timeout y respuesta ambigua después de dispatching pasan a unknown sin reenvío", async () => {
  for (const failure of ["timeout", "ambiguous"] as const) {
    const f = await fixture();
    const id = await claim(f);
    let calls = 0;
    const provider: Provider = {
      connection: async () => "open",
      send: async () => { calls++; if (failure === "timeout") throw new Error("TIMEOUT_TEST"); return null; },
    };
    assert.equal(await procesarRecordatorioPet(id, clock, provider), "unknown");
    assert.equal((await status(id)).estado, "unknown");
    assert.equal(await procesarRecordatorioPet(id, clock, provider), "not_owned");
    assert.equal(calls, 1);
  }
});

test("dos processors de sending compiten por dispatching: máximo un HTTP", async () => {
  const f = await fixture();
  const id = await claim(f);
  let sends = 0;
  const provider: Provider = {
    connection: async () => "open",
    send: async () => { sends++; await new Promise(resolve => setTimeout(resolve, 30)); return "EVOLUTION_ID"; },
  };
  const results = await Promise.all([
    procesarRecordatorioPet(id, clock, provider), procesarRecordatorioPet(id, clock, provider),
  ]);
  assert.deepEqual(results.sort(), ["not_owned", "sent"]);
  assert.equal(sends, 1);
  assert.equal((await status(id)).estado, "sent");
});

test("cancelación durante el preflight se revalida antes de dispatching", async () => {
  const f = await fixture();
  const id = await claim(f);
  let sends = 0;
  const provider: Provider = {
    connection: async () => {
      await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [f.turno, f.local]);
      return "open";
    },
    send: async () => { sends++; return "SHOULD_NOT_SEND"; },
  };
  assert.equal(await procesarRecordatorioPet(id, clock, provider), "skipped");
  assert.equal((await status(id)).estado, "skipped");
  assert.equal(sends, 0);
});

test("worker viejo no despacha tras recovery sending y nuevo reclamo de la misma fila", async () => {
  const f = await fixture();
  const id = await claim(f);
  let entered!: () => void;
  const preflightEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const preflightRelease = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const oldProvider: Provider = {
    connection: async () => { entered(); await preflightRelease; return "open"; },
    send: async () => { calls++; return "STALE_WORKER_CANNOT_SEND"; },
  };
  const old = procesarRecordatorioPet(id, clock, oldProvider);
  await preflightEntered;
  await pool.query("UPDATE pet_recordatorios SET claimed_at = '2026-10-29 12:56:59' WHERE id = ?", [id]);
  assert.equal((await recuperarRecordatoriosPet(clock)).pending, 1);
  assert.equal((await reclamarRecordatorioPet(f.local, f.turno, clock))?.recordatorioId, id);
  release();
  assert.equal(await old, "not_owned");
  assert.equal(calls, 0);
  const winner = mockProvider();
  assert.equal(await procesarRecordatorioPet(id, clock, winner.provider), "sent");
  assert.equal(winner.sends(), 1);
});

test("recovery: stale sending en ventana -> pending, luego puede reclamarse; fuera -> skipped", async () => {
  assert.equal(PET_REMINDER_STALE_MS, 180_000);
  const inside = await fixture();
  const inId = await claim(inside);
  const outside = await fixture();
  const outId = await claim(outside);
  await pool.query("UPDATE pet_recordatorios SET claimed_at = '2026-10-29 12:56:59' WHERE id IN (?, ?)", [inId, outId]);
  const insideRecovery = await recuperarRecordatoriosPet(clock);
  assert.ok(insideRecovery.pending >= 2);
  assert.equal((await status(inId)).estado, "pending");
  assert.equal((await status(inId)).claimed_at, null);
  assert.equal((await reclamarRecordatorioPet(inside.local, inside.turno, clock))?.recordatorioId, inId);
  // Make the second sending stale again, then recover after the window.
  await pool.query("UPDATE pet_recordatorios SET estado = 'sending', claimed_at = '2026-10-29 12:56:59' WHERE id = ?", [outId]);
  const outsideRecovery = await recuperarRecordatoriosPet(lateClock);
  assert.ok(outsideRecovery.skipped >= 1);
  assert.equal((await status(outId)).estado, "skipped");
  assert.deepEqual(await recuperarRecordatoriosPet(lateClock), { pending: 0, skipped: 0, unknown: 0 });
});

test("recovery stale sending con turno cancelado dentro de ventana queda skipped", async () => {
  const f = await fixture();
  const id = await claim(f);
  await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [f.turno, f.local]);
  await pool.query("UPDATE pet_recordatorios SET claimed_at = '2026-10-29 12:56:59' WHERE id = ? AND local_id = ?", [id, f.local]);
  assert.equal((await recuperarRecordatoriosPet(clock)).skipped, 1);
  assert.equal((await status(id)).estado, "skipped");
});

test("crash durante dispatching: recovery unknown, worker tardío no pisa resultado ni reenvía", async () => {
  const f = await fixture();
  const id = await claim(f);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let complete!: (receipt: string) => void;
  const response = new Promise<string>(resolve => { complete = resolve; });
  let calls = 0;
  const provider: Provider = {
    connection: async () => "open",
    send: async () => { calls++; started(); return response; },
  };
  const processing = procesarRecordatorioPet(id, clock, provider);
  await entered;
  assert.equal((await status(id)).estado, "dispatching");
  await pool.query("UPDATE pet_recordatorios SET claimed_at = '2026-10-29 12:56:59' WHERE id = ?", [id]);
  assert.equal((await recuperarRecordatoriosPet(clock)).unknown, 1);
  complete("ACCEPTED_AFTER_CRASH_SIMULATION");
  assert.equal(await processing, "unknown");
  assert.equal((await status(id)).estado, "unknown");
  assert.equal(await procesarRecordatorioPet(id, clock, provider), "not_owned");
  assert.equal(calls, 1);
});
