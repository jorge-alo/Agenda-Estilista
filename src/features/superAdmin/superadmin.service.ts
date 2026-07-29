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
// Eliminar local y todos sus datos asociados de forma segura
export const deleteLocal = async (id: number) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Verificar que el local existe
    const [locales]: any = await connection.query("SELECT id FROM locales WHERE id = ?", [id]);
    if (locales.length === 0) {
      throw new Error("Local no encontrado");
    }

    // 2. Limpiar tablas dependientes (en orden para evitar conflictos de FK)
    // Nota: Ajusta los nombres de las tablas si en tu BD se llaman diferente
    
    // Turnos (dependen de local_id y estilista_id)
    await connection.query("DELETE FROM turnos WHERE local_id = ?", [id]);
    
    // Bloqueos horarios
    await connection.query("DELETE FROM bloqueos_horarios WHERE local_id = ?", [id]);
    
    // Estilistas (esto también borrará sus relaciones en estilista_servicios y horarios si tienen ON DELETE CASCADE, 
    // si no, habría que borrarlas aquí también)
    await connection.query("DELETE FROM estilistas WHERE local_id = ?", [id]);
    
    // Servicios
    await connection.query("DELETE FROM servicios WHERE local_id = ?", [id]);
    
    // Clientes
    await connection.query("DELETE FROM clientes WHERE local_id = ?", [id]);
    
    // Configuración del local
    await connection.query("DELETE FROM configuracion WHERE local_id = ?", [id]);

    // 3. Borrar usuarios asociados a este local (admins y estilistas si los hubiera como usuarios)
    await connection.query("DELETE FROM usuarios WHERE local_id = ?", [id]);

    // 4. Finalmente, borrar el local
    await connection.query("DELETE FROM locales WHERE id = ?", [id]);

    await connection.commit();
    return { deleted: true };
  } catch (error: any) {
    await connection.rollback();
    console.error("❌ Error en transacción de deleteLocal:", error);
    throw error;
  } finally {
    connection.release();
  }
};