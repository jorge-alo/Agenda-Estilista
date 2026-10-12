import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { Request, Response as ExpressResponse } from "express";
import "./pagos.test.setup";
import { pool } from "../../config/db";
import { pagosService } from "./pagos.service";
import { ErrorCreacionPreference, SenaYaAprobadaError } from "./pagos.service";
import type { PagoMPConsultado } from "./pagos.service";
import { createTurnoPublico } from "../public/public.service";

const notificationPath = require.resolve("../notifications/application/sendWhatsAppNotification");
const originalNotification = require.cache[notificationPath];
const notificationStub = new Module(notificationPath);
notificationStub.filename = notificationPath;
notificationStub.loaded = true;
notificationStub.exports = { sendTurnoConfirmado: async () => { throw new Error("No enviar WhatsApp en estas pruebas"); } };
require.cache[notificationPath] = notificationStub;
const { crearLinkPago } = require("./pagos.controller") as typeof import("./pagos.controller");

const LOCAL_TOKEN = "TOKEN_LOCAL_FICTICIO_H5";
const OTHER_TOKEN = "TOKEN_OTRO_LOCAL_FICTICIO_H5";
const localIds: number[] = [];
const estilistaIds: number[] = [];
const creationLogs: unknown[][] = [];
let turnoId: number;

async function limpiarIntentosYTurnos() {
  if (localIds.length === 0) return;
  const placeholders = localIds.map(() => "?").join(", ");
  await pool.query(`UPDATE turnos SET pago_id = NULL WHERE local_id IN (${placeholders})`, localIds);
  await pool.query(`DELETE FROM pagos WHERE local_id IN (${placeholders})`, localIds);
  await pool.query(`DELETE FROM turnos WHERE local_id IN (${placeholders})`, localIds);
  await pool.query(`DELETE FROM servicios WHERE local_id IN (${placeholders})`, localIds);
  await pool.query(`DELETE FROM clientes WHERE local_id IN (${placeholders})`, localIds);
}

before(async () => {
  for (const token of [LOCAL_TOKEN, OTHER_TOKEN]) {
    const [local] = await pool.query<ResultSetHeader>(
      "INSERT INTO locales (nombre, slug, mp_access_token) VALUES (?, ?, ?)",
      ["__TEST_PAGOS_H5__", `test-h5-${randomUUID()}`, token]
    );
    localIds.push(local.insertId);
    const [estilista] = await pool.query<ResultSetHeader>(
      "INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)",
      ["__TEST_PAGOS_H5__", local.insertId]
    );
    estilistaIds.push(estilista.insertId);
  }
});

