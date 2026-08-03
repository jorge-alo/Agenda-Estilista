import { MercadoPagoConfig, Preference } from "mercadopago";
import { pool } from "../../config/db";

interface CrearPagoData {
  turnoId: number;
  localId: number;
  servicioNombre: string;
  monto: number;
  tipo: "seña" | "completo";
  porcentajeSeña?: number;
  accessToken?: string; // ✅ Token del local (opcional)
  slug: string;
}

export const pagosService = {
  crearPreference: async (data: CrearPagoData) => {
    const {
      turnoId,
      localId,
      servicioNombre,
      monto,
      tipo,
      porcentajeSeña = 30,
      accessToken,
      slug,
    } = data;

    // ✅ Usar el token del local si existe, sino el global (fallback para testing)
    const tokenFinal = accessToken || process.env.MP_ACCESS_TOKEN;

    if (!tokenFinal) {
      throw new Error("No hay token de Mercado Pago configurado para este local");
    }

    // ✅ Crear el cliente con el token del local específico
    const client = new MercadoPagoConfig({ accessToken: tokenFinal });
    const preferenceClient = new Preference(client);

    const montoACobrar = tipo === "seña" ? (monto * porcentajeSeña) / 100 : monto;

    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: `turno-${turnoId}`,
            title: tipo === "seña" ? `Seña - ${servicioNombre}` : servicioNombre,
            description:
              tipo === "seña"
                ? `Seña del ${porcentajeSeña}% para confirmar tu turno`
                : "Pago completo del turno",
            quantity: 1,
            unit_price: montoACobrar,
            currency_id: "ARS",
          },
        ],
        back_urls: {
          success: `${process.env.FRONTEND_URL}/pago-exitoso?turno=${turnoId}&slug=${slug}`,
          failure: `${process.env.FRONTEND_URL}/pago-fallido?turno=${turnoId}&slug=${slug}`,
          pending: `${process.env.FRONTEND_URL}/pago-pendiente?turno=${turnoId}&slug=${slug}`,
        },
        auto_return: "approved",
        external_reference: `turno-${turnoId}`,
        notification_url: `${process.env.BACKEND_URL}/api/pagos/webhook`,
        metadata: {
          turno_id: turnoId,
          local_id: localId,
          tipo: tipo,
        },
      },
    });

    const [result]: any = await pool.query(
      `INSERT INTO pagos (turno_id, local_id, preference_id, monto, tipo, estado) 
       VALUES (?, ?, ?, ?, ?, 'pendiente')`,
      [turnoId, localId, preference.id, montoACobrar, tipo]
    );

    const pagoId = result.insertId;

    await pool.query("UPDATE turnos SET pago_id = ? WHERE id = ?", [pagoId, turnoId]);

    return {
      pagoId,
      initPoint: preference.init_point!,
      sandboxInitPoint: preference.sandbox_init_point,
    };
  },

  obtenerPagoPorPreferenceId: async (preferenceId: string) => {
    const [rows]: any = await pool.query(
      "SELECT * FROM pagos WHERE preference_id = ?",
      [preferenceId]
    );
    return rows[0];
  },

    obtenerPagoPorTurnoId: async (turnoId: number) => {
    const [rows]: any = await pool.query(
      "SELECT * FROM pagos WHERE turno_id = ? ORDER BY id DESC LIMIT 1",
      [turnoId]
    );
    return rows[0];
  },

  actualizarEstadoPago: async (
    pagoId: number,
    estado: "aprobado" | "rechazado" | "cancelado",
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