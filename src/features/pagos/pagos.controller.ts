import { Request, Response } from 'express';
import { pool } from '../../config/db';
import { pagosService } from './pagos.service';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { sendTurnoConfirmado } from '../notifications/application/sendWhatsAppNotification';
import { formatPhoneAR } from '../../helpers/formatPhoneAR';
import { procesarPagoSuscripcion } from '../suscripcion/suscripcion.pagos';

// Inicializamos el cliente de MP una sola vez para reutilizarlo
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN!,
});
const paymentClient = new Payment(mpClient);

export const crearLinkPago = async (req: Request, res: Response) => {
  try {
    const { turnoId, tipo, porcentajeSeña } = req.body;

    if (tipo !== undefined && tipo !== 'seña' && tipo !== 'completo') {
      return res.status(400).json({ error: 'Tipo de pago inválido' });
    }

    if (
      porcentajeSeña !== undefined &&
      (!Number.isFinite(porcentajeSeña) ||
        porcentajeSeña < 1 ||
        porcentajeSeña > 100)
    ) {
      return res.status(400).json({ error: 'Porcentaje de seña inválido' });
    }
    const localId = (req as any).user?.localId;

    if (!localId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const idTurno = Number(turnoId);

    if (!Number.isSafeInteger(idTurno) || idTurno <= 0) {
      return res.status(400).json({ error: 'turnoId inválido' });
    }

    // Obtener información del turno y servicio
    const [turnos]: any = await pool.query(
      `SELECT t.id, t.servicio_id, s.nombre, s.precio, l.slug
        FROM turnos t
        JOIN servicios s ON t.servicio_id = s.id
        JOIN locales l ON l.id = t.local_id
        WHERE t.id = ? AND t.local_id = ?`,
      [idTurno, localId]
    );

    if (turnos.length === 0) {
      return res.status(404).json({ error: 'Turno no encontrado' });
    }

    const turno = turnos[0];

    // Crear preference de pago
    const resultado = await pagosService.crearPreference({
      turnoId,
      localId,
      servicioNombre: turno.nombre,
      monto: turno.precio,
      tipo: tipo ?? 'seña',
      porcentajeSeña: porcentajeSeña ?? 30,
      slug: turno.slug,
    });

    res.json({
      message: 'Link de pago creado exitosamente',
      link: resultado.initPoint,
      pagoId: resultado.pagoId,
    });
  } catch (error: any) {
    console.error('Error creando link de pago:', error);
    res.status(500).json({ error: 'Error al crear el link de pago' });
  }
};


export const webhook = async (req: Request, res: Response) => {
  console.log(
    '📥 WEBHOOK RECIBIDO - BODY:',
    JSON.stringify(req.body, null, 2)
  );

  try {
    const { type, data, topic, resource, action } = req.body;

    // 1. Normalizar el ID del pago.
    let paymentId: string | undefined;

    if (type === 'payment' && data?.id) {
      paymentId = String(data.id);
    } else if (topic === 'payment' && resource) {
      paymentId = String(resource).split('/').pop();
    } else if (action === 'payment.created' && data?.id) {
      paymentId = String(data.id);
    }

    if (!paymentId || !/^\d+$/.test(paymentId)) {
      console.log('ℹ️ Webhook ignorado: ID de pago inválido.');
      return res.status(200).send('OK');
    }

    console.log('💳 Procesando pago ID:', paymentId);

    // 2. Consultar el estado real del pago en Mercado Pago.
    const payment: any = await obtenerPaymentInfo(paymentId);

    if (!payment) {
      console.error('❌ No se pudo obtener la información del pago.');
      return res.status(500).send('Error');
    }

    const externalReference = payment.external_reference;
    const status = payment.status;

    console.log('📋 Referencia externa:', externalReference);
    console.log('💳 Estado de Mercado Pago:', status);


    // 3. Procesar suscripciones.
    if (externalReference?.startsWith("suscripcion-")) {
      const resultado = await procesarPagoSuscripcion({
        externalReference,
        status,
        mpPaymentId: String(payment.id),
      });

      if (resultado === "segundo_pago_aprobado") {
        console.warn("⚠️ Segundo pago aprobado para la misma referencia. Revisar a mano:", {
          externalReference,
          pagoNuevo: payment.id,
        });
      } else {
        console.log("📌 Resultado suscripción:", resultado);
      }

      return res.status(200).send("OK");
    }

    // 4. Verificar que sea un pago de turno.
    if (!externalReference?.startsWith('turno-')) {
      console.warn('⚠️ Referencia externa no reconocida:', externalReference);
      return res.status(200).send('OK');
    }

    const turnoIdTexto = externalReference.slice('turno-'.length);
    const turnoId = Number(turnoIdTexto);

    if (!Number.isSafeInteger(turnoId) || turnoId <= 0) {
      console.error('❌ ID de turno inválido en external_reference.');
      return res.status(200).send('OK');
    }

    // 5. Procesar solamente estados finales conocidos.
    if (
      status !== 'approved' &&
      status !== 'rejected' &&
      status !== 'cancelled'
    ) {
      console.log('⏳ Pago todavía sin estado final:', status);
      return res.status(200).send('OK');
    }

    // 6. Buscar el registro exacto del pago.
    const preferenceId = payment.preference_id
      ? String(payment.preference_id)
      : '';

    let pago: any = null;

    if (preferenceId) {
      pago = await pagosService.obtenerPagoPorPreferenceId(preferenceId);
    }

    if (!pago) {
      pago = await pagosService.obtenerPagoPorMpPaymentId(
        String(payment.id)
      );
    }

    if (!pago) {
      console.error('❌ No se encontró el registro exacto del pago.', {
        paymentId: payment.id,
        preferenceId,
        turnoId,
      });

      return res.status(200).send('OK');
    }

    // 7. Validar la relación entre pago, turno y local.
    const [turnosAsociados]: any = await pool.query(
      `SELECT id, local_id
       FROM turnos
       WHERE id = ?
       LIMIT 1`,
      [turnoId]
    );

    if (
      Number(pago.turno_id) !== turnoId ||
      !turnosAsociados.length ||
      Number(pago.local_id) !== Number(turnosAsociados[0].local_id)
    ) {
      console.error('❌ El pago no coincide con el turno o el local.', {
        pagoId: pago.id,
        turnoId,
        localIdPago: pago.local_id,
        localIdTurno: turnosAsociados[0]?.local_id,
      });

      return res.status(200).send('OK');
    }

    const estadoPorStatus: Record<
      string,
      'aprobado' | 'rechazado' | 'cancelado'
    > = {
      approved: 'aprobado',
      rejected: 'rechazado',
      cancelled: 'cancelado',
    };

    const nuevoEstado = estadoPorStatus[status];

    // 8. Bloquear el pago y actualizar pago/turno atómicamente.
    const connection = await pool.getConnection();
    let notificarWhatsApp = false;

    try {
      await connection.beginTransaction();

      const [pagosBloqueados]: any = await connection.query(
        `SELECT id, turno_id, local_id, estado
         FROM pagos
         WHERE id = ?
         FOR UPDATE`,
        [pago.id]
      );

      const pagoActual = pagosBloqueados[0];

      if (
        !pagoActual ||
        Number(pagoActual.turno_id) !== turnoId ||
        Number(pagoActual.local_id) !== Number(turnosAsociados[0].local_id)
      ) {
        await connection.rollback();
        console.error('❌ El pago no coincide durante la transacción.');
        return res.status(200).send('OK');
      }

      // Evitar procesar nuevamente un pago que ya salió de pendiente.
      if (pagoActual.estado !== 'pendiente') {
        await connection.rollback();

        console.log(
          'ℹ️ Pago ya procesado. Estado actual:',
          pagoActual.estado
        );

        return res.status(200).send('OK');
      }

      const [turnosBloqueados]: any = await connection.query(
        `SELECT id, local_id, estado
         FROM turnos
         WHERE id = ? AND local_id = ?
         FOR UPDATE`,
        [turnoId, pagoActual.local_id]
      );

      if (!turnosBloqueados.length) {
        await connection.rollback();
        console.error('❌ No se encontró el turno del local esperado.');
        return res.status(200).send('OK');
      }

      // Guardar el estado final del pago.
      await connection.query(
        `UPDATE pagos
         SET estado = ?,
             mp_payment_id = ?,
             mp_status = ?,
             mp_status_detail = ?
         WHERE id = ?`,
        [
          nuevoEstado,
          String(payment.id),
          status,
          payment.status_detail ?? null,
          pagoActual.id,
        ]
      );

      if (status === 'approved') {
        console.log('🟢 Pago aprobado. Actualizando turno.');

        await connection.query(
          `UPDATE turnos
           SET estado = 'activo'
           WHERE id = ? AND local_id = ?`,
          [turnoId, pagoActual.local_id]
        );

        notificarWhatsApp = true;
      } else {
        console.log(
          '🔴 Pago rechazado o cancelado. Actualizando turno.'
        );

        await connection.query(
          `UPDATE turnos
           SET estado = 'cancelado'
           WHERE id = ? AND local_id = ?`,
          [turnoId, pagoActual.local_id]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // 9. Enviar WhatsApp después del COMMIT.
    if (notificarWhatsApp) {
      try {
        const [turnos]: any = await pool.query(
          `SELECT
             t.cliente_nombre,
             t.cliente_telefono,
             t.fecha,
             t.hora,
             s.nombre AS servicioNombre,
             l.nombre AS localNombre,
             l.telefono AS localTelefono,
             l.id AS local_id
           FROM turnos t
           JOIN servicios s ON t.servicio_id = s.id
           JOIN locales l ON l.id = t.local_id
           WHERE t.id = ? AND t.local_id = ?`,
          [turnoId, pago.local_id]
        );

        if (turnos.length > 0) {
          const t = turnos[0];

          await sendTurnoConfirmado({
            clienteNombre: t.cliente_nombre,
            clienteTelefono: formatPhoneAR(t.cliente_telefono),
            fecha: new Date(
              t.fecha + 'T00:00:00'
            ).toLocaleDateString('es-AR'),
            hora: t.hora,
            servicio: t.servicioNombre,
            localNombre: t.localNombre,
            localTelefono: formatPhoneAR(t.localTelefono),
            localId: String(t.local_id),
          });

          console.log('✅ WhatsApp de confirmación enviado.');
        } else {
          console.warn('⚠️ Turno no encontrado para enviar WhatsApp.');
        }
      } catch (whatsappErr) {
        console.error(
          '❌ Error enviando WhatsApp (no bloqueante):',
          whatsappErr
        );
      }
    }

    console.log(
      `🎉 Pago ${paymentId} procesado. Estado final: ${nuevoEstado}`
    );

    return res.status(200).send('OK');
  } catch (error: any) {
    console.error('💥 Error crítico en webhook:', error);
    return res.status(500).send('Error');
  }
};

// Función helper para obtener info del pago desde MP
const obtenerPaymentInfo = async (paymentId: string) => {
  try {
    // ⚠️ CRUCIAL: Verificamos que el token global exista para poder CONSULTAR a MP
    if (!process.env.MP_ACCESS_TOKEN) {
      console.error("⚠️ MP_ACCESS_TOKEN no está definido en las variables de entorno de Railway.");
      return null;
    }

    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(client);

    const payment = await paymentClient.get({ id: paymentId });
    return payment;
  } catch (error: any) {
    console.error('❌ Error obteniendo payment info de MP:', error.message || error);
    return null;
  }
};