beforeEach(async (t) => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", {
    BACKEND_URL: "https://backend.test/",
    FRONTEND_URL: "https://frontend.test/",
    MP_ACCESS_TOKEN: "TOKEN_GLOBAL_FICTICIO_H5",
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw { status: 400, message: "HTTP externo no permitido en esta prueba" };
  });
  creationLogs.length = 0;
  t.mock.method(console, "error", (...args: unknown[]) => { creationLogs.push(args); });
  await limpiarIntentosYTurnos();
  for (const [index, token] of [LOCAL_TOKEN, OTHER_TOKEN].entries()) {
    await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [token, localIds[index]]);
  }
  const [turno] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos
       (fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono, estado)
     VALUES ('2099-01-01', '10:00:00', '10:30:00', ?, ?, ?, ?, 'pendiente_pago')`,
    [estilistaIds[0], localIds[0], "Cliente de prueba H5", "0000000000"]
  );
  turnoId = turno.insertId;
});

after(async () => {
  try {
    await limpiarIntentosYTurnos();
    for (const localId of localIds) {
      await pool.query("DELETE FROM estilistas WHERE local_id = ?", [localId]);
      await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
    }
  } finally {
    await pool.end();
    if (originalNotification) require.cache[notificationPath] = originalNotification;
    else delete require.cache[notificationPath];
  }
});

const registrar = (monto = 30, tipo: "seña" | "completo" = "seña") =>
  pagosService.registrarIntentoPago({ turnoId, localId: localIds[0], monto, tipo });

async function leerTurno() {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT pago_id, estado FROM turnos WHERE id = ? AND local_id = ?",
    [turnoId, localIds[0]]
  );
  return rows[0];
}

async function contarIntentos(turno = turnoId) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM pagos WHERE turno_id = ? AND local_id = ?",
    [turno, localIds[0]]
  );
  return Number(rows[0].total);
}

test("registrar: persiste el intento sin preferencia y lo vincula al turno", async () => {
  const result = await registrar();
  const contexto = await pagosService.obtenerContextoPago(result.pagoId);

  assert.ok(contexto);
  assert.equal(contexto.turno_id, turnoId);
  assert.equal(contexto.local_id, localIds[0]);
  assert.equal(contexto.preference_id, null);
  assert.equal(contexto.estado, "pendiente");
  assert.equal(contexto.tipo, "seña");
  assert.equal(contexto.monto, "30.00");
  assert.equal(contexto.mp_payment_id, null);
  assert.equal(contexto.turno_pago_id, result.pagoId);
  assert.equal(contexto.turno_estado, "pendiente_pago");
});

test("registrar: devuelve el monto normalizado que realmente se persiste", async () => {
  const result = await registrar(10.126, "completo");
  const contexto = await pagosService.obtenerContextoPago(result.pagoId);

  assert.equal(result.monto, 10.13);
  assert.equal(contexto?.monto, "10.13");
  assert.equal(contexto?.tipo, "completo");
});

test("registrar: rechaza turno de otro local sin insertar ni cambiar la vinculación", async () => {
  const original = await registrar();
  await assert.rejects(
    pagosService.registrarIntentoPago({ turnoId, localId: localIds[1], monto: 30, tipo: "seña" }),
    /Turno no encontrado/
  );
  assert.equal(await contarIntentos(), 1);
  assert.equal((await leerTurno()).pago_id, original.pagoId);
});

test("registrar: rechaza un turno inexistente sin dejar intentos", async () => {
  await assert.rejects(
    pagosService.registrarIntentoPago({ turnoId: 2147483647, localId: localIds[0], monto: 30, tipo: "seña" }),
    /Turno no encontrado/
  );
  assert.equal(await contarIntentos(), 0);
  assert.equal((await leerTurno()).pago_id, null);
});

test("registrar: valida IDs, tipo y monto antes de persistir", async () => {
  const base = { turnoId, localId: localIds[0], monto: 30, tipo: "seña" as const };
  for (const data of [
    { ...base, turnoId: 0 },
    { ...base, localId: -1 },
    { ...base, turnoId: 1.5 },
    { ...base, monto: 0 },
    { ...base, monto: -10 },
    { ...base, monto: Number.NaN },
    { ...base, monto: Number.POSITIVE_INFINITY },
    { ...base, monto: 0.001 },
    { ...base, tipo: "otro" as "seña" },
  ]) {
    await assert.rejects(pagosService.registrarIntentoPago(data), /inválido/);
  }
  assert.equal(await contarIntentos(), 0);
});

test("registrar: error real de INSERT conserva la vinculación previa", async () => {
  const original = await registrar();
  await assert.rejects(registrar(100000000), (error: unknown) => {
    assert.ok(typeof error === "object" && error !== null && "code" in error);
    assert.equal(error.code, "ER_WARN_DATA_OUT_OF_RANGE");
    return true;
  });
  assert.equal(await contarIntentos(), 1);
  assert.equal((await leerTurno()).pago_id, original.pagoId);
});

test("registrar: si falla la vinculación hace rollback del INSERT y libera la conexión", async (t) => {
  const original = await registrar();
  const connection = await pool.getConnection();
  const originalQuery = connection.query.bind(connection);
  const failure = new Error("Fallo simulado al vincular turno");
  const release = t.mock.method(connection, "release");
  t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
    if (sql.startsWith("UPDATE turnos SET pago_id")) throw failure;
    return originalQuery(sql, values);
  }) as typeof connection.query);
  t.mock.method(pool, "getConnection", async () => connection);

  await assert.rejects(registrar(), (error: unknown) => error === failure);

  assert.equal(release.mock.callCount(), 1);
  assert.equal(await contarIntentos(), 1);
  assert.equal((await leerTurno()).pago_id, original.pagoId);
});

test("registrar: affectedRows inesperado también revierte el intento", async (t) => {
  const connection = await pool.getConnection();
  const originalQuery = connection.query.bind(connection);
  t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
    if (sql.startsWith("UPDATE turnos SET pago_id")) return [{ affectedRows: 0 }, []];
    return originalQuery(sql, values);
  }) as typeof connection.query);
  t.mock.method(pool, "getConnection", async () => connection);

  await assert.rejects(registrar(), /No se pudo vincular/);

  assert.equal(await contarIntentos(), 0);
  assert.equal((await leerTurno()).pago_id, null);
});

test("registrar: dos intentos concurrentes conservan ambas filas con preference_id NULL", async () => {
  const results = await Promise.all([registrar(), registrar()]);
  assert.notEqual(results[0].pagoId, results[1].pagoId);
  assert.equal(await contarIntentos(), 2);
  const turno = await leerTurno();
  assert.ok(results.some((result) => result.pagoId === turno.pago_id));
  for (const result of results) {
    assert.equal((await pagosService.obtenerContextoPago(result.pagoId))?.preference_id, null);
  }
});

test("vincular: guarda la preferencia sin modificar el estado del intento o turno", async () => {
  const { pagoId } = await registrar();
  await pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-prueba");
  const contexto = await pagosService.obtenerContextoPago(pagoId);

  assert.equal(contexto?.preference_id, "pref-h5-prueba");
  assert.equal(contexto?.estado, "pendiente");
  assert.equal(contexto?.turno_estado, "pendiente_pago");
});

test("vincular: repetir la misma preferencia es idempotente", async () => {
  const { pagoId } = await registrar();
  await Promise.all([
    pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-prueba"),
    pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-prueba"),
  ]);
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.preference_id, "pref-h5-prueba");
});

test("vincular: preferencias distintas concurrentes no se sobrescriben", async () => {
  const { pagoId } = await registrar();
  const results = await Promise.allSettled([
    pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-a"),
    pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-b"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(["pref-h5-a", "pref-h5-b"].includes(
    (await pagosService.obtenerContextoPago(pagoId))?.preference_id ?? ""
  ));
});

test("vincular: el índice real rechaza una preferencia usada en otro intento", async () => {
  const first = await registrar();
  const second = await registrar();
  await pagosService.vincularPreference(first.pagoId, localIds[0], "pref-h5-unica");
  await assert.rejects(
    pagosService.vincularPreference(second.pagoId, localIds[0], "pref-h5-unica"),
    (error: unknown) => {
      assert.ok(typeof error === "object" && error !== null && "code" in error);
      assert.equal(error.code, "ER_DUP_ENTRY");
      return true;
    }
  );
  assert.equal((await pagosService.obtenerContextoPago(second.pagoId))?.preference_id, null);
});

test("vincular: rechaza una preferencia diferente de la ya vinculada", async () => {
  const { pagoId } = await registrar();
  await pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-original");
  await assert.rejects(
    pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-otra"),
    /preferencia diferente/
  );
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.preference_id, "pref-h5-original");
});

test("vincular: no encuentra intentos inexistentes o pertenecientes a otro local", async () => {
  const { pagoId } = await registrar();
  await assert.rejects(
    pagosService.vincularPreference(pagoId, localIds[1], "pref-h5-prueba"),
    /no encontrado/
  );
  await assert.rejects(
    pagosService.vincularPreference(2147483647, localIds[0], "pref-h5-prueba"),
    /no encontrado/
  );
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.preference_id, null);
});

test("vincular: no reinicia un pago que ya fue aprobado antes de guardar la preferencia", async () => {
  const { pagoId } = await registrar();
  await pool.query(
    "UPDATE pagos SET estado = 'aprobado', mp_status = 'approved' WHERE id = ? AND local_id = ?",
    [pagoId, localIds[0]]
  );
  await pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-prueba");
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.estado, "aprobado");
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.mp_status, "approved");
});

test("vincular: valida IDs y longitud de preference_id", async () => {
  const { pagoId } = await registrar();
  for (const pref of ["", "   ", "p".repeat(256)]) {
    await assert.rejects(pagosService.vincularPreference(pagoId, localIds[0], pref), /inválido/);
  }
  await assert.rejects(pagosService.vincularPreference(0, localIds[0], "pref-h5"), /inválido/);
  await assert.rejects(pagosService.vincularPreference(pagoId, -1, "pref-h5"), /inválido/);
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.preference_id, null);
});

test("contexto: resuelve el local del intento y lee su token vigente", async () => {
  const { pagoId } = await registrar();
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.mp_access_token, LOCAL_TOKEN);
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", ["TOKEN_RENOVADO_FICTICIO_H5", localIds[0]]);
  assert.equal((await pagosService.obtenerContextoPago(pagoId))?.mp_access_token, "TOKEN_RENOVADO_FICTICIO_H5");
});

test("contexto: no pierde un intento anterior al vincular uno nuevo al mismo turno", async () => {
  const original = await registrar();
  const nuevo = await registrar();
  const contexto = await pagosService.obtenerContextoPago(original.pagoId);
  assert.equal(contexto?.id, original.pagoId);
  assert.equal(contexto?.turno_pago_id, nuevo.pagoId);
});

test("contexto: devuelve null ante una relación inconsistente entre pago y turno", async () => {
  const { pagoId } = await registrar();
  await pool.query("UPDATE pagos SET local_id = ? WHERE id = ? AND local_id = ?", [localIds[1], pagoId, localIds[0]]);
  assert.equal(await pagosService.obtenerContextoPago(pagoId), null);
});

test("contexto: conserva token local NULL sin sustituirlo por el global", async () => {
  process.env.MP_ACCESS_TOKEN = "TOKEN_GLOBAL_FICTICIO_H5";
  const { pagoId } = await registrar();
  await pool.query("UPDATE locales SET mp_access_token = NULL WHERE id = ?", [localIds[0]]);
  const contexto = await pagosService.obtenerContextoPago(pagoId);
  assert.ok(contexto);
  assert.equal(contexto.mp_access_token, null);
});

test("contexto: valida pago_id y devuelve null si el intento no existe", async () => {
  await assert.rejects(pagosService.obtenerContextoPago(0), /inválido/);
  assert.equal(await pagosService.obtenerContextoPago(2147483647), null);
});

let contadorMp = 8000000000000;
const nuevoIdMp = () => String(++contadorMp);

function pagoMP(pagoId: number, id = nuevoIdMp(), cambios: Partial<PagoMPConsultado> = {}): PagoMPConsultado {
  return {
    id,
    external_reference: `turno-${turnoId}-pago-${pagoId}`,
    transaction_amount: 30,
    currency_id: "ARS",
    status: "approved",
    status_detail: "accredited",
    metadata: { turno_id: turnoId, local_id: localIds[0], pago_id: pagoId, tipo: "seña" },
    ...cambios,
  };
}

function procesar(pagoId: number, payment: PagoMPConsultado, paymentId = String(payment.id)) {
  return pagosService.procesarPagoTurno({ pagoId, paymentId, payment });
}

async function leerPago(pagoId: number, localId = localIds[0]) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, turno_id, local_id, preference_id, monto, tipo, estado,
            mp_payment_id, mp_status, mp_status_detail, fecha_actualizacion
     FROM pagos WHERE id = ? AND local_id = ?`,
    [pagoId, localId]
  );
  return rows[0];
}

async function contexto(pagoId: number) {
  const value = await pagosService.obtenerContextoPago(pagoId);
  assert.ok(value);
  return value;
}

test("validar: acepta referencia única, monto en centavos y metadata numérica o textual", async () => {
  const { pagoId } = await registrar();
  const intento = await contexto(pagoId);
  const payment = pagoMP(pagoId);
  for (const amount of [30, "30", "30.0", "30.00"]) {
    const response = {
      ...payment,
      transaction_amount: amount,
      metadata: { turno_id: String(turnoId), local_id: String(localIds[0]), pago_id: String(pagoId), tipo: "seña" },
    };
    assert.equal(pagosService.validarPagoDelIntento(intento, response, String(payment.id)).valido, true);
  }
  assert.equal((await leerPago(pagoId)).estado, "pendiente");
});

test("validar: no depende de preference_id o metadata presentes en la respuesta", async () => {
  const { pagoId } = await registrar();
  await pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-validacion");
  const payment = pagoMP(pagoId, nuevoIdMp(), { metadata: undefined });
  assert.equal(pagosService.validarPagoDelIntento(await contexto(pagoId), payment, String(payment.id)).valido, true);
});

