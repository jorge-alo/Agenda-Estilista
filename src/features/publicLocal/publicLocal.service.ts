import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../config/db";
import { isBusinessType, type BusinessType } from "../../shared/types/businessType";

interface PublicLocalRow extends RowDataPacket {
  nombre: string;
  business_type: unknown;
}

export class PublicLocalError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export interface PublicLocalContext {
  nombre: string;
  businessType: BusinessType;
}

export async function obtenerContextoPublico(slug: string): Promise<PublicLocalContext> {
  const [rows] = await pool.query<PublicLocalRow[]>(
    "SELECT nombre, business_type FROM locales WHERE slug = ? AND activo = 1",
    [slug],
  );
  if (!rows.length) throw new PublicLocalError(404, "LOCAL_NOT_FOUND");

  const businessType = rows[0].business_type;
  if (!isBusinessType(businessType)) {
    throw new PublicLocalError(500, "LOCAL_BUSINESS_TYPE_INVALID");
  }

  return { nombre: rows[0].nombre, businessType };
}
