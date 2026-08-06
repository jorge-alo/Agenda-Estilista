import { Request, Response } from 'express';
import { pool } from '../../config/db';
import { pagosService } from './pagos.service';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { sendTurnoConfirmado } from '../notifications/application/sendWhatsAppNotification';
import { formatPhoneAR } from '../../helpers/formatPhoneAR';

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
  console.log("📥 WEBHOOK RECIBIDO - BODY:", JSON.stringify(req.body, null, 2));

  try {
    const { type, data, topic, resource, action } = req.body;

    // 🛡️ NORMALIZACIÓN: MP envía el ID de formas distintas. Lo unificamos aquí.
    let paymentId: string | undefined;

    if (type === 'payment' && data?.id) {
      paymentId = data.id;
    } else if (topic === 'payment' && resource) {
      paymentId = resource;
    } else if (action === 'payment.created' && data?.id) {
      paymentId = data.id;
    }

    if (!paymentId) {
      console.log("ℹ️ Webhook ignorado (no es un evento de pago con ID válido).");
      return res.status(200).send('OK');
    }

    console.log("💳 [1] Procesando pago ID:", paymentId);

    const payment: any = await obtenerPaymentInfo(paymentId);

    if (!payment) {
      console.error("❌ [2] FALLO: No se pudo obtener la info del pago de MP.");
      return res.status(200).send('OK');
    }

    console.log("✅ [3] Info del pago obtenida. Status:", payment.status);

    const externalReference = payment.external_reference;
    
    // ✅ NUEVO: Detectar si es un pago de SUSCRIPCIÓN del local
    if (externalReference && externalReference.startsWith('suscripcion-')) {
      const localId = parseInt(externalReference.replace('suscripcion-', ''), 10);
      console.log("💼 [SUSCRIPCIÓN] Pago recibido para el local ID:", localId);

      if (payment.status === 'approved') {
        console.log("✅ [SUSCRIPCIÓN] Pago aprobado. Renovando suscripción por 30 días...");
        
        await pool.query(
          `UPDATE locales 
           SET suscripcion_estado = 'activo', 
               suscripcion_vencimiento = DATE_ADD(CURDATE(), INTERVAL 30 DAY) 
           WHERE id = ?`,
          [localId]
        );
        
        console.log("✅ [SUSCRIPCIÓN] Local renovado exitosamente por 30 días.");
      } else {
        console.log(`ℹ️ [SUSCRIPCIÓN] Pago no aprobado. Status: ${payment.status}`);
      }
      
      // Respondemos 200 y terminamos, no es un turno de cliente
      return res.status(200).send('OK');
    }

    // Si no empieza con 'turno-', ignoramos
    if (!externalReference || !externalReference.startsWith('turno-')) {
      console.warn("⚠️ [4] Webhook recibido sin external_reference válido:", externalReference);
      return res.status(200).send('OK');
    }

    const turnoId = parseInt(externalReference.replace('turno-', ''), 10);
    console.log("🎫 [5] Turno ID extraído:", turnoId);

    const preferenceId = payment.preference_id || '';
    console.log("🔗 [6] Preference ID:", preferenceId || "(Vacío, usando fallback)");

    let pago: any = null;

    if (preferenceId) {
      pago = await pagosService.obtenerPagoPorPreferenceId(preferenceId);
    }

    if (!pago) {
      console.log("⚠️ [7] Buscando pago por turno_id:", turnoId);
      pago = await pagosService.obtenerPagoPorTurnoId(turnoId);
    }

    if (!pago) {
      console.error("❌ [8] FALLO: Pago no encontrado en BD para turno_id:", turnoId);
      return res.status(200).send('OK');
    }

    console.log("✅ [9] Pago encontrado en BD. ID:", pago.id);

    const status = payment.status;
    let nuevoEstado: 'aprobado' | 'rechazado' | 'cancelado' = 'rechazado';

    if (status === 'approved') {
      nuevoEstado = 'aprobado';
      console.log("🟢 [10] Pago APROBADO. Actualizando turno a 'activo'...");
      await pool.query("UPDATE turnos SET estado = 'activo' WHERE id = ?", [turnoId]);

      // ✅ NUEVO: Enviar WhatsApp de confirmación AHORA que el pago fue aprobado
      try {
        console.log("📱 [11] Obteniendo datos del turno para enviar WhatsApp...");
        
        const [turnos]: any = await pool.query(
          `SELECT t.cliente_nombre, t.cliente_telefono, t.fecha, t.hora,
                  s.nombre AS servicioNombre, 
                  l.nombre AS localNombre, 
                  l.telefono AS localTelefono, 
                  l.id AS local_id
           FROM turnos t
           JOIN servicios s ON t.servicio_id = s.id
           JOIN locales l ON t.local_id = l.id
           WHERE t.id = ?`,
          [turnoId]
        );

        if (turnos.length > 0) {
          const t = turnos[0];
          console.log("📱 [12] Enviando WhatsApp de confirmación a:", t.cliente_telefono);
          
          await sendTurnoConfirmado({
            clienteNombre: t.cliente_nombre,
            clienteTelefono: formatPhoneAR(t.cliente_telefono),
            fecha: new Date(t.fecha + "T00:00:00").toLocaleDateString("es-AR"),
            hora: t.hora,
            servicio: t.servicioNombre,
            localNombre: t.localNombre,
            localTelefono: formatPhoneAR(t.localTelefono),
            localId: String(t.local_id)
          });
          
          console.log("✅ [13] WhatsApp de confirmación enviado exitosamente post-pago.");
        } else {
          console.warn("⚠️ [13] Turno no encontrado para enviar WhatsApp.");
        }
      } catch (whatsappErr) {
        console.error("❌ [13] Error enviando WhatsApp post-pago (no bloqueante):", whatsappErr);
      }

    } else if (status === 'cancelled' || status === 'rejected') {
      nuevoEstado = status === 'cancelled' ? 'cancelado' : 'rechazado';
      console.log("🔴 [10] Pago RECHAZADO/CANCELADO. Actualizando turno a 'cancelado'...");
      await pool.query("UPDATE turnos SET estado = 'cancelado' WHERE id = ?", [turnoId]);
    }

    await pagosService.actualizarEstadoPago(
      pago.id,
      nuevoEstado,
      String(payment.id),
      status ?? null,
      payment.status_detail ?? null
    );

    console.log(`🎉 [14] PROCESO COMPLETADO. Pago ${paymentId} procesado. Estado final: ${nuevoEstado}`);

    res.status(200).send('OK');
  } catch (error: any) {
    console.error('💥 [ERROR CRÍTICO] En webhook:', error);
    res.status(200).send('OK');
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