test("validar: rechaza IDs, referencias, importes, moneda, metadata y preferencia incompatibles", async () => {
  const { pagoId } = await registrar();
  await pagosService.vincularPreference(pagoId, localIds[0], "pref-h5-validacion");
  const intento = await contexto(pagoId);
  const payment = pagoMP(pagoId);
  const invalidos: Array<{ cambio: Partial<PagoMPConsultado>; motivo: string }> = [
    { cambio: { id: undefined }, motivo: "payment_id_invalido" },
    { cambio: { id: "0" }, motivo: "payment_id_invalido" },
    { cambio: { id: -1 }, motivo: "payment_id_invalido" },
    { cambio: { id: Number.MAX_SAFE_INTEGER + 1 }, motivo: "payment_id_invalido" },
    { cambio: { id: nuevoIdMp() }, motivo: "payment_id_no_coincide" },
    { cambio: { external_reference: `turno-${turnoId}` }, motivo: "referencia_no_coincide" },
    { cambio: { external_reference: `turno-${turnoId}-pago-${pagoId + 1}` }, motivo: "referencia_no_coincide" },
    { cambio: { external_reference: "suscripcion-1-otra" }, motivo: "referencia_no_coincide" },
    { cambio: { transaction_amount: 29.99 }, motivo: "monto_no_coincide" },
    { cambio: { transaction_amount: 0 }, motivo: "monto_invalido" },
    { cambio: { transaction_amount: -30 }, motivo: "monto_invalido" },
    { cambio: { transaction_amount: Number.NaN }, motivo: "monto_invalido" },
    { cambio: { transaction_amount: "30.001" }, motivo: "monto_invalido" },
    { cambio: { transaction_amount: " 30.00 " }, motivo: "monto_invalido" },
    { cambio: { currency_id: "USD" }, motivo: "moneda_no_coincide" },
    { cambio: { currency_id: undefined }, motivo: "moneda_no_coincide" },
    { cambio: { metadata: { turno_id: turnoId + 1 } }, motivo: "metadata_no_coincide" },
    { cambio: { metadata: { local_id: localIds[1] } }, motivo: "metadata_no_coincide" },
    { cambio: { metadata: { pago_id: pagoId + 1 } }, motivo: "metadata_no_coincide" },
    { cambio: { metadata: { tipo: "completo" } }, motivo: "metadata_no_coincide" },
    { cambio: { preference_id: "pref-h5-otra" }, motivo: "preference_id_no_coincide" },
    { cambio: { status: "" }, motivo: "status_invalido" },
    { cambio: { status_detail: "x".repeat(101) }, motivo: "status_detail_invalido" },
  ];
  for (const { cambio, motivo } of invalidos) {
    const result = pagosService.validarPagoDelIntento(intento, { ...payment, ...cambio }, String(payment.id));
    assert.equal(result.valido, false);
    if (!result.valido) assert.equal(result.motivo, motivo);
  }
});

test("procesar: invalida referencia, monto, moneda e ID antes de abrir la transacción", async (t) => {
  const { pagoId } = await registrar();
  const original = await leerPago(pagoId);
  const turno = await leerTurno();
  const getConnection = t.mock.method(pool, "getConnection");
  const payment = pagoMP(pagoId);
  for (const cambio of [
    { external_reference: "otra" }, { transaction_amount: 29.99 }, { currency_id: "USD" }, { id: nuevoIdMp() },
  ]) {
    const result = await procesar(pagoId, { ...payment, ...cambio }, String(payment.id));
    assert.equal(result.resultado, "pago_invalido");
  }
  assert.equal(getConnection.mock.callCount(), 0);
  assert.deepEqual(await leerPago(pagoId), original);
  assert.deepEqual(await leerTurno(), turno);
});

test("procesar: aprobado vigente confirma y persiste todos los datos MP sin exigir preference_id", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId);
  const result = await procesar(pagoId, payment);
  const persistido = await leerPago(pagoId);

  assert.equal(result.resultado, "confirmado");
  assert.equal(result.notificarWhatsApp, true);
  assert.equal(result.requiereConciliacion, false);
  assert.equal(result.mpPaymentIdPersistido, String(payment.id));
  assert.equal(persistido.estado, "aprobado");
  assert.equal(persistido.mp_payment_id, String(payment.id));
  assert.equal(persistido.mp_status, "approved");
  assert.equal(persistido.mp_status_detail, "accredited");
  assert.equal(persistido.preference_id, null);
  assert.equal((await leerTurno()).estado, "activo");
});

test("procesar: mismo ID repetido no reescribe datos ni vuelve a confirmar", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId);
  await procesar(pagoId, payment);
  const original = await leerPago(pagoId);
  const turno = await leerTurno();
  const result = await procesar(pagoId, { ...payment, status_detail: "detalle_distinto" });

  assert.equal(result.resultado, "ya_procesado");
  assert.equal(result.notificarWhatsApp, false);
  assert.deepEqual(await leerPago(pagoId), original);
  assert.deepEqual(await leerTurno(), turno);
});

test("procesar: duplicado de un pago previo no reabre ni vuelve a conciliar un turno luego completado", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId);
  await procesar(pagoId, payment);
  await pool.query("UPDATE turnos SET estado = 'completado' WHERE id = ? AND local_id = ?", [turnoId, localIds[0]]);
  const result = await procesar(pagoId, payment);
  assert.equal(result.resultado, "ya_procesado");
  assert.equal(result.notificarWhatsApp, false);
  assert.equal(result.requiereConciliacion, false);
  assert.equal((await leerTurno()).estado, "completado");
});

test("procesar: dos eventos concurrentes del mismo ID producen una sola confirmación", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId);
  const results = await Promise.all([procesar(pagoId, payment), procesar(pagoId, payment)]);
  assert.equal(results.filter((result) => result.resultado === "confirmado").length, 1);
  assert.equal(results.filter((result) => result.resultado === "ya_procesado").length, 1);
  assert.equal(results.filter((result) => result.notificarWhatsApp).length, 1);
  assert.equal((await leerPago(pagoId)).mp_payment_id, String(payment.id));
});

test("procesar: un ID distinto no sobrescribe el aprobado ni modifica el turno", async () => {
  const { pagoId } = await registrar();
  const primero = pagoMP(pagoId);
  await procesar(pagoId, primero);
  const original = await leerPago(pagoId);
  const turno = await leerTurno();
  const segundo = pagoMP(pagoId);
  const result = await procesar(pagoId, segundo);

  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.motivo, "payment_id_diferente");
  assert.equal(result.mpPaymentIdPersistido, String(primero.id));
  assert.equal(result.mpPaymentId, String(segundo.id));
  assert.equal(result.requiereConciliacion, true);
  assert.deepEqual(await leerPago(pagoId), original);
  assert.deepEqual(await leerTurno(), turno);
  assert.equal(await contarIntentos(), 1);
});

test("procesar: dos IDs distintos concurrentes no se sobrescriben", async () => {
  const { pagoId } = await registrar();
  const results = await Promise.all([procesar(pagoId, pagoMP(pagoId)), procesar(pagoId, pagoMP(pagoId))]);
  const confirmado = results.find((result) => result.resultado === "confirmado");
  assert.ok(confirmado);
  assert.equal(results.filter((result) => result.resultado === "conflicto_de_pago").length, 1);
  assert.equal((await leerPago(pagoId)).mp_payment_id, confirmado.mpPaymentId);
});

test("procesar: tampoco sobrescribe un ID distinto guardado en un intento pendiente", async () => {
  const { pagoId } = await registrar();
  const idOriginal = nuevoIdMp();
  await pool.query("UPDATE pagos SET mp_payment_id = ? WHERE id = ? AND local_id = ?", [idOriginal, pagoId, localIds[0]]);
  const original = await leerPago(pagoId);
  const result = await procesar(pagoId, pagoMP(pagoId));
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.motivo, "payment_id_diferente");
  assert.deepEqual(await leerPago(pagoId), original);
  assert.equal((await leerTurno()).estado, "pendiente_pago");
});

