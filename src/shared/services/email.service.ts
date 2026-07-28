import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  connectionTimeout: 5000, // ⚠️ AGREGADO: Se rinde en 5 segundos
  socketTimeout: 5000,     // ⚠️ AGREGADO: Se rinde en 5 segundos
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS?.replace(/\s/g, ""),
  },
});

interface EnviarEmailResetProps {
  to: string;
  resetLink: string;
  nombreUsuario?: string;
}

export const emailService = {
  enviarEmailRecuperacion: async ({ to, resetLink, nombreUsuario }: EnviarEmailResetProps) => {
    const from = process.env.EMAIL_FROM || `Agenda Estilista <${process.env.SMTP_USER}>`;
    const saludo = nombreUsuario ? nombreUsuario.split(" ")[0] : "Hola";

    console.log("📧 Intentando enviar email a:", to);
    console.log("📧 Usando FROM:", from);

    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject: "Recuperación de contraseña - Agenda Estilista",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1C1C1C;">${saludo},</h2>
            <p style="color: #1A1A1A; font-size: 15px; line-height: 1.6;">
              Recibimos una solicitud para restablecer tu contraseña. 
              Haz clic en el botón de abajo para crear una nueva.
            </p>
            <p style="color: #1A1A1A; font-size: 15px; line-height: 1.6;">
              ⏳ Este enlace es válido por <strong>15 minutos</strong>.
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${resetLink}" 
                 style="display: inline-block; background-color: #1C1C1C; color: #F5F0E8; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 14px; font-weight: 500;">
                Restablecer contraseña
              </a>
            </div>
            <p style="color: #888888; font-size: 13px; text-align: center;">
              Si no solicitaste este cambio, puedes ignorar este email.
            </p>
          </div>
        `,
      });

      console.log("✅ Email enviado exitosamente. Message ID:", info.messageId);
      return { success: true };
    } catch (error: any) {
      console.error("❌ ERROR CRÍTICO DE GMAIL:", error.message);
      console.error("❌ DETALLE DEL ERROR:", error);
      return { success: false, error: error.message };
    }
  },
};