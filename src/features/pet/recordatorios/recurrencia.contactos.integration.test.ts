import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { pool } from "../../../config/db";
import { operarContactosRecurrencia, prepararFuenteContactosRecurrencia } from "./recurrencia.contactos";
import { simularRecurrenciaPet } from "./recurrencia.service";
import { sumarDiasCalendarioPet } from "./recurrencia.time";

const tag = `REC30IT_${randomUUID()}`;
const phone = "+5491123456789";
const newPhone = "+5491112345678";
const clock = async () => new Date("2026-11-19T13:00:00.000Z");
const ids: number[] = [];
const tables = ["locales", "clientes", "mascotas", "mascota_clientes", "mascota_servicios",
  "servicios", "turnos", "pet_recordatorios", "pet_recurrencia_contactos"] as const;
let baseline: number[];
interface Fixture { local: number; client: number }

async function rows(sql: string, values: unknown[] = []) {
  const [result] = await pool.query<RowDataPacket[]>(sql, values);
  return result;
}
async function insert(sql: string, values: unknown[]) {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}
async function counts() {
  return Promise.all(tables.map(async table => Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n)));
}
async function local(kind = "PET_GROOMING") {
  const id = await insert(`INSERT INTO locales
    (nombre, slug, business_type, activo, suscripcion_estado, suscripcion_vencimiento)
    VALUES (?, ?, ?, 1, 'activo', '2099-12-31')`, [tag, `${tag}-${ids.length}`, kind]);
  ids.push(id);
  return id;
}
async function fixture(): Promise<Fixture> {
  const id = await local();
  const client = await insert("INSERT INTO clientes (local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)",
    [id, tag, phone, phone]);
  return { local: id, client };
}
function grant(f: Fixture, canonical = phone) {
  return { tipo: "autorizacion", clienteId: f.client, telefonoCanonical: canonical,
    verificadaAt: "2026-11-01T12:00:00.000Z", referenciaVerificacion: `${tag}-authorization` };
}
function baja(canonical = phone) {
  return { tipo: "baja", telefonoCanonical: canonical, referenciaBaja: `${tag}-optout` };
}
async function operate(f: Fixture, operaciones: unknown, aplicar = true) {
  return operarContactosRecurrencia({ localId: f.local, operaciones, aplicar }, pool, clock);
}
async function contacts(id: number) {
  return rows("SELECT * FROM pet_recurrencia_contactos WHERE local_id = ? ORDER BY telefono_normalizado", [id]);
}
async function petTurn(f: Fixture, date: string, state = "completado") {
  const pet = await insert("INSERT INTO mascotas (local_id,nombre,activo,reserva_online_habilitada) VALUES (?,?,1,1)", [f.local, tag]);
  const service = await insert("INSERT INTO servicios (local_id,nombre,activo,duracion,precio) VALUES (?,?,1,NULL,NULL)", [f.local, tag]);
  await pool.query("INSERT INTO mascota_clientes (local_id,mascota_id,cliente_id) VALUES (?,?,?)", [f.local, pet, f.client]);
  await pool.query("INSERT INTO mascota_servicios (local_id,mascota_id,servicio_id,duracion_minutos) VALUES (?,?,?,30)", [f.local, pet, service]);
  const turno = await insert(`INSERT INTO turnos
    (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
     servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
    VALUES (?,?,?,?,?,?,'10:00','10:30',?,?,?,30,0)`,
  [f.local, pet, f.client, tag, phone, date, state, service, tag]);
  return { pet, service, turno };
}

before(async () => {
  // The existing test preload pins this pool to agenda_mysql/agenda_db before imports.
  const [table] = await rows("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_recurrencia_contactos'");
  assert.equal(table?.ENGINE, "InnoDB", "apply the approved local migration before integration tests");
  baseline = await counts();
});