for (const [status, estado, resultado] of [
  ["rejected", "rechazado", "pago_rechazado"], ["cancelled", "cancelado", "pago_cancelado"],
] as const) {
  test(`procesar: ${status} cancela únicamente la reserva pendiente del intento vigente`, async () => {
    const { pagoId } = await registrar();
    const payment = pagoMP(pagoId, nuevoIdMp(), { status, status_detail: "detalle_rechazo" });
    const result = await procesar(pagoId, payment);
    assert.equal(result.resultado, resultado);
    assert.equal(result.turnoCancelado, true);
    assert.equal(result.notificarWhatsApp, false);
    assert.equal((await leerPago(pagoId)).estado, estado);
    assert.equal((await leerTurno()).estado, "cancelado");
    assert.equal((await procesar(pagoId, payment)).resultado, "ya_procesado");
  });

  test(`procesar: ${status} antiguo no afecta la reserva pendiente de un intento posterior`, async () => {
    const viejo = await registrar();
    const vigente = await registrar();
    const result = await procesar(viejo.pagoId, pagoMP(viejo.pagoId, nuevoIdMp(), { status }));
    assert.equal(result.resultado, resultado);
    assert.equal(result.turnoCancelado, false);
    assert.equal((await leerPago(viejo.pagoId)).estado, estado);
    assert.equal((await leerTurno()).estado, "pendiente_pago");
    assert.equal((await leerTurno()).pago_id, vigente.pagoId);
    assert.equal((await leerPago(vigente.pagoId)).estado, "pendiente");
  });

  test(`procesar: ${status} antiguo no cancela el turno activo por un intento posterior`, async () => {
    const viejo = await registrar();
    const vigente = await registrar();
    await procesar(vigente.pagoId, pagoMP(vigente.pagoId));
    const original = await leerPago(vigente.pagoId);
    const result = await procesar(viejo.pagoId, pagoMP(viejo.pagoId, nuevoIdMp(), { status }));
    assert.equal(result.turnoCancelado, false);
    assert.equal((await leerTurno()).estado, "activo");
    assert.equal((await leerTurno()).pago_id, vigente.pagoId);
    assert.deepEqual(await leerPago(vigente.pagoId), original);
  });
}

for (const estado of ["cancelado", "completado"] as const) {
  test(`procesar: aprobado tardío en turno ${estado} se reconoce sin reactivarlo`, async () => {
    const { pagoId } = await registrar();
    await pool.query("UPDATE turnos SET estado = ? WHERE id = ? AND local_id = ?", [estado, turnoId, localIds[0]]);
    const payment = pagoMP(pagoId);
    const result = await procesar(pagoId, payment);
    const persistido = await contexto(pagoId);

    assert.equal(result.resultado, "registrado_sin_confirmar");
    assert.equal(result.motivo, estado === "cancelado" ? "turno_cancelado" : "turno_completado");
    assert.equal(result.requiereConciliacion, true);
    assert.equal(result.notificarWhatsApp, false);
    assert.equal(persistido.estado, "aprobado");
    assert.equal(persistido.mp_payment_id, String(payment.id));
    assert.equal(persistido.mp_status, "approved");
    assert.equal(persistido.turno_estado, estado);
    assert.equal((await procesar(pagoId, payment)).resultado, "ya_procesado");
  });
}

test("procesar: aprobado de intento desplazado se reconoce sin confirmar la reserva del vigente", async () => {
  const viejo = await registrar();
  const vigente = await registrar();
  const result = await procesar(viejo.pagoId, pagoMP(viejo.pagoId));
  const persistido = await contexto(viejo.pagoId);
  assert.equal(result.resultado, "registrado_sin_confirmar");
  assert.equal(result.motivo, "intento_no_vigente");
  assert.equal(result.requiereConciliacion, true);
  assert.equal(persistido.estado, "aprobado");
  assert.equal(persistido.turno_estado, "pendiente_pago");
  assert.equal(persistido.turno_pago_id, vigente.pagoId);
});

test("procesar: turno ya activo con el mismo intento no vuelve a confirmarse", async () => {
  const { pagoId } = await registrar();
  await pool.query("UPDATE turnos SET estado = 'activo' WHERE id = ? AND local_id = ?", [turnoId, localIds[0]]);
  const result = await procesar(pagoId, pagoMP(pagoId));
  assert.equal(result.resultado, "registrado_sin_confirmar");
  assert.equal(result.motivo, "turno_ya_activo");
  assert.equal(result.requiereConciliacion, false);
  assert.equal(result.notificarWhatsApp, false);
  assert.equal((await leerPago(pagoId)).estado, "aprobado");
});

test("procesar: dos aprobados de intentos diferentes conservan ambos pagos y confirman solo el vigente", async () => {
  const viejo = await registrar();
  const vigente = await registrar();
  const results = await Promise.all([
    procesar(viejo.pagoId, pagoMP(viejo.pagoId)), procesar(vigente.pagoId, pagoMP(vigente.pagoId)),
  ]);
  assert.equal(results.filter((result) => result.resultado === "confirmado").length, 1);
  assert.equal(results.filter((result) => result.requiereConciliacion).length, 1);
  assert.equal((await leerPago(viejo.pagoId)).estado, "aprobado");
  assert.equal((await leerPago(vigente.pagoId)).estado, "aprobado");
  assert.equal((await leerTurno()).pago_id, vigente.pagoId);
});

test("procesar: preserva un estado terminal ante un estado final diferente del mismo ID", async () => {
  const { pagoId } = await registrar();
  const rechazado = pagoMP(pagoId, nuevoIdMp(), { status: "rejected" });
  await procesar(pagoId, rechazado);
  const original = await leerPago(pagoId);
  const result = await procesar(pagoId, { ...rechazado, status: "approved" });
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.motivo, "estado_previamente_procesado");
  assert.deepEqual(await leerPago(pagoId), original);
  assert.equal((await leerTurno()).estado, "cancelado");
});

test("procesar: no degrada un aprobado ni cancela su turno ante rechazo posterior del mismo ID", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId);
  await procesar(pagoId, payment);
  const original = await leerPago(pagoId);
  const result = await procesar(pagoId, { ...payment, status: "rejected" });
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.deepEqual(await leerPago(pagoId), original);
  assert.equal((await leerTurno()).estado, "activo");
});

test("procesar: estado no final no altera datos y admite procesar el aprobado posterior", async () => {
  const { pagoId } = await registrar();
  const payment = pagoMP(pagoId, nuevoIdMp(), { status: "pending", status_detail: null });
  const original = await leerPago(pagoId);
  assert.equal((await procesar(pagoId, payment)).resultado, "estado_no_final");
  assert.deepEqual(await leerPago(pagoId), original);
  assert.equal((await procesar(pagoId, { ...payment, status: "approved" })).resultado, "confirmado");
});

test("procesar: un Payment ID de otro intento del local produce conflicto sin cambios", async () => {
  const first = await registrar();
  const payment = pagoMP(first.pagoId);
  await procesar(first.pagoId, payment);
  // Un intento completo sigue siendo permitido después de una seña aprobada.
  const second = await registrar(30, "completo");
  const original = await leerPago(second.pagoId);
  const result = await procesar(second.pagoId, pagoMP(second.pagoId, String(payment.id), {
    metadata: { turno_id: turnoId, local_id: localIds[0], pago_id: second.pagoId, tipo: "completo" },
  }));
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.motivo, "payment_id_de_otro_intento");
  assert.deepEqual(await leerPago(second.pagoId), original);
});

