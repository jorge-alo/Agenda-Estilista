import bcrypt from "bcrypt";
import { pool } from "../../config/db";
import crypto from "crypto";

export const loginUser = async (email: string, password: string) => {
  const [rows]: any = await pool.query(
    "SELECT * FROM usuarios WHERE email = ?",
    [email]
  );

  const user = rows[0];
  if (!user) throw new Error("Usuario no encontrado");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Contraseña incorrecta");

  if (user.activo === 0) {
    throw new Error("Usuario bloqueado");
  }

  // Si es superadmin no tiene local
  if (user.rol === 'superadmin') {
    return { user, nombreLocal: null, telefono: null };
  }

  const [rowsLocal]: any = await pool.query(
    "SELECT nombre, telefono FROM locales WHERE id = ?",
    [user.local_id]
  );
  console.log("Valor de rowsLocal", rowsLocal[0].nombre)
  const nombreLocal = rowsLocal[0].nombre
  const telefono = rowsLocal[0]?.telefono;
  return { user, nombreLocal, telefono };
};

export const requestPasswordReset = async (email: string) => {
  // Buscamos el usuario. Usamos 'blind response' (respuesta ciega) por seguridad.
  const [rows]: any = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
  
  if (rows.length === 0) {
    // Retornamos éxito igual para no revelar si el email existe o no en la BD
    return { success: true }; 
  }

  const userId = rows[0].id;
  // Generamos un token criptográfico seguro de 64 caracteres
  const resetToken = crypto.randomBytes(32).toString("hex");
  // Expira en 15 minutos
  const expires = new Date(Date.now() + 15 * 60 * 1000); 

  await pool.query(
    "UPDATE usuarios SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
    [resetToken, expires, userId]
  );

  // 📧 En producción, aquí iría el envío de email (Nodemailer, Resend, etc.)
  // Para desarrollo, lo mostramos en consola para que puedas copiar el link y probar:
  const frontendUrl = process.env.FRONTEND_URL;
  console.log(`\n🔗 [DEV] Link de recuperación para ${email}:`);
  console.log(`${frontendUrl}/reset-password?token=${resetToken}\n`);

  return { success: true };
};

// ✅ NUEVO: Restablecer contraseña con el token
export const resetPassword = async (token: string, newPassword: string) => {
  // Buscamos un usuario con ese token Y que no haya expirado
  const [rows]: any = await pool.query(
    "SELECT id FROM usuarios WHERE reset_token = ? AND reset_token_expires > NOW()",
    [token]
  );

  if (rows.length === 0) {
    throw new Error("Token inválido o expirado");
  }

  const userId = rows[0].id;
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  // Actualizamos la contraseña y LIMPIAMOS el token para que sea de un solo uso
  await pool.query(
    "UPDATE usuarios SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?",
    [hashedPassword, userId]
  );

  return { success: true };
};