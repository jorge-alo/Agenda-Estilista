import { MercadoPagoConfig, Preference } from 'mercadopago';
import { pool } from '../../config/db';

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN!,
});

const preferenceClient = new Preference(client);

interface CrearPagoData {
  turnoId: number;
  localId: number;
  servicioNombre: string;
  monto: number;
  tipo: 'seña' | 'completo';
  porcentajeSeña?: number; // Si es seña, qué porcentaje (ej: 30)
}

export const pagosService = {
  crearPreference: async (data: CrearPagoData) => {
    const { turnoId, localId, servicioNombre, monto, tipo, porcentajeSeña = 30 } = data;

    // Calcular monto a cobrar
    const montoACobrar = tipo === 'seña' ? (monto * porcentajeSeña) / 100 : monto;

    // Crear preferencia de pago en Mercado Pago
    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: `turno-${turnoId}`,
            title: `Seña - ${servicioNombre}`,
            description: tipo === 'seña' 
              ? `Seña del ${porcentajeSeña}% para confirmar tu turno`
              : 'Pago completo del turno',
            quantity: 1,
            unit_price: montoACobrar,
            currency_id: 'ARS',
          },
        ],
        back_urls: {
          success: `${process.env.FRONTEND_URL}/pago-exitoso?turno=${turnoId}`,
          failure: `${process.env.FRONTEND_URL}/pago-fallido?turno=${turnoId}`,
          pending: `${process.env.FRONTEND_URL}/pago-pendiente?turno=${turnoId}`,
        },
        auto_return: 'approved',
        external_reference: `turno-${turnoId}`,
        notification_url: `${process.env.BACKEND_URL}/api/pagos/webhook`,
        metadata: {
          turno_id: turnoId,
          local_id: localId,
          tipo: tipo,
        },
      },
    });

    // Guardar en base de datos
    const [result]: any = await pool.query(
      `INSERT INTO pagos (turno_id, local_id, preference_id, monto, tipo, estado) 
       VALUES (?, ?, ?, ?, ?, 'pendiente')`,
      [turnoId, localId, preference.id, montoACobrar, tipo]
    );

    const pagoId = result.insertId;

    // Actualizar turno con el pago_id
    await pool.query(
      'UPDATE turnos SET pago_id = ? WHERE id = ?',
      [pagoId, turnoId]
    );

    return {
      pagoId,
      initPoint: preference.init_point!, // Link para enviar al cliente
      sandboxInitPoint: preference.sandbox_init_point, // Para testing
    };
  },

  obtenerPagoPorPreferenceId: async (preferenceId: string) => {
    const [rows]: any = await pool.query(
      'SELECT * FROM pagos WHERE preference_id = ?',
      [preferenceId]
    );
    return rows[0];
  },

  actualizarEstadoPago: async (
    pagoId: number,
    estado: 'aprobado' | 'rechazado' | 'cancelado',
    mpPaymentId: string | null,
    mpStatus: string | null,
    mpStatusDetail: string | null
  ) => {
    await pool.query(
      `UPDATE pagos 
       SET estado = ?, mp_payment_id = ?, mp_status = ?, mp_status_detail = ?
       WHERE id = ?`,
      [estado, mpPaymentId, mpStatus, mpStatusDetail, pagoId]
    );
  },
};