async function registrarEnOtroLocal() {
  const [turno] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos
       (fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono, estado)
     VALUES ('2099-01-01', '11:00:00', '11:30:00', ?, ?, ?, ?, 'pendiente_pago')`,
    [estilistaIds[1], localIds[1], "Cliente de prueba H5", "0000000000"]
  );
  const intento = await pagosService.registrarIntentoPago({
    turnoId: turno.insertId, localId: localIds[1], monto: 30, tipo: "seña",
  });
  const payment = (id: string) => pagoMP(intento.pagoId, id, {
    external_reference: `turno-${turno.insertId}-pago-${intento.pagoId}`,
    metadata: { turno_id: turno.insertId, local_id: localIds[1], pago_id: intento.pagoId, tipo: "seña" },
  });
  return { intento, payment };
}

test("procesar: el índice global protege un Payment ID ya registrado en otro local", async () => {
  const own = await registrar();
  const other = await registrarEnOtroLocal();
  const id = nuevoIdMp();
  await procesar(other.intento.pagoId, other.payment(id));
  const original = await leerPago(own.pagoId);
  const result = await procesar(own.pagoId, pagoMP(own.pagoId, id));
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.motivo, "payment_id_de_otro_intento");
  assert.deepEqual(await leerPago(own.pagoId), original);
  assert.equal((await leerTurno()).estado, "pendiente_pago");
});

test("procesar: mismo ID concurrente entre locales solo puede registrarse una vez", async () => {
  const own = await registrar();
  const other = await registrarEnOtroLocal();
  const id = nuevoIdMp();
  const results = await Promise.all([
    procesar(own.pagoId, pagoMP(own.pagoId, id)), procesar(other.intento.pagoId, other.payment(id)),
  ]);
  assert.equal(results.filter((result) => result.resultado === "confirmado").length, 1);
  assert.equal(results.filter((result) => result.resultado === "conflicto_de_pago").length, 1);
  const records = [await leerPago(own.pagoId), await leerPago(other.intento.pagoId, localIds[1])];
  assert.equal(records.filter((record) => record.mp_payment_id === id).length, 1);
  assert.equal(records.filter((record) => record.estado === "pendiente").length, 1);
});

test("procesar: intento inexistente o relación inconsistente no se procesa", async () => {
  assert.equal((await procesar(2147483647, pagoMP(2147483647))).resultado, "intento_no_encontrado");
  const { pagoId } = await registrar();
  await pool.query("UPDATE pagos SET local_id = ? WHERE id = ? AND local_id = ?", [localIds[1], pagoId, localIds[0]]);
  assert.equal((await procesar(pagoId, pagoMP(pagoId))).resultado, "intento_no_encontrado");
  assert.equal((await leerPago(pagoId, localIds[1])).estado, "pendiente");
});

test("procesar: revalida el monto leído nuevamente bajo bloqueo", async (t) => {
  const { pagoId } = await registrar();
  const getConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    await pool.query("UPDATE pagos SET monto = 31 WHERE id = ? AND local_id = ?", [pagoId, localIds[0]]);
    return getConnection();
  });
  const result = await procesar(pagoId, pagoMP(pagoId));
  assert.equal(result.resultado, "pago_invalido");
  assert.equal(result.motivo, "monto_no_coincide");
  assert.equal((await leerPago(pagoId)).mp_payment_id, null);
  assert.equal((await leerPago(pagoId)).estado, "pendiente");
});

test("procesar: decide sobre el estado actual bloqueado, no el contexto previo", async (t) => {
  const { pagoId } = await registrar();
  const getConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [turnoId, localIds[0]]);
    return getConnection();
  });
  const result = await procesar(pagoId, pagoMP(pagoId));
  assert.equal(result.resultado, "registrado_sin_confirmar");
  assert.equal(result.motivo, "turno_cancelado");
  assert.equal((await leerTurno()).estado, "cancelado");
  assert.equal((await leerPago(pagoId)).estado, "aprobado");
});

test("procesar: comprueba el Payment ID asociado dentro de la transacción", async (t) => {
  const { pagoId } = await registrar();
  const idGuardado = nuevoIdMp();
  const getConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    await pool.query("UPDATE pagos SET mp_payment_id = ? WHERE id = ? AND local_id = ?", [idGuardado, pagoId, localIds[0]]);
    return getConnection();
  });
  const result = await procesar(pagoId, pagoMP(pagoId));
  assert.equal(result.resultado, "conflicto_de_pago");
  assert.equal(result.mpPaymentIdPersistido, idGuardado);
  assert.equal((await leerPago(pagoId)).mp_payment_id, idGuardado);
  assert.equal((await leerPago(pagoId)).estado, "pendiente");
});

test("procesar: mantiene el orden de locks turno → pago", async (t) => {
  const { pagoId } = await registrar();
  const connection = await pool.getConnection();
  const originalQuery = connection.query.bind(connection);
  const locks: string[] = [];
  t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
    if (sql.includes("FOR UPDATE")) locks.push(sql.includes("FROM turnos") ? "turno" : "pago");
    return originalQuery(sql, values);
  }) as typeof connection.query);
  t.mock.method(pool, "getConnection", async () => connection);
  await procesar(pagoId, pagoMP(pagoId));
  assert.deepEqual(locks, ["turno", "pago"]);
});

for (const fallo of ["UPDATE pagos SET estado", "UPDATE turnos SET estado"] as const) {
  test(`procesar: fallo SQL en ${fallo} revierte pago y turno y libera la conexión`, async (t) => {
    const { pagoId } = await registrar();
    const original = await leerPago(pagoId);
    const turno = await leerTurno();
    const connection = await pool.getConnection();
    const originalQuery = connection.query.bind(connection);
    const error = new Error("Fallo SQL simulado H5");
    const release = t.mock.method(connection, "release");
    t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
      if (sql.startsWith(fallo)) throw error;
      return originalQuery(sql, values);
    }) as typeof connection.query);
    t.mock.method(pool, "getConnection", async () => connection);

    await assert.rejects(procesar(pagoId, pagoMP(pagoId)), (received: unknown) => received === error);
    assert.equal(release.mock.callCount(), 1);
    assert.deepEqual(await leerPago(pagoId), original);
    assert.deepEqual(await leerTurno(), turno);
  });

  test(`procesar: affectedRows inesperado en ${fallo} revierte todo`, async (t) => {
    const { pagoId } = await registrar();
    const original = await leerPago(pagoId);
    const turno = await leerTurno();
    const connection = await pool.getConnection();
    const originalQuery = connection.query.bind(connection);
    t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
      if (sql.startsWith(fallo)) return [{ affectedRows: 0 }, []];
      return originalQuery(sql, values);
    }) as typeof connection.query);
    t.mock.method(pool, "getConnection", async () => connection);

    await assert.rejects(procesar(pagoId, pagoMP(pagoId)), /No se pudo/);
    assert.deepEqual(await leerPago(pagoId), original);
    assert.deepEqual(await leerTurno(), turno);
  });
}

test("procesar: una colisión real del índice de turnos revierte el pago completo", async () => {
  const { pagoId } = await registrar();
  await pool.query(
    `INSERT INTO turnos (fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono, estado)
     VALUES ('2099-01-01', '10:00:00', '10:30:00', ?, ?, ?, ?, 'activo')`,
    [estilistaIds[0], localIds[0], "Cliente de prueba H5", "0000000000"]
  );
  const original = await leerPago(pagoId);
  const turno = await leerTurno();
  await assert.rejects(procesar(pagoId, pagoMP(pagoId)), (error: unknown) => {
    assert.ok(typeof error === "object" && error !== null && "code" in error);
    assert.equal(error.code, "ER_DUP_ENTRY");
    return true;
  });
  assert.deepEqual(await leerPago(pagoId), original);
  assert.deepEqual(await leerTurno(), turno);
});

test("confirmación: lectura posterior al COMMIT devuelve fecha ISO y solo datos del turno activo del local", async () => {
  const [servicio] = await pool.query<ResultSetHeader>(
    "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)",
    ["__TEST_PAGOS_H5_SERVICIO__", localIds[0]]
  );
  await pool.query("UPDATE turnos SET servicio_id = ? WHERE id = ? AND local_id = ?", [servicio.insertId, turnoId, localIds[0]]);
  assert.equal(await pagosService.obtenerDatosConfirmacionTurno(turnoId, localIds[0]), null);
  const { pagoId } = await registrar();
  assert.equal((await procesar(pagoId, pagoMP(pagoId))).resultado, "confirmado");
  const datos = await pagosService.obtenerDatosConfirmacionTurno(turnoId, localIds[0]);
  assert.ok(datos);
  assert.equal(datos.fecha, "2099-01-01");
  assert.equal(datos.localId, localIds[0]);
  assert.equal(datos.servicioNombre, "__TEST_PAGOS_H5_SERVICIO__");
  assert.equal(await pagosService.obtenerDatosConfirmacionTurno(turnoId, localIds[1]), null);
  await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ?", [turnoId, localIds[0]]);
  assert.equal(await pagosService.obtenerDatosConfirmacionTurno(turnoId, localIds[0]), null);
});

type DatosCrearPreference = Parameters<typeof pagosService.crearPreference>[0];

interface PreferencePayload {
  items: Array<{ unit_price: number; currency_id: string }>;
  notification_url: string;
  external_reference: string;
  metadata: { turno_id: number; local_id: number; pago_id: number; tipo: string };
  back_urls: { success: string; failure: string; pending: string };
}

function datosCrearPreference(changes: Partial<DatosCrearPreference> = {}): DatosCrearPreference {
  return {
    turnoId, localId: localIds[0], servicioNombre: "Servicio de prueba H5",
    monto: "100.00", tipo: "seña", porcentajeSeña: 30, accessToken: LOCAL_TOKEN, slug: "local-h5",
    ...changes,
  };
}

function gatewayPreference(
  t: TestContext,
  reply: (payload: PreferencePayload) => Promise<Record<string, unknown>> = async () => ({
    id: "pref-h5-local", init_point: "https://checkout.test/h5", sandbox_init_point: "https://checkout.test/sandbox-h5",
  }),
  status = 200
) {
  const calls: Array<{ url: string; authorization: string | null; key: string | null; payload: PreferencePayload }> = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    const payload = JSON.parse(String(init?.body)) as PreferencePayload;
    calls.push({
      url: String(input), authorization: new Headers(init?.headers).get("Authorization"),
      key: new Headers(init?.headers).get("X-Idempotency-Key"), payload,
    });
    return Response.json(await reply(payload), { status });
  });
  return calls;
}

function assertErrorCreacion(error: unknown, etapa: ErrorCreacionPreference["detalles"]["etapa"]): error is ErrorCreacionPreference {
  assert.ok(error instanceof ErrorCreacionPreference);
  assert.equal(error.detalles.etapa, etapa);
  assert.ok(error.detalles.pagoId > 0);
  assert.ok(!JSON.stringify(error).includes(LOCAL_TOKEN));
  assert.ok(!JSON.stringify(error).includes("TOKEN_GLOBAL_FICTICIO_H5"));
  return true;
}

test("crear preference: intento y vinculación ya están comprometidos cuando se consulta MP", async (t) => {
  const calls = gatewayPreference(t, async (payload) => {
    const intento = await contexto(payload.metadata.pago_id);
    assert.equal(intento.preference_id, null);
    assert.equal(intento.estado, "pendiente");
    assert.equal(intento.turno_pago_id, intento.id);
    assert.equal(intento.turno_estado, "pendiente_pago");
    assert.equal(await contarIntentos(), 1);
    return { id: "pref-h5-local", init_point: "https://checkout.test/h5" };
  });
  const result = await pagosService.crearPreference(datosCrearPreference());
  assert.equal(result.initPoint, "https://checkout.test/h5");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.mercadopago.com/checkout/preferences/");
  assert.equal(calls[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[0].key, `turno-intento-${result.pagoId}`);
  assert.equal(calls[0].payload.notification_url, `https://backend.test/api/pagos/webhook/turnos?pago_id=${result.pagoId}`);
  assert.equal(calls[0].payload.external_reference, `turno-${turnoId}-pago-${result.pagoId}`);
  assert.deepEqual(calls[0].payload.metadata, { turno_id: turnoId, local_id: localIds[0], pago_id: result.pagoId, tipo: "seña" });
  assert.equal(calls[0].payload.items[0].unit_price, 30);
  assert.equal(calls[0].payload.items[0].currency_id, "ARS");
  assert.equal((await leerPago(result.pagoId)).preference_id, "pref-h5-local");
  assert.equal((await leerTurno()).pago_id, result.pagoId);
  assert.equal(await contarIntentos(), 1, "No insertar otro pago después de la preferencia");
});

