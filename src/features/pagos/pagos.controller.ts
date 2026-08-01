import { Request, Response } from 'express';
import { pool } from '../../config/db';
import { pagosService } from './pagos.service';
import { MercadoPagoConfig, Payment } from 'mercadopago';

// Inicializamos el cliente de MP una sola vez para reutilizarlo
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN!,
});
const paymentClient = new Payment(mpClient);

export const crearLinkPago = async (req: Request, res: Response) => {
  try {
    const { turnoId, tipo, porcentajeSeña } = req.body;
    const localId = (req as any).user?.localId;

    if (!localId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    if (!turnoId) {
      return res.status(400).json({ error: 'turnoId es requerido' });
    }

    // Obtener información del turno y servicio
    const [turnos]: any = await pool.query(
      `SELECT t.id, t.servicio_id, s.nombre, s.precio
       FROM turnos t
       JOIN servicios s ON t.servicio_id = s.id
       WHERE t.id = ? AND t.local_id = ?`,
      [turnoId, localId]
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
      tipo: tipo || 'seña',
      porcentajeSeña: porcentajeSeña || 30,
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
  console.log("📥 WEBHOOK RECIBIDO - BODY:", JSON.stringify(req.body, null, 2));

  try {
    const { type, data, topic, resource, action } = req.body;

    // 🛡️ NORMALIZACIÓN: MP envía el ID de formas distintas. Lo unificamos aquí.
    let paymentId: string | undefined;

    if (type === 'payment' && data?.id) {
      paymentId = data.id; // Formato nuevo
    } else if (topic === 'payment' && resource) {
      paymentId = resource; // Formato legacy (el que te está llegando)
    } else if (action === 'payment.created' && data?.id) {
      paymentId = data.id; // Formato alternativo
    }

    // Si no es un evento de pago con ID, ignoramos y respondemos 200 para que MP no insista
    if (!paymentId) {
      console.log("ℹ️ Webhook ignorado (no es un evento de pago con ID válido).");
      return res.status(200).send('OK');
    }

    console.log("💳 [1] Procesando pago ID:", paymentId);

    // Obtener información del pago desde MP
    const payment: any = await obtenerPaymentInfo(paymentId);

    if (!payment) {
      console.error("❌ [2] FALLO: No se pudo obtener la info del pago de MP. Revisa tu MP_ACCESS_TOKEN global en Railway.");
      return res.status(200).send('OK'); // Respondemos 200 igual para evitar bucles de reintentos
    }

    console.log("✅ [3] Info del pago obtenida. Status:", payment.status);

    // ✅ Validar que external_reference exista
    const externalReference = payment.external_reference;
    if (!externalReference || !externalReference.startsWith('turno-')) {
      console.warn("⚠️ [4] Webhook recibido sin external_reference válido:", externalReference);
      return res.status(200).send('OK');
    }

    const turnoId = parseInt(externalReference.replace('turno-', ''), 10);
    console.log("🎫 [5] Turno ID extraído:", turnoId);

    // ✅ Acceder a preference_id de forma segura
    const preferenceId = payment.preference_id || '';
    console.log("🔗 [6] Preference ID:", preferenceId || "(Vacío, usando fallback)");

    // 🛡️ FALLBACK: Buscar el pago en nuestra BD
    let pago: any = null;

    if (preferenceId) {
      pago = await pagosService.obtenerPagoPorPreferenceId(preferenceId);
    }

    // Si no se encontró por preference_id (o vino vacío), buscamos por turno_id
    if (!pago) {
      console.log("⚠️ [7] Buscando pago por turno_id:", turnoId);
      pago = await pagosService.obtenerPagoPorTurnoId(turnoId);
    }

    if (!pago) {
      console.error("❌ [8] FALLO: Pago no encontrado en BD para turno_id:", turnoId);
      return res.status(200).send('OK'); // Respondemos 200 para evitar reintentos infinitos de MP
    }

    console.log("✅ [9] Pago encontrado en BD. ID:", pago.id);

    // Actualizar estado según el status del pago
    const status = payment.status;
    let nuevoEstado: 'aprobado' | 'rechazado' | 'cancelado' = 'rechazado';
    let nuevoEstadoTurno = 'activo';

    if (status === 'approved') {
      nuevoEstado = 'aprobado';
      console.log("🟢 [9] Pago APROBADO. Actualizando turno a 'activo'...");
      await pool.query("UPDATE turnos SET estado = 'activo' WHERE id = ?", [turnoId]);
    } else if (status === 'cancelled' || status === 'rejected') {
      nuevoEstado = status === 'cancelled' ? 'cancelado' : 'rechazado';
      nuevoEstadoTurno = 'cancelado';
      console.log("🔴 [9] Pago RECHAZADO/CANCELADO. Actualizando turno a 'cancelado'...");
      await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ?", [turnoId]);
    }

    // Actualizar el registro de pago en BD
    await pagosService.actualizarEstadoPago(
      pago.id,
      nuevoEstado,
      String(payment.id),
      status ?? null,
      payment.status_detail ?? null
    );

    console.log(`🎉 [10] PROCESO COMPLETADO. Pago ${paymentId} procesado. Estado final: ${nuevoEstado}`);

    // Siempre responder 200 para que MP no reenvíe la notificación
    res.status(200).send('OK');
  } catch (error: any) {
    console.error('💥 [ERROR CRÍTICO] En webhook:', error);
    res.status(200).send('OK'); // Siempre 200 aunque haya error interno, para frenar los reintentos de MP
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