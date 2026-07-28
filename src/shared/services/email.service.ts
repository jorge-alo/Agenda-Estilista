import { Resend } from "resend";

// Inicializamos Resend con tu clave de Railway
const resend = new Resend(process.env.RESEND_API_KEY);

interface EnviarEmailResetProps {
  to: string;
  resetLink: string;
  nombreUsuario?: string;
}

export const emailService = {
  enviarEmailRecuperacion: async ({ to, resetLink, nombreUsuario }: EnviarEmailResetProps) => {
    const from = process.env.EMAIL_FROM || "Agenda Estilista <onboarding@resend.dev>";
    const saludo = nombreUsuario ? nombreUsuario.split(" ")[0] : "Hola";

    try {
      const { data, error } = await resend.emails.send({
        from,
        to,
        subject: "Recuperación de contraseña - Agenda Estilista",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background-color: #FAFAF7; border-radius: 12px;">
            <div style="background-color: #1C1C1C; padding: 20px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="margin: 0; color: #C9A96E; font-size: 24px; font-weight: 500;">Agenda Estilista</h1>
            </div>
            
            <div style="background-color: #FFFFFF; padding: 32px 24px; border: 1px solid #E8E3D8; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="color: #1A1A1A; font-size: 20px; margin-top: 0;">${saludo},</h2>
              
              <p style="color: #1A1A1A; font-size: 15px; line-height: 1.6;">
                Recibimos una solicitud para restablecer la contraseña de tu cuenta. 
                Haz clic en el botón de abajo para crear una nueva.
              </p>
              
              <p style="color: #1A1A1A; font-size: 15px; line-height: 1.6;">
                ⏳ Este enlace es válido por <strong>15 minutos</strong>.
              </p>

              <div style="text-align: center; margin: 32px 0;">
                <a href="${resetLink}" 
                   style="display: inline-block; background-color: #1C1C1C; color: #F5F0E8; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 14px; font-weight: 500; letter-spacing: 0.5px;">
                  Restablecer contraseña
                </a>
              </div>

              <p style="color: #888888; font-size: 13px; line-height: 1.6; text-align: center;">
                ¿No funciona el botón? Copia y pega este enlace en tu navegador:<br>
                <a href="${resetLink}" style="color: #C9A96E; text-decoration: none; word-break: break-all;">
                  ${resetLink}
                </a>
              </p>

              <hr style="border: none; border-top: 1px solid #E8E3D8; margin: 32px 0;">
              
              <p style="color: #888888; font-size: 12px; text-align: center; line-height: 1.5;">
                Si no solicitaste este cambio, puedes ignorar este email de forma segura.<br>
                Tu contraseña actual permanecerá sin cambios.
              </p>
            </div>
          </div>
        `,
      });

      if (error) {
        console.error("❌ ERROR RESEND:", error);
        return { success: false, error: error.message };
      }

      console.log("✅ EMAIL ENVIADO CON ÉXITO. ID:", data?.id);
      return { success: true };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO:", error.message);
      return { success: false, error: error.message };
    }
  },
};