test("crear preference: monto normalizado en MP y BD coincide; pago completo también usa cuenta local", async (t) => {
  delete process.env.MP_ACCESS_TOKEN;
  const calls = gatewayPreference(t);
  const result = await pagosService.crearPreference(datosCrearPreference({ monto: "10.126", tipo: "completo" }));
  assert.equal(calls[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[0].payload.items[0].unit_price, 10.13);
  assert.equal((await leerPago(result.pagoId)).monto, "10.13");
  assert.equal(calls[0].payload.metadata.tipo, "completo");
});

test("crear preference: sin token local no hay fallback global ni intento o solicitud MP", async (t) => {
  const calls = gatewayPreference(t);
  for (const token of [undefined, "", "   "]) {
    await assert.rejects(
      pagosService.crearPreference(datosCrearPreference({ accessToken: token as string })),
      /token de Mercado Pago/
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(await contarIntentos(), 0);
  assert.equal((await leerTurno()).pago_id, null);
});

test("crear preference: credencial explícita distinta de la del local se detiene antes de MP", async (t) => {
  const calls = gatewayPreference(t);
  await assert.rejects(
    pagosService.crearPreference(datosCrearPreference({ accessToken: "TOKEN_GLOBAL_FICTICIO_H5" })),
    (error: unknown) => assertErrorCreacion(error, "verificacion_intento")
  );
  assert.equal(calls.length, 0);
  assert.equal(await contarIntentos(), 1);
  assert.equal((await contexto((await leerTurno()).pago_id)).preference_id, null);
});

test("crear preference: valida monto, porcentaje, tipo, slug y URLs antes de registrar", async (t) => {
  const calls = gatewayPreference(t);
  for (const changes of [
    { monto: 0 }, { monto: "" }, { monto: "no-es-monto" }, { porcentajeSeña: 0 },
    { porcentajeSeña: 101 }, { tipo: "otro" as "seña" }, { slug: "" },
  ]) {
    await assert.rejects(pagosService.crearPreference(datosCrearPreference(changes)));
  }
  process.env.BACKEND_URL = "https://backend.test/?credencial=oculta";
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), /BACKEND_URL/);
  assert.equal(calls.length, 0);
  assert.equal(await contarIntentos(), 0);
});

test("crear preference: fallo MP conserva un único intento y la misma clave en reintentos del SDK", async (t) => {
  const calls = gatewayPreference(t, async () => ({
    status: 500, message: `Error simulado ${LOCAL_TOKEN}`, request: { token: LOCAL_TOKEN },
  }), 500);
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    assert.ok(assertErrorCreacion(error, "creacion_preference"));
    assert.equal(error.detalles.preferenceId, null);
    assert.equal(error.detalles.status, 500);
    return true;
  });
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.key === calls[0].key));
  assert.equal(await contarIntentos(), 1);
  const intento = await contexto((await leerTurno()).pago_id);
  assert.equal(intento.preference_id, null);
  assert.equal(intento.estado, "pendiente");
  assert.equal(intento.turno_estado, "pendiente_pago");
});

test("crear preference: fallo vincular conserva intento y evidencia del ID remoto sin devolver enlace", async (t) => {
  const calls = gatewayPreference(t);
  const originalVincular = pagosService.vincularPreference.bind(pagosService);
  t.mock.method(pagosService, "vincularPreference", async () => {
    throw { code: "ER_QUERY_INTERRUPTED", sqlMessage: `Fallo simulado ${LOCAL_TOKEN}` };
  });
  let detalles: ErrorCreacionPreference["detalles"] | undefined;
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    assert.ok(assertErrorCreacion(error, "vinculacion_preference"));
    detalles = error.detalles;
    assert.equal(detalles.preferenceId, "pref-h5-local");
    return true;
  });
  assert.ok(detalles);
  assert.equal(calls.length, 1);
  assert.equal(await contarIntentos(), 1);
  assert.equal((await leerPago(detalles.pagoId)).preference_id, null);
  assert.equal((await leerTurno()).pago_id, detalles.pagoId);
  // Recuperación específica de la misma preferencia conocida; no otro create.
  assert.ok(detalles.preferenceId);
  await originalVincular(detalles.pagoId, detalles.localId, detalles.preferenceId);
  assert.equal((await leerPago(detalles.pagoId)).preference_id, "pref-h5-local");
  assert.equal(calls.length, 1);
});

test("crear preference: fallo de respuesta SQL posterior a escritura no borra la preferencia ya vinculada", async (t) => {
  const calls = gatewayPreference(t);
  const originalVincular = pagosService.vincularPreference.bind(pagosService);
  t.mock.method(pagosService, "vincularPreference", async (pagoId: number, localId: number, preferenceId: string) => {
    await originalVincular(pagoId, localId, preferenceId);
    throw new Error(`Fallo de respuesta simulado ${LOCAL_TOKEN}`);
  });
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    return assertErrorCreacion(error, "vinculacion_preference");
  });
  assert.equal(calls.length, 1);
  const intento = await contexto((await leerTurno()).pago_id);
  assert.equal(intento.preference_id, "pref-h5-local");
  assert.equal(intento.estado, "pendiente");
  assert.equal(await contarIntentos(), 1);
});

