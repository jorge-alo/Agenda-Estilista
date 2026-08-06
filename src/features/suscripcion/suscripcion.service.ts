import { pool } from "../../config/db";
import { MercadoPagoConfig, Preference } from "mercadopago";

// Usamos el token GLOBAL de la plataforma (TU cuenta), no la del local
const mpClient = new MercadoPagoConfig({ 
  accessToken: process.env.MP_ACCESS_TOKEN! 
});
const preferenceClient = new Preference(mpClient);

export const suscripcionService = {
  
  // Obtener el estado actual de la suscripción del local
  obtenerEstado: async (localId: number) => {
    const [locales]: any = await pool.query(
      `SELECT suscripcion_estado, suscripcion_vencimiento, suscripcion_plan 
       FROM locales WHERE id = ?`, 
      [localId]
    );
    
    // Si no tiene datos, devolvemos un estado por defecto
    return locales[0] || { 
      suscripcion_estado: 'pendiente_pago',
      suscripcion_vencimiento: null,
      suscripcion_plan: 'basico'
    };
  },

  // Generar el link de pago de Mercado Pago
  generarPreference: async (localId: number) => {
    // 1. Obtener nombre del local para el concepto del pago
    const [locales]: any = await pool.query(
      "SELECT nombre FROM locales WHERE id = ?", 
      [localId]
    );
    
    if (locales.length === 0) {
      throw new Error("Local no encontrado");
    }

    const localNombre = locales[0].nombre || "Servicio de Agenda";
    const MONTO_SUSCRIPCION = 10000; // ⚠️ Cambia esto por el precio real de tu suscripción

    // 2. Crear preferencia de pago
    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: `suscripcion-${localId}`,
            title: `Suscripción Mensual - ${localNombre}`,
            description: "Pago mensual por el uso de la plataforma de gestión de agenda",
            quantity: 1,
            unit_price: MONTO_SUSCRIPCION,
            currency_id: "ARS",
          },
        ],
        external_reference: `suscripcion-${localId}`, // ✅ CLAVE: Esto lo usará el webhook
        back_urls: {
          success: `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=exitoso`,
          failure: `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=fallo`,
          pending: `${process.env.FRONTEND_URL}/admin?tab=configuracion&pago=pendiente`,
        },
        auto_return: "approved",
      },
    });

    return {
      link: preference.init_point,
    };
  }
};