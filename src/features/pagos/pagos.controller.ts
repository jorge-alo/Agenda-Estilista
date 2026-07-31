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
  try {
    const { type, data } = req.body;

    // Mercado Pago envía diferentes tipos de notificaciones
    if (type === 'payment') {
      const paymentId = data.id;

      // Obtener información del pago desde MP
      const payment: any = await obtenerPaymentInfo(paymentId); // Usamos 'any' para flexibilidad con la respuesta de MP
      
      if (!payment) {
        return res.status(400).json({ error: 'Pago no encontrado en MP' });
      }

      // ✅ FIX 1: Validar que external_reference exista
      const externalReference = payment.external_reference;
      if (!externalReference || !externalReference.startsWith('turno-')) {
        console.warn('Webhook recibido sin external_reference válido:', payment);
        return res.status(400).json({ error: 'Referencia externa inválida' });
      }
      
      const turnoId = parseInt(externalReference.replace('turno-', ''), 10);

      // ✅ FIX 2: Acceder a preference_id de forma segura
      const preferenceId = payment.preference_id || '';
      
      // Buscar el pago en nuestra BD
      const pago = await pagosService.obtenerPagoPorPreferenceId(preferenceId);

      if (!pago) {
        console.error('Pago no encontrado en BD para preference_id:', preferenceId);
        return res.status(404).json({ error: 'Pago no encontrado en BD' });
      }

      // Actualizar estado según el status del pago
      const status = payment.status;
      let nuevoEstado: 'aprobado' | 'rechazado' | 'cancelado' = 'rechazado';

      if (status === 'approved') {
        nuevoEstado = 'aprobado';
        await pool.query(
          "UPDATE turnos SET estado = 'activo' WHERE id = ?",
          [turnoId]
        );
      } else if (status === 'cancelled' || status === 'rejected') {
        nuevoEstado = status === 'cancelled' ? 'cancelado' : 'rechazado';
        await pool.query(
          "UPDATE turnos SET estado = 'cancelado' WHERE id = ?",
          [turnoId]
        );
      }

      // ✅ FIX 3: Usar '?? null' para convertir undefined a null explícito
      await pagosService.actualizarEstadoPago(
        pago.id,
        nuevoEstado,
        String(payment.id),
        status ?? null,
        payment.status_detail ?? null
      );

      console.log(`✅ Pago ${paymentId} procesado. Estado: ${nuevoEstado}`);
    }

    // Siempre responder 200 para que MP no reenvíe la notificación
    res.status(200).send('OK');
  } catch (error: any) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: 'Error procesando webhook' });
  }
};

// Función helper para obtener info del pago desde MP
const obtenerPaymentInfo = async (paymentId: string) => {
  try {
    const payment = await paymentClient.get({ id: paymentId });
    return payment;
  } catch (error) {
    console.error('Error obteniendo payment info:', error);
    return null;
  }
};