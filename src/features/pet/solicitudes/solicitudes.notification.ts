import { formatPhoneAR } from "../../../helpers/formatPhoneAR";
import { sendWhatsApp } from "../../notifications/infrastructure/whatsapp.provider";
import type { SolicitudCreada } from "./solicitudes.service";

export function buildNuevaSolicitudMessage(solicitud: SolicitudCreada): string {
  const lines = [
    "Nueva solicitud de peluquería canina",
    "",
    `Responsable: ${solicitud.responsableNombre}`,
    `Mascota: ${solicitud.mascotaNombre}`,
    `Teléfono: ${formatPhoneAR(solicitud.responsableTelefono)}`,
  ];
  if (solicitud.mascotaRaza) lines.push(`Raza: ${solicitud.mascotaRaza}`);
  if (solicitud.motivoContacto) lines.push(`Motivo: ${solicitud.motivoContacto}`);
  return lines.join("\n");
}

export async function notificarNuevaSolicitud(solicitud: SolicitudCreada): Promise<void> {
  const telefonoLocal = solicitud.telefonoLocal?.trim();
  if (!telefonoLocal || !/\d/.test(telefonoLocal)) {
    console.warn("Notificación PET omitida: el local no tiene teléfono válido", { solicitudId: solicitud.solicitudId });
    return;
  }

  await sendWhatsApp(
    formatPhoneAR(telefonoLocal),
    buildNuevaSolicitudMessage(solicitud),
    String(solicitud.localId)
  );
}
