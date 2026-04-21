
import bcrypt from "bcrypt";
import { pool } from "../../config/db";


export const registerUser = async (
  email: string,
  password: string,
  nombreLocal: string,
  telefono: string
) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 🔍 verificar email
    const [rows]: any = await connection.query(
      "SELECT id FROM usuarios WHERE email = ?",
      [email]
    );

    if (rows.length > 0) {
      throw new Error("El email ya está registrado");
    }

    const slug = nombreLocal
      .toLowerCase()
      .replace(/\s+/g, "-");

    // 🏪 crear local
    const [localResult]: any = await connection.query(
      "INSERT INTO locales (nombre, slug, telefono) VALUES (?, ?, ?)",
      [nombreLocal, slug, telefono]
    );

    const localId = localResult.insertId;
    console.log("Valor de localId", localId);
    // 🔐 hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 👤 crear usuario
    const [userResult]: any = await connection.query(
      "INSERT INTO usuarios (email, password, rol, local_id) VALUES (?, ?, ?, ?)",
      [email, hashedPassword, "admin", localId]
    );

    await connection.commit();

    return userResult.insertId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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