import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { procesarPagoSuscripcion } from "./suscripcion.pagos";

const ESTADO_INICIAL = "pendiente_pago";

let localId: number;
let contadorPagos = 1000;

const hoy = () => `date_format(curdate(), '%Y-%m-%d')`;

async function crearIntento(): Promise<string> {
  const ref = `suscripcion-${localId}-${randomUUID()}`;
  await pool.query(
    `INSERT INTO pagos_suscripcion (local_id, external_reference, monto, estado)
     VALUES (?, ?, 100, 'pendiente')`,
    [localId, ref]
  );
  return ref;
}

const nuevoPagoMp = () => String(++contadorPagos);

async function fijarSuscripcion(vencimientoSql: string | null, estado = ESTADO_INICIAL) {
  await pool.query(
    `UPDATE locales
     SET suscripcion_vencimiento = ${vencimientoSql ?? "NULL"},
         suscripcion_estado = ?
     WHERE id = ?`,
    [estado, localId]
  );
}

async function leerLocal() {
  const [rows]: any = await pool.query(
    `SELECT suscripcion_estado AS estado,
            DATE_FORMAT(suscripcion_vencimiento, '%Y-%m-%d') AS venc,
            DATEDIFF(suscripcion_vencimiento, CURDATE()) AS dias
     FROM locales WHERE id = ?`,
    [localId]
  );
  return rows[0];
}

before(async () => {
  // PROTECCIÓN: abortar si no es claramente la base local.
  const [info]: any = await pool.query(
    `SELECT DATABASE() AS db, @@hostname AS host`
  );
  const { db, host } = info[0];

  const [tcp]: any = await pool.query(`SELECT @@port AS port`);
  console.log(`🔒 Base conectada: ${db} (host del servidor: ${host}, puerto ${tcp[0].port})`);

  if (db !== "agenda_db") {
    throw new Error(`ABORTADO: la base es "${db}", se esperaba "agenda_db".`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABORTADO: NODE_ENV=production.");
  }
  const urlsProhibidas = /railway|rlwy|proxy\.rlwy\.net/i;
  for (const [k, v] of Object.entries(process.env)) {
    if (/DB|DATABASE|MYSQL/i.test(k) && urlsProhibidas.test(String(v))) {
      throw new Error(`ABORTADO: la variable ${k} apunta a Railway.`);
    }
  }

  // Local de prueba propio: no toca datos reales.
  const [res]: any = await pool.query(
    `INSERT INTO locales (nombre, slug) VALUES ('__TEST_SUSCRIPCION__', ?)`,
    [`test-${randomUUID().slice(0, 8)}`]
  );
  localId = res.insertId;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM pagos_suscripcion WHERE local_id = ?`, [localId]);
  await fijarSuscripcion(null);
});

after(async () => {
  if (localId) {
    await pool.query(`DELETE FROM pagos_suscripcion WHERE local_id = ?`, [localId]);
    await pool.query(`DELETE FROM locales WHERE id = ?`, [localId]);
  }
  await pool.end();
});

test("primera aprobación: activa y suma 30 días desde hoy", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({
    externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "renovada");
  const l = await leerLocal();
  assert.equal(l.estado, "activo");
  assert.equal(l.dias, 30);
});

test("notificación repetida del mismo pago: no extiende otra vez", async () => {
  const ref = await crearIntento();
  const mp = nuevoPagoMp();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp });
  assert.equal(r, "ya_aprobada");
  assert.equal((await leerLocal()).dias, 30);
});

test("segundo pago aprobado distinto: no extiende y se avisa", async () => {
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "segundo_pago_aprobado");
  assert.equal((await leerLocal()).dias, 30);
});

test("suscripción vigente: acumula 30 días desde el vencimiento", async () => {
  await fijarSuscripcion(`DATE_ADD(CURDATE(), INTERVAL 10 DAY)`, "activo");
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 40);
});

test("suscripción vencida: cuenta 30 días desde hoy", async () => {
  await fijarSuscripcion(`DATE_SUB(CURDATE(), INTERVAL 15 DAY)`, "activo");
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 30);
});

test("sin vencimiento (NULL): cuenta 30 días desde hoy", async () => {
  await fijarSuscripcion(null);
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 30);
});

test("pago rechazado: no activa ni renueva", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "rejected", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "registrada_sin_renovar");
  const l = await leerLocal();
  assert.equal(l.estado, ESTADO_INICIAL);
  assert.equal(l.venc, null);
});

test("pago cancelado: no activa ni renueva", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "cancelled", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "registrada_sin_renovar");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("rechazado y luego aprobado en el mismo checkout: renueva una vez", async () => {
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "rejected", mpPaymentId: nuevoPagoMp() });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "renovada");
  assert.equal((await leerLocal()).dias, 30);
});

test("estado no final (pending): no modifica nada", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "pending", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "estado_no_final");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia con formato inválido: no modifica nada", async () => {
  const r = await procesarPagoSuscripcion({
    externalReference: `suscripcion-${localId}`, status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "referencia_invalida");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia válida pero inexistente: no modifica nada", async () => {
  const r = await procesarPagoSuscripcion({
    externalReference: `suscripcion-${localId}-${randomUUID()}`,
    status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "intento_no_encontrado");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia de otro local: no modifica nada", async () => {
  const ref = await crearIntento();
  const otra = ref.replace(`suscripcion-${localId}-`, `suscripcion-${localId + 99999}-`);
  const r = await procesarPagoSuscripcion({ externalReference: otra, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "intento_no_encontrado");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("dos notificaciones concurrentes del mismo pago: una sola renovación", async () => {
  const ref = await crearIntento();
  const mp = nuevoPagoMp();
  const resultados = await Promise.all([
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp }),
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp }),
  ]);
  assert.equal(resultados.filter((r) => r === "renovada").length, 1);
  assert.equal((await leerLocal()).dias, 30);
});

test("error de base de datos en la transacción: no deja renovación parcial", async () => {
  const ref = await crearIntento();
  // Ocupamos el mp_payment_id en OTRA fila para que el UPDATE choque con el índice único.
  const repetido = nuevoPagoMp();
  const otraRef = await crearIntento();
  await pool.query(
    `UPDATE pagos_suscripcion SET mp_payment_id = ? WHERE external_reference = ?`,
    [repetido, otraRef]
  );

  await assert.rejects(
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: repetido })
  );

  const [rows]: any = await pool.query(
    `SELECT estado, mp_payment_id FROM pagos_suscripcion WHERE external_reference = ?`, [ref]
  );
  assert.equal(rows[0].estado, "pendiente");
  assert.equal(rows[0].mp_payment_id, null);
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});