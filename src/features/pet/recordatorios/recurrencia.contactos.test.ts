import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { operarContactosRecurrencia, validarLoteContactosRecurrencia, prepararFuenteContactosRecurrencia } from "./recurrencia.contactos";
import { argumentosContactosRecurrencia } from "../../../scripts/pet-recurrencia-contactos";

const phone = "+5491112345678";
const otherPhone = "+5491123456789";
const now = async () => new Date("2026-11-19T13:00:00.000Z");
const grant = { tipo: "autorizacion", clienteId: 10, telefonoCanonical: phone,
  verificadaAt: "2026-11-01T12:00:00.000Z", referenciaVerificacion: "evidence-fixture" };
const optOut = { tipo: "baja", telefonoCanonical: phone, referenciaBaja: "optout-fixture" };
interface Stored { estado: string; cliente_id_autorizado: number | null }

/** Transactional double only. Never applies the migration or writes fixtures in MySQL. */
function modelo() {
  const contacts = new Map<string, Stored>();
  const clients = new Map([["1:10", phone], ["2:20", phone]]);
  const calls: string[] = [];
  let draft = new Map(contacts);
  let readonly = false;
  let closed = false;
  const query = (async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.startsWith("START TRANSACTION")) { readonly = true; draft = new Map(contacts); return [[], []]; }
    if (sql.includes("FROM locales")) return [[Number(params[0]) === 1 || Number(params[0]) === 2 ? { id: params[0] } : undefined].filter(Boolean), []];
    if (sql.includes("FROM clientes")) {
      const p = clients.get(`${params[1]}:${params[0]}`);
      return [p ? [{ telefono_normalizado: p }] : [], []];
    }
    if (sql.includes("FROM pet_recurrencia_contactos")) {
      const row = draft.get(`${params[0]}:${params[1]}`);
      return [sql.includes("LIMIT 0") ? [] : row ? [{ ...row }] : [], []];
    }
    assert.ok(!readonly, "dry run cannot write");
    if (sql.startsWith("INSERT")) {
      const key = `${params[0]}:${params[1]}`;
      assert.ok(!draft.has(key), "no replace/upsert can delete or overwrite an opt-out");
      draft.set(key, { estado: sql.includes("'autorizada'") ? "autorizada" : "baja",
        cliente_id_autorizado: sql.includes("'autorizada'") ? Number(params[2]) : null });
    } else if (sql.startsWith("UPDATE")) {
      const key = `${params[1]}:${params[2]}`;
      assert.equal(draft.get(key)?.estado, "autorizada");
      draft.set(key, { ...draft.get(key)!, estado: "baja" });
    } else assert.fail("unexpected SQL");
    return [{ affectedRows: 1 }, []];
  }) as unknown as PoolConnection["query"];
  const connection = {
    query,
    beginTransaction: async () => { calls.push("BEGIN"); readonly = false; draft = new Map(contacts); },
    commit: async () => { calls.push("COMMIT"); contacts.clear(); for (const [k, v] of draft) contacts.set(k, v); },
    rollback: async () => { calls.push("ROLLBACK"); draft = new Map(contacts); },
    release: () => { closed = true; }, destroy: () => { closed = true; },
  } as unknown as PoolConnection;
  return { contacts, clients, calls, db: { getConnection: async () => { closed = false; return connection; } }, closed: () => closed };
}

test("lote estricto: evidencia requerida, canonical, UTC, límite, duplicados y campos extra", () => {
  assert.equal(validarLoteContactosRecurrencia([grant]).length, 1);
  for (const value of [[], [grant, grant], [{ ...grant, referenciaVerificacion: " " }],
    [{ ...grant, telefonoCanonical: "11 1234 5678" }], [{ ...grant, verificadaAt: "2026-11-01" }],
    [{ ...grant, localId: 2 }], [{ ...optOut, referenciaBaja: "" }], Array(101).fill(grant)]) {
    assert.throws(() => validarLoteContactosRecurrencia(value));
  }
});

test("simulación por defecto: READ ONLY, predice sin escribir y cierra la conexión", async () => {
  const m = modelo();
  const report = await operarContactosRecurrencia({ localId: 1, operaciones: [grant] }, m.db, now);
  assert.equal(report.simulacion, true);
  assert.equal(report.resultados[0].resultado, "autorizar");
  assert.equal(m.contacts.size, 0);
  assert.ok(m.calls.every(sql => !/^(INSERT|UPDATE|DELETE|REPLACE)/.test(sql)));
  assert.ok(m.closed());
  assert.ok(!JSON.stringify(report).includes(phone));
  assert.ok(!JSON.stringify(report).includes("evidence-fixture"));
});

