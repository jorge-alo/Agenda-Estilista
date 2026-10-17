import { fecha, SolicitudError } from "./solicitudes.types";

export interface SolicitudSnapshot {
  responsable_nombre: string;
  responsable_telefono: string;
  mascota_nombre: string;
  mascota_raza: string | null;
  mascota_fecha_nacimiento: string | null;
  mascota_tamano: string | null;
  mascota_sexo: string | null;
}

export interface FichaConversion {
  responsable: { nombre: string; telefono: string };
  mascota: {
    nombre: string;
    raza: string | null;
    fechaNacimiento: string | null;
    tamano: string | null;
    sexo: string | null;
    tipoPelo: string | null;
    observaciones: string | null;
  };
}

function objeto(value: unknown, permitidos: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !permitidos.includes(key))) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  return result;
}

function campo(value: unknown, max: number, requerido: boolean): string | null {
  if (value === null && !requerido) return null;
  if (typeof value !== "string") throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  const limpio = value.trim();
  if (!limpio || [...limpio].length > max) throw new SolicitudError(400, "PET_SOLICITUD_INVALID_BODY");
  return limpio;
}

function seleccionar(data: Record<string, unknown>, key: string, anterior: string | null, max: number, requerido = false): string | null {
  return campo(Object.prototype.hasOwnProperty.call(data, key) ? data[key] : anterior, max, requerido);
}

export function validarConversion(body: unknown, snapshot: SolicitudSnapshot): FichaConversion {
  const root = objeto(body, ["responsable", "mascota"]);
  const responsable = "responsable" in root ? objeto(root.responsable, ["nombre", "telefono"]) : {};
  const mascota = "mascota" in root ? objeto(root.mascota, ["nombre", "raza", "fechaNacimiento", "tamano", "sexo", "tipoPelo", "observaciones"]) : {};

  const rawFecha = Object.prototype.hasOwnProperty.call(mascota, "fechaNacimiento") ? mascota.fechaNacimiento : snapshot.mascota_fecha_nacimiento;
  return {
    responsable: {
      nombre: seleccionar(responsable, "nombre", snapshot.responsable_nombre, 255, true)!,
      telefono: seleccionar(responsable, "telefono", snapshot.responsable_telefono, 50, true)!,
    },
    mascota: {
      nombre: seleccionar(mascota, "nombre", snapshot.mascota_nombre, 255, true)!,
      raza: seleccionar(mascota, "raza", snapshot.mascota_raza, 100),
      fechaNacimiento: fecha(rawFecha),
      tamano: seleccionar(mascota, "tamano", snapshot.mascota_tamano, 20),
      sexo: seleccionar(mascota, "sexo", snapshot.mascota_sexo, 20),
      tipoPelo: seleccionar(mascota, "tipoPelo", null, 50),
      observaciones: seleccionar(mascota, "observaciones", null, 5000),
    },
  };
}
