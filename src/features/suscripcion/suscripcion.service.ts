
import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { MercadoPagoConfig, Preference } from "mercadopago";

// Token global de la plataforma.
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN!,
});

const preferenceClient = new Preference(mpClient);

export const suscripcionService = {
  // Obtener el estado actual de la suscripción.
  obtenerEstado: async (localId: number) => {
    const [locales]: any = await pool.query(
      `SELECT
         suscripcion_estado,
         suscripcion_vencimiento,
         suscripcion_plan
       FROM locales
       WHERE id = ?`,
      [localId]
    );

    return locales[0] || {
      suscripcion_estado: "pendiente_pago",
      suscripcion_vencimiento: null,
      suscripcion_plan: "basico",
    };
  },

  // Crear un intento de pago y generar su preferencia.
  generarPreference: async (localId: number) => {
    // 1. Verificar que el local exista.
    const [locales]: any = await pool.query(
      "SELECT nombre FROM locales WHERE id = ?",
      [localId]
    );

    if (locales.length === 0) {
      throw new Error("Local no encontrado");
    }

    const localNombre = locales[0].nombre || "Servicio de Agenda";
    const MONTO_SUSCRIPCION = 100;

    // 2. Crear una referencia única para este intento.
    const externalReference =
      `suscripcion-${localId}-${randomUUID()}`;

    // 3. Registrar el intento antes de llamar a Mercado Pago.
    const [resultado]: any = await pool.query(
      `INSERT INTO pagos_suscripcion
         (local_id, external_reference, monto, estado)
       VALUES (?, ?, ?, 'pendiente')`,
      [localId, externalReference, MONTO_SUSCRIPCION]
    );

    const pagoSuscripcionId = resultado.insertId;

    // 4. Crear la preferencia de Mercado Pago.
    // Si esta operación falla, el registro local queda pendiente
    // para poder investigarlo; no significa que haya sido cobrado.
    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: `suscripcion-${localId}`,
            title: `Suscripción Mensual - ${localNombre}`,
            description:
              "Pago mensual por el uso de la plataforma de gestión de agenda",
            quantity: 1,
            unit_price: MONTO_SUSCRIPCION,
            currency_id: "ARS",
          },
        ],
        external_reference: externalReference,
        metadata: {
          local_id: localId,
          pago_suscripcion_id: pagoSuscripcionId,
        },
        back_urls: {
          success:
            `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=exitoso`,
          failure:
            `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=fallo`,
          pending:
            `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=pendiente`,
        },
        auto_return: "approved",
      },
    });

    if (!preference.id || !preference.init_point) {
      throw new Error(
        "Mercado Pago no devolvió el ID y el enlace de la preferencia"
      );
    }

    // 5. Vincular la preferencia con el registro creado.
    await pool.query(
      `UPDATE pagos_suscripcion
       SET preference_id = ?
       WHERE id = ? AND local_id = ?`,
      [preference.id, pagoSuscripcionId, localId]
    );

    return {
      link: preference.init_point,
    };
  },
};