import { pool } from "../../config/db";
import bcrypt from "bcrypt";

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

// Listar todos los locales con info del admin
export const getAllLocales = async () => {
  const [rows]: any = await pool.query(`
    SELECT 
      l.id,
      l.nombre,
      l.slug,
      l.telefono,
      l.activo,
      l.created_at,
      u.id AS usuario_id,
      u.email,
      u.activo AS usuario_activo
    FROM locales l
    LEFT JOIN usuarios u ON u.local_id = l.id AND u.rol = 'admin'
    ORDER BY l.created_at DESC
  `);
  return rows;
};

// Detalle de un local
export const getLocalById = async (id: number) => {
  const [rows]: any = await pool.query(`
    SELECT 
      l.id,
      l.nombre,
      l.slug,
      l.telefono,
      l.activo,
      l.created_at,
      u.id AS usuario_id,
      u.email,
      u.activo AS usuario_activo
    FROM locales l
    LEFT JOIN usuarios u ON u.local_id = l.id AND u.rol = 'admin'
    WHERE l.id = ?
  `, [id]);

  if (rows.length === 0) throw new Error("Local no encontrado");
  return rows[0];
};

// Activar o bloquear local + su admin
export const toggleLocalActivo = async (id: number) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Agarramos el estado actual
    const [rows]: any = await connection.query(
      "SELECT activo FROM locales WHERE id = ?",
      [id]
    );
    if (rows.length === 0) throw new Error("Local no encontrado");

    const nuevoEstado = rows[0].activo === 1 ? 0 : 1;

    // Actualizamos local y usuario en la misma transacción
    await connection.query(
      "UPDATE locales SET activo = ? WHERE id = ?",
      [nuevoEstado, id]
    );
    await connection.query(
      "UPDATE usuarios SET activo = ? WHERE local_id = ? AND rol = 'admin'",
      [nuevoEstado, id]
    );

    await connection.commit();
    return { id, activo: nuevoEstado };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Eliminar local y su admin (soft delete o hard delete)
export const deleteLocal = async (id: number) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Primero usuarios (FK constraint)
    await connection.query(
      "DELETE FROM usuarios WHERE local_id = ?",
      [id]
    );
    await connection.query(
      "DELETE FROM locales WHERE id = ?",
      [id]
    );

    await connection.commit();
    return { deleted: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};