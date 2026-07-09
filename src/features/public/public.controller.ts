import { Request, Response } from "express";
import * as turnoService from "../public/public.service";
import { sendTurnoConfirmado } from "../notifications/application/sendWhatsAppNotification";
import { formatPhoneAR } from "../../helpers/formatPhoneAR";

export const reservar = async (req: Request, res: Response) => {
  try {
    const {
      slug,
      fecha,
      hora,
      estilista_id,
      servicio_id,
      cliente_nombre,
      cliente_telefono,
    } = req.body;

    const turno = await turnoService.createTurnoPublico({
      slug,
      fecha,
      hora,
      estilista_id,
      servicio_id,
      cliente_nombre,
      cliente_telefono,
    });


    const telefonoFormateado = formatPhoneAR(cliente_telefono);
    const telefonoLocalFormateado = formatPhoneAR(turno.telefono);

    sendTurnoConfirmado({
      clienteNombre: cliente_nombre,
      clienteTelefono: telefonoFormateado,
      fecha: new Date(fecha + "T00:00:00").toLocaleDateString("es-AR"),
      hora,
      servicio: turno.servicioNombre,
      localNombre: turno.localNombre,
      localTelefono: telefonoLocalFormateado,
      localId: String(turno.localId)
    }).catch((err) => {
      console.error("Error enviando WhatsApp (no bloqueante):", err);
    });

    res.json({ message: "Turno reservado", telefono: telefonoLocalFormateado });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};