test("crear preference: respuesta MP sin ID conserva el intento sin preferencia", async (t) => {
  gatewayPreference(t, async () => ({ init_point: "https://checkout.test/h5" }));
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    return assertErrorCreacion(error, "respuesta_preference");
  });
  assert.equal((await contexto((await leerTurno()).pago_id)).preference_id, null);
});

test("crear preference: ID remoto válido se persiste aunque MP no devuelva init_point", async (t) => {
  gatewayPreference(t, async () => ({ id: "pref-h5-sin-link" }));
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    assert.ok(assertErrorCreacion(error, "respuesta_preference"));
    assert.equal(error.detalles.preferenceId, "pref-h5-sin-link");
    return true;
  });
  assert.equal((await contexto((await leerTurno()).pago_id)).preference_id, "pref-h5-sin-link");
});

test("crear preference: vinculación no persistida o imposible de verificar no devuelve el enlace", async (t) => {
  const calls = gatewayPreference(t);
  t.mock.method(pagosService, "vincularPreference", async () => {});
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    return assertErrorCreacion(error, "verificacion_intento");
  });
  assert.equal(calls.length, 1);
  assert.equal((await contexto((await leerTurno()).pago_id)).preference_id, null);
});

test("crear preference: intento desplazado durante MP conserva ambas filas y no recupera la vinculación anterior", async (t) => {
  let vigenteId = 0;
  let originalId = 0;
  gatewayPreference(t, async (payload) => {
    originalId = payload.metadata.pago_id;
    vigenteId = (await registrar()).pagoId;
    return { id: "pref-h5-desplazada", init_point: "https://checkout.test/h5" };
  });
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    return assertErrorCreacion(error, "verificacion_intento");
  });
  assert.equal(await contarIntentos(), 2);
  assert.equal((await leerTurno()).pago_id, vigenteId);
  assert.equal((await leerPago(originalId)).preference_id, "pref-h5-desplazada");
});

test("crear preference: pago aprobado antes de vincular no se reinicia ni devuelve otro link de cobro", async (t) => {
  let pagoId = 0;
  gatewayPreference(t, async (payload) => {
    pagoId = payload.metadata.pago_id;
    await procesar(pagoId, pagoMP(pagoId));
    return { id: "pref-h5-ya-pagada", init_point: "https://checkout.test/h5" };
  });
  await assert.rejects(pagosService.crearPreference(datosCrearPreference()), (error: unknown) => {
    assert.ok(error instanceof SenaYaAprobadaError);
    assert.equal(error.detalles?.etapa, "verificacion_intento");
    assert.equal(error.detalles?.preferenceId, "pref-h5-ya-pagada");
    return true;
  });
  const persistido = await leerPago(pagoId);
  assert.equal(persistido.estado, "aprobado");
  assert.equal(persistido.preference_id, "pref-h5-ya-pagada");
  assert.equal((await leerTurno()).estado, "activo");
});

async function datosReservaPublica() {
  const [locals] = await pool.query<RowDataPacket[]>("SELECT slug FROM locales WHERE id = ?", [localIds[0]]);
  const [servicio] = await pool.query<ResultSetHeader>(
    "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)",
    ["__TEST_PAGOS_H5_SERVICIO__", localIds[0]]
  );
  return {
    slug: String(locals[0].slug), fecha: "2099-01-01", hora: "13:00:00",
    estilista_id: estilistaIds[0], servicio_id: servicio.insertId,
    cliente_nombre: "Cliente público de prueba H5", cliente_telefono: "0000000001",
  };
}

test("reserva pública: crea turno pendiente y preference local con intento previo único", async (t) => {
  const calls = gatewayPreference(t, async (payload) => {
    const intento = await contexto(payload.metadata.pago_id);
    assert.equal(intento.turno_estado, "pendiente_pago");
    assert.equal(intento.preference_id, null);
    assert.equal(intento.turno_pago_id, intento.id);
    return { id: "pref-h5-publica", init_point: "https://checkout.test/publica" };
  });
  const result = await createTurnoPublico(await datosReservaPublica());
  assert.equal(result.mpLink, "https://checkout.test/publica");
  assert.equal(calls[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[0].payload.metadata.turno_id, result.id);
  assert.equal(calls[0].payload.external_reference, `turno-${result.id}-pago-${calls[0].payload.metadata.pago_id}`);
  assert.equal(await contarIntentos(result.id), 1);
  assert.equal((await contexto(calls[0].payload.metadata.pago_id)).preference_id, "pref-h5-publica");
});

test("reserva pública: fallo posterior a MP conserva datos y loguea solo evidencia segura", async (t) => {
  gatewayPreference(t);
  t.mock.method(pagosService, "vincularPreference", async () => {
    throw new Error(`Error simulado ${LOCAL_TOKEN}`);
  });
  await assert.rejects(createTurnoPublico(await datosReservaPublica()), /Turno reservado/);
  assert.ok(!JSON.stringify(creationLogs).includes(LOCAL_TOKEN));
  assert.ok(JSON.stringify(creationLogs).includes("vinculacion_preference"));
  assert.ok(JSON.stringify(creationLogs).includes("pref-h5-local"));
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM turnos WHERE local_id = ? AND hora = '13:00:00'", [localIds[0]]
  );
  assert.equal(rows.length, 1);
  assert.equal(await contarIntentos(Number(rows[0].id)), 1);
});

test("turno para pago: devuelve precio/slug/token del local y rechaza servicio o turno ajeno", async () => {
  const servicios: number[] = [];
  for (const localId of localIds) {
    const [servicio] = await pool.query<ResultSetHeader>(
      "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)",
      ["__TEST_PAGOS_H5_SERVICIO__", localId]
    );
    servicios.push(servicio.insertId);
  }
  await pool.query("UPDATE turnos SET servicio_id = ? WHERE id = ? AND local_id = ?", [servicios[0], turnoId, localIds[0]]);
  const turno = await pagosService.obtenerTurnoParaPago(turnoId, localIds[0]);
  assert.ok(turno);
  assert.equal(turno.precio, "100.00");
  assert.equal(turno.mp_access_token, LOCAL_TOKEN);
  assert.ok(turno.slug?.startsWith("test-h5-"));
  assert.equal(await pagosService.obtenerTurnoParaPago(turnoId, localIds[1]), null);
  await pool.query("UPDATE turnos SET servicio_id = ? WHERE id = ? AND local_id = ?", [servicios[1], turnoId, localIds[0]]);
  assert.equal(await pagosService.obtenerTurnoParaPago(turnoId, localIds[0]), null);
});

async function habilitarCrearLink() {
  const [servicio] = await pool.query<ResultSetHeader>(
    "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)",
    ["__TEST_PAGOS_H5_SERVICIO__", localIds[0]]
  );
  await pool.query("UPDATE turnos SET servicio_id = ? WHERE id = ? AND local_id = ?", [servicio.insertId, turnoId, localIds[0]]);
}

async function invocarCrearLink(tipo: "seña" | "completo" = "seña", localId = localIds[0]) {
  const result = { statusCode: 200, body: "" };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    json(body: unknown) { result.body = JSON.stringify(body); return this; },
  };
  await crearLinkPago({ body: { turnoId, tipo }, user: { localId } } as unknown as Request,
    response as unknown as ExpressResponse);
  return result;
}

function barrera() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("B2: seña aprobada bloquea registrar y crear-link sin desplazar pago_id ni alterar el original", async (t) => {
  await habilitarCrearLink();
  const { pagoId } = await registrar();
  await procesar(pagoId, pagoMP(pagoId));
  const pagoOriginal = await leerPago(pagoId);
  const turnoOriginal = await leerTurno();
  const calls = gatewayPreference(t);

  await assert.rejects(registrar(), SenaYaAprobadaError);
  const result = await invocarCrearLink();

  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).codigo, "SENA_YA_APROBADA");
  assert.equal(JSON.parse(result.body).link, undefined);
  assert.equal(calls.length, 0);
  assert.equal(await contarIntentos(), 1);
  assert.deepEqual(await leerPago(pagoId), pagoOriginal);
  assert.deepEqual(await leerTurno(), turnoOriginal);
});

