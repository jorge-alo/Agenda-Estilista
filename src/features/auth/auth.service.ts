import bcrypt from "bcrypt";
import { pool } from "../../config/db";

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