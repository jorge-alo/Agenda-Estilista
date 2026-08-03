import { pool } from "../../config/db";

export const getConfiguracion = async (localId: number) => {
  const [rows]: any = await pool.query(
    `SELECT nombre, telefono, direccion, descripcion, horario_apertura, horario_cierre
     FROM locales WHERE id = ?`,
    [localId]
  );
  if (rows.length === 0) throw new Error("Local no encontrado");
  return rows[0];
};

export const updateConfiguracion = async (
  localId: number,
  data: {
    nombre?: string;
    telefono?: string;
    direccion?: string;
    descripcion?: string;
    horario_apertura?: string;
    horario_cierre?: string;
    requiere_sena?: boolean; // ✅ Agregado
  }
) => {
  const fields = [];
  const values = [];

  if (data.nombre !== undefined) { fields.push("nombre = ?"); values.push(data.nombre); }
  if (data.telefono !== undefined) { fields.push("telefono = ?"); values.push(data.telefono); }
  if (data.direccion !== undefined) { fields.push("direccion = ?"); values.push(data.direccion); }
  if (data.descripcion !== undefined) { fields.push("descripcion = ?"); values.push(data.descripcion); }
  if (data.horario_apertura !== undefined) { fields.push("horario_apertura = ?"); values.push(data.horario_apertura); }
  if (data.horario_cierre !== undefined) { fields.push("horario_cierre = ?"); values.push(data.horario_cierre); }
  
  // ✅ Agregado:
  if (data.requiere_sena !== undefined) { 
    fields.push("requiere_sena = ?"); 
    values.push(data.requiere_sena ? 1 : 0); // MySQL usa 1 para true, 0 para false
  }

  if (fields.length === 0) throw new Error("No hay campos para actualizar");
  values.push(localId);

  await pool.query(
    `UPDATE locales SET ${fields.join(", ")} WHERE id = ?`,
    values
  );

  return getConfiguracion(localId);
};