test("B2: seña aprobada en el historial bloquea aunque pago_id apunte a un intento completo", async () => {
  const aprobada = await registrar();
  await procesar(aprobada.pagoId, pagoMP(aprobada.pagoId));
  const completo = await registrar(100, "completo");
  const turnoOriginal = await leerTurno();
  assert.equal(turnoOriginal.pago_id, completo.pagoId);

  await assert.rejects(registrar(), SenaYaAprobadaError);

  assert.equal((await contexto(completo.pagoId)).sena_aprobada_id, aprobada.pagoId);
  assert.deepEqual(await leerTurno(), turnoOriginal);
  assert.equal(await contarIntentos(), 2);
  assert.equal((await leerPago(aprobada.pagoId)).estado, "aprobado");
});

test("B2: intento de seña pendiente admite un nuevo enlace mientras el turno siga elegible", async (t) => {
  await habilitarCrearLink();
  const pendiente = await registrar();
  const original = await leerPago(pendiente.pagoId);
  const calls = gatewayPreference(t);
  const result = await invocarCrearLink();
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(await contarIntentos(), 2);
  assert.notEqual((await leerTurno()).pago_id, pendiente.pagoId);
  assert.deepEqual(await leerPago(pendiente.pagoId), original);
});

for (const status of ["rejected", "cancelled"] as const) {
  test(`B2: ${status} anterior no bloquea reintento en una reserva pendiente de otro intento`, async (t) => {
    await habilitarCrearLink();
    const viejo = await registrar();
    await registrar();
    await procesar(viejo.pagoId, pagoMP(viejo.pagoId, nuevoIdMp(), { status }));
    assert.equal((await leerTurno()).estado, "pendiente_pago");
    const original = await leerPago(viejo.pagoId);
    const calls = gatewayPreference(t);

    assert.equal((await invocarCrearLink()).statusCode, 200);

    assert.equal(calls.length, 1);
    assert.equal(await contarIntentos(), 3);
    assert.deepEqual(await leerPago(viejo.pagoId), original);
  });

  test(`B2: ${status} vigente mantiene el bloqueo actual del turno cancelado sin nuevos intentos`, async (t) => {
    await habilitarCrearLink();
    const vigente = await registrar();
    await procesar(vigente.pagoId, pagoMP(vigente.pagoId, nuevoIdMp(), { status }));
    const original = await leerTurno();
    const calls = gatewayPreference(t);

    assert.equal((await invocarCrearLink()).statusCode, 400);

    assert.equal(calls.length, 0);
    assert.equal(await contarIntentos(), 1);
    assert.deepEqual(await leerTurno(), original);
  });
}

test("B2: completo sigue generando un enlace en turno activo después de una seña aprobada", async (t) => {
  await habilitarCrearLink();
  const sena = await registrar();
  await procesar(sena.pagoId, pagoMP(sena.pagoId));
  const original = await leerPago(sena.pagoId);
  const calls = gatewayPreference(t);

  assert.equal((await invocarCrearLink("completo")).statusCode, 200);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.metadata.tipo, "completo");
  assert.equal(calls[0].payload.items[0].unit_price, 100);
  assert.equal(await contarIntentos(), 2);
  assert.deepEqual(await leerPago(sena.pagoId), original);
});

test("B2: una aprobación de completo no activa la regla exclusiva de seña", async (t) => {
  await habilitarCrearLink();
  const completo = await registrar(30, "completo");
  await procesar(completo.pagoId, pagoMP(completo.pagoId, nuevoIdMp(), {
    metadata: { turno_id: turnoId, local_id: localIds[0], pago_id: completo.pagoId, tipo: "completo" },
  }));
  const calls = gatewayPreference(t);
  assert.equal((await invocarCrearLink()).statusCode, 200);
  assert.equal(calls[0].payload.metadata.tipo, "seña");
});

test("B2: regla de seña aprobada respeta local_id y no bloquea un turno de otro local", async () => {
  const otro = await registrarEnOtroLocal();
  await procesar(otro.intento.pagoId, otro.payment(nuevoIdMp()));
  const propio = await registrar();
  assert.equal((await contexto(propio.pagoId)).sena_aprobada_id, null);
  await assert.rejects(pagosService.registrarIntentoPago({
    turnoId: (await leerPago(otro.intento.pagoId, localIds[1])).turno_id,
    localId: localIds[1], monto: 30, tipo: "seña",
  }), SenaYaAprobadaError);
  await assert.rejects(pagosService.registrarIntentoPago({
    turnoId, localId: localIds[1], monto: 30, tipo: "seña",
  }), /Turno no encontrado/);
  assert.equal((await leerTurno()).pago_id, propio.pagoId);
});

test("B2: historial inconsistente de otro local no cuenta como seña aprobada del turno propio", async () => {
  const viejo = await registrar();
  await pool.query("UPDATE pagos SET local_id = ?, estado = 'aprobado' WHERE id = ? AND local_id = ?",
    [localIds[1], viejo.pagoId, localIds[0]]);
  const nuevo = await registrar();
  assert.equal((await contexto(nuevo.pagoId)).sena_aprobada_id, null);
  assert.equal((await leerTurno()).pago_id, nuevo.pagoId);
});

test("B2: confirmación toma el lock primero y la creación en espera no inserta ni devuelve enlace", { timeout: 15000 }, async (t) => {
  const anterior = await registrar();
  const aprobado = pagoMP(anterior.pagoId);
  const lockTomado = barrera();
  const registroEnEspera = barrera();
  const continuarConfirmacion = barrera();
  const originalGetConnection = pool.getConnection.bind(pool);
  let connections = 0;
  t.mock.method(pool, "getConnection", async () => {
    const connection = await originalGetConnection();
    const numero = ++connections;
    const originalQuery = connection.query.bind(connection);
    t.mock.method(connection, "query", (async (sql: string, values?: Parameters<typeof connection.query>[1]) => {
      const lockTurno = sql.includes("FROM turnos") && sql.includes("FOR UPDATE");
      if (numero === 2 && lockTurno) registroEnEspera.resolve();
      const result = await originalQuery(sql, values);
      if (numero === 1 && lockTurno) {
        lockTomado.resolve();
        await continuarConfirmacion.promise;
      }
      return result;
    }) as typeof connection.query);
    return connection;
  });
  const calls = gatewayPreference(t);
  const confirmacion = procesar(anterior.pagoId, aprobado);
  await lockTomado.promise;
  const creacion = pagosService.crearPreference(datosCrearPreference());
  const resultadoCreacion = Promise.allSettled([creacion]);
  try {
    await registroEnEspera.promise;
  } finally {
    continuarConfirmacion.resolve();
  }
  assert.equal((await confirmacion).resultado, "confirmado");
  const [result] = await resultadoCreacion;
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.ok(result.reason instanceof SenaYaAprobadaError);
  assert.equal(calls.length, 0);
  assert.equal(await contarIntentos(), 1);
  assert.equal((await leerTurno()).pago_id, anterior.pagoId);
  assert.equal((await leerPago(anterior.pagoId)).mp_payment_id, String(aprobado.id));
});

test("B2: registro gana primero, aprobación durante MP impide entregar el nuevo enlace", { timeout: 15000 }, async (t) => {
  const anterior = await registrar();
  const mpIniciado = barrera();
  const continuarMp = barrera();
  let nuevoId = 0;
  const calls = gatewayPreference(t, async (payload) => {
    nuevoId = payload.metadata.pago_id;
    mpIniciado.resolve();
    await continuarMp.promise;
    return { id: "pref-h5-carrera-b2", init_point: "https://checkout.test/carrera-b2" };
  });
  const creacion = pagosService.crearPreference(datosCrearPreference());
  const resultadoCreacion = Promise.allSettled([creacion]);
  await mpIniciado.promise;
  const confirmacion = await procesar(anterior.pagoId, pagoMP(anterior.pagoId));
  continuarMp.resolve();
  const [result] = await resultadoCreacion;

  assert.equal(confirmacion.resultado, "registrado_sin_confirmar");
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.ok(result.reason instanceof SenaYaAprobadaError);
    assert.equal(result.reason.detalles?.preferenceId, "pref-h5-carrera-b2");
  }
  assert.equal(calls.length, 1);
  assert.equal(await contarIntentos(), 2);
  assert.equal((await leerPago(anterior.pagoId)).estado, "aprobado");
  assert.equal((await leerPago(nuevoId)).estado, "pendiente");
  assert.equal((await leerPago(nuevoId)).preference_id, "pref-h5-carrera-b2");
  await assert.rejects(registrar(), SenaYaAprobadaError);
});
