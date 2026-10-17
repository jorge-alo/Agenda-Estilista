export const estadosSolicitud = ["NUEVA", "CONTACTADA", "CONVERTIDA", "DESCARTADA"] as const;
export type EstadoSolicitud = typeof estadosSolicitud[number];

export class SolicitudError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export interface CrearSolicitud {
  responsableNombre: string;
  responsableTelefono: string;
  responsableTelefonoSecundario: string | null;
  mascotaNombre: string;
  mascotaRaza: string | null;
  mascotaFechaNacimiento: string | null;
  mascotaTamano: string | null;
  mascotaSexo: string | null;
  motivoContacto: string | null;
}

function objeto(value: unknown, permitidos: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !permitidos.includes(key))) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  return result;
}

function texto(value: unknown, max: number, obligatorio = false): string | null {
  if (!obligatorio && (value === undefined || value === null)) return null;
  if (typeof value !== "string") throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  const limpio = value.trim();
  if (!limpio || [...limpio].length > max) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  return limpio;
}

function fecha(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  return value;
}

export function validarCrear(body: unknown): CrearSolicitud {
  const root = objeto(body, ["responsable", "mascota", "motivoContacto"]);
  const responsable = objeto(root.responsable, ["nombre", "telefono", "telefonoSecundario"]);
  const mascota = objeto(root.mascota, ["nombre", "raza", "fechaNacimiento", "tamano", "sexo"]);
  return {
    responsableNombre: texto(responsable.nombre, 255, true)!,
    responsableTelefono: texto(responsable.telefono, 50, true)!,
    responsableTelefonoSecundario: texto(responsable.telefonoSecundario, 50),
    mascotaNombre: texto(mascota.nombre, 255, true)!,
    mascotaRaza: texto(mascota.raza, 100),
    mascotaFechaNacimiento: fecha(mascota.fechaNacimiento),
    mascotaTamano: texto(mascota.tamano, 20),
    mascotaSexo: texto(mascota.sexo, 20),
    motivoContacto: texto(root.motivoContacto, 500),
  };
}

export function validarFiltro(query: Record<string, unknown>): EstadoSolicitud | null {
  const params = Object.keys(query);
  if (params.some(key => key !== "estado") || Array.isArray(query.estado)) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_FILTER");
  if (params.length === 0) return null;
  if (!estadosSolicitud.includes(query.estado as EstadoSolicitud)) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_FILTER");
  return query.estado as EstadoSolicitud;
}

export function validarCambio(body: unknown): EstadoSolicitud {
  const data = objeto(body, ["estado"]);
  if (Object.keys(data).length !== 1 || !estadosSolicitud.includes(data.estado as EstadoSolicitud)) {
    throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  }
  return data.estado as EstadoSolicitud;
}

export function validarId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw new SolicitudError(400, "PET_SOLICITUD_INVALID_ID");
  }
  return Number(value);
}
