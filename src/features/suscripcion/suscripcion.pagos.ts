import { pool } from "../../config/db";

export type ResultadoPagoSuscripcion =
  | "renovada"
  | "registrada_sin_renovar"
  | "ya_aprobada"
  | "segundo_pago_aprobado"
  | "referencia_invalida"
  | "estado_no_final"
  | "intento_no_encontrado"
  | "local_inexistente";

const REGEX_REFERENCIA =
  /^suscripcion-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export async function procesarPagoSuscripcion(params: {
  externalReference: string;
  status: string;
  mpPaymentId: string;
}): Promise<ResultadoPagoSuscripcion> {
  const { externalReference, status, mpPaymentId } = params;

  const coincidencia = externalReference.match(REGEX_REFERENCIA);
  if (!coincidencia) return "referencia_invalida";

  const localId = Number(coincidencia[1]);
  if (!Number.isSafeInteger(localId) || localId <= 0) {
    return "referencia_invalida";
  }

  const estadoPago =
    status === "approved" ? "aprobado"
    : status === "rejected" ? "rechazado"
    : status === "cancelled" ? "cancelado"
    : null;

  if (!estadoPago) return "estado_no_final";

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [pagos]: any = await connection.query(
      `SELECT id, local_id, estado, mp_payment_id
       FROM pagos_suscripcion
       WHERE external_reference = ?
       FOR UPDATE`,
      [externalReference]
    );

    const pago = pagos[0];

    if (!pago || Number(pago.local_id) !== localId) {
      await connection.rollback();
      return "intento_no_encontrado";
    }

    if (pago.estado === "aprobado") {
      await connection.rollback();
      return status === "approved" && pago.mp_payment_id !== mpPaymentId
        ? "segundo_pago_aprobado"
        : "ya_aprobada";
    }

    const [locales]: any = await connection.query(
      `SELECT id FROM locales WHERE id = ? FOR UPDATE`,
      [localId]
    );

    if (!locales.length) {
      await connection.rollback();
      return "local_inexistente";
    }

    await connection.query(
      `UPDATE pagos_suscripcion
       SET estado = ?, mp_payment_id = ?
       WHERE id = ?`,
      [estadoPago, mpPaymentId, pago.id]
    );

    if (status === "approved") {
      await connection.query(
        `UPDATE locales
         SET suscripcion_estado = 'activo',
             suscripcion_vencimiento =
               CASE
                 WHEN suscripcion_vencimiento >= CURDATE()
                   THEN DATE_ADD(suscripcion_vencimiento, INTERVAL 30 DAY)
                 ELSE DATE_ADD(CURDATE(), INTERVAL 30 DAY)
               END
         WHERE id = ?`,
        [localId]
      );
      await connection.commit();
      return "renovada";
    }

    await connection.commit();
    return "registrada_sin_renovar";
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}