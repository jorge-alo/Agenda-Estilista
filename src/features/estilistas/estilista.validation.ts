import type { PoolConnection, RowDataPacket } from "mysql2/promise";

export class EstilistaNoEncontradoError extends Error {
  constructor() { super("Estilista no encontrado"); }
}

/** Run inside the writer transaction; retain ownership until commit/rollback. */
export async function validarEstilistaDelLocal(connection: PoolConnection, id: number, localId: number): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT id FROM estilistas WHERE id = ? AND local_id = ? FOR SHARE", [id, localId],
  );
  if (!rows.length) throw new EstilistaNoEncontradoError();
}