test("autoriza existentes/nuevos solo con coincidencia de cliente, local y teléfono", async () => {
  const m = modelo();
  const result = await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  assert.equal(result.simulacion, false);
  assert.equal(m.contacts.get(`1:${phone}`)?.cliente_id_autorizado, 10);
  assert.ok(m.calls.some(sql => sql.includes("FROM locales") && sql.endsWith("FOR UPDATE")));
  assert.ok(m.calls.some(sql => sql.includes("FROM clientes") && sql.endsWith("FOR SHARE")));
  const again = await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  assert.equal(again.resultados[0].resultado, "sin_cambios");
});

test("baja persiste sin cliente y nunca la sobrescribe una importación", async () => {
  const m = modelo();
  await operarContactosRecurrencia({ localId: 1, operaciones: [optOut], aplicar: true }, m.db, now);
  m.clients.clear();
  const result = await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  assert.equal(result.resultados[0].resultado, "baja_respetada");
  assert.equal(m.contacts.get(`1:${phone}`)?.estado, "baja");
  assert.ok(!m.calls.some(sql => sql.startsWith("DELETE") || sql.startsWith("REPLACE")));
  assert.equal((await operarContactosRecurrencia({ localId: 1, operaciones: [optOut], aplicar: true }, m.db, now))
    .resultados[0].resultado, "sin_cambios");
});

test("baja convierte autorización conservando snapshot histórico; otro local sigue independiente", async () => {
  const m = modelo();
  await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  await operarContactosRecurrencia({ localId: 1, operaciones: [optOut], aplicar: true }, m.db, now);
  assert.deepEqual(m.contacts.get(`1:${phone}`), { estado: "baja", cliente_id_autorizado: 10 });
  await operarContactosRecurrencia({ localId: 2, operaciones: [{ ...grant, clienteId: 20 }], aplicar: true }, m.db, now);
  assert.equal(m.contacts.get(`2:${phone}`)?.estado, "autorizada");
  await assert.rejects(operarContactosRecurrencia({ localId: 2, operaciones: [grant], aplicar: true }, m.db, now));
});

test("cambio de teléfono requiere evidencia nueva para el número nuevo, no se copia permiso", async () => {
  const m = modelo();
  await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  m.clients.set("1:10", otherPhone);
  await assert.rejects(operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now));
  assert.equal(m.contacts.has(`1:${otherPhone}`), false);
  await operarContactosRecurrencia({ localId: 1, operaciones: [{ ...grant, telefonoCanonical: otherPhone,
    referenciaVerificacion: "new-evidence" }], aplicar: true }, m.db, now);
  assert.equal(m.contacts.get(`1:${otherPhone}`)?.estado, "autorizada");
});

test("lote atómico: fila inválida posterior revierte también las altas anteriores", async () => {
  const m = modelo();
  await assert.rejects(operarContactosRecurrencia({ localId: 1, aplicar: true,
    operaciones: [grant, { ...grant, clienteId: 999, telefonoCanonical: otherPhone }] }, m.db, now));
  assert.equal(m.contacts.size, 0);
  assert.ok(m.calls.includes("ROLLBACK"));
  assert.ok(!m.calls.includes("COMMIT"));
});

test("evidencia futura, nuevo titular del mismo número y local ajeno se rechazan", async () => {
  const m = modelo();
  await assert.rejects(operarContactosRecurrencia({ localId: 1, operaciones: [{ ...grant,
    verificadaAt: "2027-01-01T00:00:00.000Z" }], aplicar: true }, m.db, now));
  await assert.rejects(operarContactosRecurrencia({ localId: 999, operaciones: [grant], aplicar: true }, m.db, now));
  await operarContactosRecurrencia({ localId: 1, operaciones: [grant], aplicar: true }, m.db, now);
  m.clients.set("1:11", phone);
  await assert.rejects(operarContactosRecurrencia({ localId: 1, operaciones: [{ ...grant, clienteId: 11 }], aplicar: true }, m.db, now));
});

test("migración faltante bloquea preflight: no fallback silencioso ni cero elegibles engañoso", async () => {
  const query = (async () => { throw new Error("missing table"); }) as PoolConnection["query"];
  await assert.rejects(prepararFuenteContactosRecurrencia({ query }, 1));
});

test("CLI local: aplicación explícita, no force ni .env ni tenant implícito", () => {
  assert.equal(argumentosContactosRecurrencia(["--local-id", "1", "--archivo", "cohorte.json"]).aplicar, false);
  assert.equal(argumentosContactosRecurrencia(["--local-id", "1", "--archivo", "cohorte.json", "--aplicar"]).aplicar, true);
  for (const args of [[], ["--local-id", "1", "--archivo", ".env"],
    ["--local-id", "1", "--archivo", ".env.local"], ["--local-id", "0", "--archivo", "cohorte.json"],
    ["--local-id", "1", "--archivo", "cohorte.json", "--force"]]) {
    assert.throws(() => argumentosContactosRecurrencia(args));
  }
});
