// src/features/cron/recordatorios.cron.ts
import cron from "node-cron";
import { pool } from "../../config/db";
import { sendWhatsApp } from "../notifications/infrastructure/whatsapp.provider";
import { buildTurnoRecordatorioMessage } from "../notifications/application/notification.service";
import { formatPhoneAR } from "../../helpers/formatPhoneAR";

export const iniciarCronRecordatorios = () => {
  // Se ejecuta todos los días a las 10:00 AM hora Argentina
  cron.schedule(
    "0 10 * * *",
    async () => {
      console.log("⏰ Ejecutando cron de recordatorios...");

      // Calcular fecha de mañana
      const manana = new Date();
      manana.setDate(manana.getDate() + 1);
      const fechaManana = manana.toISOString().split("T")[0];

      try {
        const [turnos]: any = await pool.query(
          `SELECT 
            t.id,
            t.cliente_nombre,
            t.cliente_telefono,
            t.fecha,
            t.hora,
            t.local_id,
            s.nombre AS servicio_nombre,
            l.nombre AS local_nombre,
            l.telefono AS local_telefono
          FROM turnos t
          JOIN servicios s ON t.servicio_id = s.id
          JOIN locales l ON t.local_id = l.id
          WHERE t.fecha = ?
          AND t.estado = 'activo'
          AND t.cliente_telefono IS NOT NULL`,
          [fechaManana]
        );

        console.log(`📋 Turnos para mañana: ${turnos.length}`);

        for (const turno of turnos) {
          try {
            const message = buildTurnoRecordatorioMessage({
              clienteNombre: turno.cliente_nombre,
              clienteTelefono: turno.cliente_telefono,
              fecha: new Date(turno.fecha).toLocaleDateString("es-AR"),
              hora: turno.hora,
              servicio: turno.servicio_nombre,
              localNombre: turno.local_nombre,
              localTelefono: turno.local_telefono,
              localId: String(turno.local_id),
            });

            const telefonoCliente = formatPhoneAR(turno.cliente_telefono);

            await sendWhatsApp(
              telefonoCliente,
              message,
              String(turno.local_id)
            );

            // Pausa de 1 segundo entre mensajes para no saturar
            await new Promise((r) => setTimeout(r, 1000));
          } catch (err) {
            // Si falla un mensaje no rompemos el loop
            console.error(
              `❌ Error enviando recordatorio al turno ${turno.id}:`,
              err
            );
          }
        }

        console.log("✅ Cron de recordatorios finalizado");
      } catch (err) {
        console.error("❌ Error en cron de recordatorios:", err);
      }
    },
    { timezone: "America/Argentina/Buenos_Aires" }
  );
};