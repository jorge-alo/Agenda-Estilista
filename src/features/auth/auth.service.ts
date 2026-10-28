import bcrypt from "bcrypt";
import { pool } from "../../config/db";
import crypto from "crypto";
import { emailService } from "../../shared/services/email.service";
import { isBusinessType, type BusinessType } from "../../shared/types/businessType";
import type { RowDataPacket } from "mysql2/promise";

interface LocalBusinessTypeRow extends RowDataPacket {
  business_type: unknown;
}

export class AuthMeError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export const getBusinessTypeForLocal = async (localId: number): Promise<BusinessType> => {
  const [rows] = await pool.query<LocalBusinessTypeRow[]>(
    "SELECT business_type FROM locales WHERE id = ?",
    [localId],
  );
  if (!rows.length) throw new AuthMeError(404, "LOCAL_NOT_FOUND", "Local no encontrado");
  if (!isBusinessType(rows[0].business_type)) {
    throw new AuthMeError(500, "LOCAL_BUSINESS_TYPE_INVALID", "Tipo de negocio inválido en el local");
  }
  return rows[0].business_type;
};

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

function frontendBaseForReset(): string {
  try {
    const url = new URL(process.env.FRONTEND_URL ?? "");
    const allowHttp = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
    if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("FRONTEND_URL inválida para recuperación de contraseña");
  }
}

export const requestPasswordReset = async (email: string) => {
  const frontendUrl = frontendBaseForReset();
  // Buscamos el usuario. Usamos 'blind response' (respuesta ciega) por seguridad.
  const [rows]: any = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
  
  if (rows.length === 0) {
    // Retornamos éxito igual para no revelar si el email existe o no en la BD
    return { success: true }; 
  }

  const userId = rows[0].id;
  const nombreUsuario = rows[0].nombre;
  // Generamos un token criptográfico seguro de 64 caracteres
  const resetToken = crypto.randomBytes(32).toString("hex");
  // Expira en 15 minutos
  const expires = new Date(Date.now() + 15 * 60 * 1000); 

  await pool.query(
    "UPDATE usuarios SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
    [resetToken, expires, userId]
  );

  const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

  await emailService.enviarEmailRecuperacion({
    to: email,
    resetLink,
    nombreUsuario,
  });

  // El enlace de recuperación solo se entrega por el canal de email; nunca se registra.
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