after(async () => {
  try {
    for (const id of ids) {
      const [owner] = await rows("SELECT nombre,slug FROM locales WHERE id=?", [id]);
      if (!owner) continue; // The CASCADE test already deleted its own local.
      assert.equal(owner.nombre, tag, "fixture identity before cleanup");
      assert.ok(String(owner.slug).startsWith(tag));
      for (const table of ["turnos", "mascota_servicios", "mascota_clientes", "mascotas", "clientes", "servicios"]) {
        await pool.query(`DELETE FROM ${table} WHERE local_id=?`, [id]);
      }
      await pool.query("DELETE FROM locales WHERE id=? AND nombre=?", [id, tag]);
    }
    for (const id of ids) {
      for (const table of tables.filter(name => name !== "locales")) {
        assert.equal((await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE local_id=?`, [id]))[0].n, 0,
          `residual ${table} for own fixture`);
      }
    }
    assert.equal((await rows("SELECT COUNT(*) AS n FROM locales WHERE nombre=?", [tag]))[0].n, 0);
    if (baseline) assert.deepEqual(await counts(), baseline, "all baseline table counts restored");
    console.info("REC30 integration cleanup verified", { fixtures: ids.length, residuals: 0 });
  } finally { await pool.end(); }
});

test("schema real: PK local/teléfono, CHECKs enforced, FK al local y trigger BEFORE UPDATE", async () => {
  const pk = await rows(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_recurrencia_contactos' AND INDEX_NAME='PRIMARY'
    ORDER BY SEQ_IN_INDEX`);
  assert.deepEqual(pk.map(row => row.COLUMN_NAME), ["local_id", "telefono_normalizado"]);
  const checks = await rows(`SELECT CONSTRAINT_NAME,ENFORCED FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_recurrencia_contactos' AND CONSTRAINT_TYPE='CHECK'`);
  assert.equal(checks.length, 3);
  assert.ok(checks.every(row => row.ENFORCED === "YES"));
  const fk = await rows(`SELECT k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='pet_recurrencia_contactos'`);
  assert.deepEqual(fk.map(row => [row.COLUMN_NAME,row.REFERENCED_TABLE_NAME,row.DELETE_RULE]), [["local_id","locales","CASCADE"]]);
  const [trigger] = await rows(`SELECT ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='trg_pet_recurrencia_contacto_bu'`);
  assert.deepEqual([trigger.ACTION_TIMING,trigger.EVENT_MANIPULATION], ["BEFORE","UPDATE"]);
});

test("INSERT real: FK rechaza local inexistente y CHECKs rechazan estados/evidencia/teléfonos inválidos", async () => {
  const f = await fixture();
  const sql = `INSERT INTO pet_recurrencia_contactos
    (local_id,telefono_normalizado,estado,cliente_id_autorizado,verificada_at,referencia_verificacion,
     baja_at,referencia_baja,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`;
  await assert.rejects(pool.query(sql, [-1,phone,"baja",null,null,null,"2026-11-01",tag]), { errno: 1452 });
  const cases = [
    ["invalid","baja",null,null,null,"2026-11-01",tag],
    [phone,"otro",null,null,null,null,null],
    [phone,"autorizada",null,"2026-11-01",tag,null,null],
    [phone,"autorizada",f.client,"2026-11-01"," ",null,null],
    [phone,"autorizada",f.client,"2026-11-01",tag,"2026-11-02",tag],
    [phone,"baja",null,null,null,null,tag],
    [phone,"baja",f.client,null,null,"2026-11-01",tag],
  ];
  for (const values of cases) await assert.rejects(pool.query(sql, [f.local,...values]), { errno: 3819 });
  assert.equal((await contacts(f.local)).length, 0);
});

test("writer real: dry-run sin cambios, autorización idempotente y baja que ninguna importación pisa", async () => {
  const f = await fixture();
  assert.equal((await operate(f,[grant(f)],false)).simulacion, true);
  assert.equal((await contacts(f.local)).length, 0);
  await operate(f,[grant(f)]);
  const authorized = await contacts(f.local);
  assert.equal((await operate(f,[grant(f)])).resultados[0].resultado,"sin_cambios");
  assert.deepEqual(await contacts(f.local), authorized, "retry preserves evidence and timestamps");
  await operate(f,[baja()]);
  const optedOut = await contacts(f.local);
  assert.equal((await operate(f,[grant(f)])).resultados[0].resultado,"baja_respetada");
  assert.equal((await operate(f,[baja()])).resultados[0].resultado,"sin_cambios");
  assert.deepEqual(await contacts(f.local), optedOut);
});

test("trigger y UNIQUE reales: prohíben reactivación, identidad mutable y duplicación", async () => {
  const f = await fixture();
  await operate(f,[grant(f)]);
  await assert.rejects(pool.query(`UPDATE pet_recurrencia_contactos SET telefono_normalizado=?
    WHERE local_id=? AND telefono_normalizado=?`, [newPhone,f.local,phone]), { errno: 1644 });
  await assert.rejects(pool.query(`INSERT INTO pet_recurrencia_contactos
    (local_id,telefono_normalizado,estado,baja_at,referencia_baja,created_at,updated_at)
    VALUES (?,?,'baja',UTC_TIMESTAMP(3),?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [f.local,phone,tag]), { errno: 1062 });
  await operate(f,[baja()]);
  await assert.rejects(pool.query(`UPDATE pet_recurrencia_contactos
    SET estado='autorizada',baja_at=NULL,referencia_baja=NULL WHERE local_id=? AND telefono_normalizado=?`,
  [f.local,phone]), { errno: 1644 });
  assert.equal((await contacts(f.local))[0].estado,"baja");
});

test("aislamiento real: mismo número en dos locales, cliente ajeno y local BEAUTY rechazados", async () => {
  const a = await fixture(), b = await fixture();
  await operate(a,[baja()]);
  await operate(b,[grant(b)]);
  assert.equal((await contacts(a.local))[0].estado,"baja");
  assert.equal((await contacts(b.local))[0].estado,"autorizada");
  await assert.rejects(operate(b,[{...grant(b),clienteId:a.client}]), { code:"PET_RECURRENCE_CLIENT_PHONE_MISMATCH" });
  const beauty = await local("BEAUTY");
  await assert.rejects(operarContactosRecurrencia({localId:beauty,operaciones:[baja()],aplicar:true},pool,clock),
    {code:"PET_RECURRENCE_PET_LOCAL_REQUIRED"});
});

test("rollback real de lote: una fila posterior inválida revierte la autorización inicial", async () => {
  const f = await fixture();
  await assert.rejects(operate(f,[grant(f),{...grant(f),clienteId:2147483647,telefonoCanonical:newPhone}]),
    {code:"PET_RECURRENCE_CLIENT_PHONE_MISMATCH"});
  assert.equal((await contacts(f.local)).length,0);
});

test("baja sobrevive DELETE cliente y recreación; FK al local limpia solo el tenant eliminado", async () => {
  const f = await fixture();
  await operate(f,[grant(f)]); await operate(f,[baja()]);
  await pool.query("DELETE FROM clientes WHERE id=? AND local_id=?", [f.client,f.local]);
  const newClient = await insert("INSERT INTO clientes (local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)", [f.local,tag,phone,phone]);
  assert.notEqual(newClient,f.client);
  assert.equal((await operate({...f,client:newClient},[grant({...f,client:newClient})])).resultados[0].resultado,"baja_respetada");
  assert.equal((await contacts(f.local))[0].cliente_id_autorizado,f.client);
  const scoped = await local();
  await operarContactosRecurrencia({localId:scoped,operaciones:[baja()],aplicar:true},pool,clock);
  await pool.query("DELETE FROM locales WHERE id=? AND nombre=?", [scoped,tag]);
  assert.equal((await contacts(scoped)).length,0);
  assert.equal((await contacts(f.local)).length,1);
});

test("selector real con fuente persistida: ausencia, cambio de teléfono, permiso nuevo y baja", async () => {
  const f = await fixture();
  await petTurn(f,"2026-10-20");
  const simulate = () => simularRecurrenciaPet({localId:f.local,frontendUrl:"https://example.test"},pool,clock);
  assert.equal((await simulate()).exclusiones.AUTORIZACION_PENDIENTE,1);
  await operate(f,[grant(f)]);
  assert.equal((await simulate()).elegibles,1);
  await pool.query("UPDATE clientes SET telefono=?,telefono_normalizado=? WHERE id=? AND local_id=?", [newPhone,newPhone,f.client,f.local]);
  assert.equal((await simulate()).exclusiones.AUTORIZACION_PENDIENTE,1);
  await assert.rejects(operate(f,[grant(f)]),{code:"PET_RECURRENCE_CLIENT_PHONE_MISMATCH"});
  await operate(f,[grant(f,newPhone)]);
  assert.equal((await simulate()).elegibles,1);
  await operate(f,[baja(newPhone)]);
  assert.equal((await simulate()).exclusiones.BAJA,1);
});

test("SQL real: solo D30, nunca D29/D31/D40/D60; reserva posterior a D35 excluye", async () => {
  const f = await fixture();
  const due = await petTurn(f,"2026-10-20");
  for (const age of [29,31,40,60]) await petTurn(f,sumarDiasCalendarioPet("2026-11-19",-age));
  await operate(f,[grant(f)]);
  const simulate = () => simularRecurrenciaPet({localId:f.local,frontendUrl:"https://example.test"},pool,clock);
  assert.equal((await simulate()).elegibles,1);
  const future = await insert(`INSERT INTO turnos
    (local_id,mascota_id,cliente_id,cliente_nombre,cliente_telefono,fecha,hora,hora_fin,estado,
     servicio_id,servicio_nombre_snapshot,duracion_servicio_snapshot,alta_exigencia_snapshot)
    VALUES (?,?,?,?,?,'2027-01-01','10:00','10:30','activo',?,?,30,0)`,
  [f.local,due.pet,f.client,tag,phone,due.service,tag]);
  assert.equal((await simulate()).exclusiones.PROXIMA_RESERVA,1);
  await pool.query("UPDATE turnos SET estado='cancelado' WHERE id=? AND local_id=?",[future,f.local]);
  assert.equal((await simulate()).elegibles,1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve=done; });
  return {promise,resolve};
}
function controlledDb(holdCommit: boolean) {
  const entered = deferred(), release = deferred();
  let session = 0;
  return { entered, release, session: () => session, db: { getConnection: async () => {
    const connection = await pool.getConnection();
    const [[row]] = await connection.query<(RowDataPacket & {id:number})[]>("SELECT CONNECTION_ID() AS id");
    session = row.id;
    return new Proxy(connection, { get(target,prop) {
      if (prop === "commit" && holdCommit) return async () => { entered.resolve(); await release.promise; return target.commit(); };
      const value: unknown = Reflect.get(target,prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } };
}
async function waitForLock(session: () => number) {
  const deadline = Date.now()+8000;
  while (Date.now()<deadline) {
    if (session()) {
      const [row] = await rows(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?`,[session()]);
      if (Number(row.n)>0) return;
    }
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail("expected real InnoDB waiter before releasing winner");
}

for (const optoutFirst of [false,true]) {
  test(`carrera real ${optoutFirst ? "baja→importación" : "importación→baja"}: la baja prevalece`, {timeout:20000}, async () => {
    const f = await fixture();
    const winner = controlledDb(true), waiter = controlledDb(false);
    const first = operarContactosRecurrencia({localId:f.local,operaciones:[optoutFirst ? baja() : grant(f)],aplicar:true},winner.db,clock);
    let second: ReturnType<typeof operarContactosRecurrencia> | undefined;
    try {
      await Promise.race([winner.entered.promise, first.then(() => assert.fail("winner finished before barrier"))]);
      second = operarContactosRecurrencia({localId:f.local,operaciones:[optoutFirst ? grant(f) : baja()],aplicar:true},waiter.db,clock);
      void second.catch(() => undefined); // Assertion below awaits it; avoid an unhandled rejection while polling.
      await waitForLock(waiter.session);
    } finally {
      winner.release.resolve();
      await Promise.all([first,...(second ? [second] : [])]);
    }
    assert.equal((await contacts(f.local))[0].estado,"baja");
    assert.equal((await operate(f,[grant(f)])).resultados[0].resultado,"baja_respetada");
  });
}
