export interface CrearMascotaPayload {
  nombre: string;
  raza?: string | null;
  fecha_nacimiento?: string | null;
  sexo?: string | null;
  tamano?: string | null;
  tipo_pelo?: string | null;
  observaciones?: string | null;
}

export interface EditarMascotaPayload {
  nombre?: string;
  raza?: string | null;
  fecha_nacimiento?: string | null;
  sexo?: string | null;
  tamano?: string | null;
  tipo_pelo?: string | null;
  observaciones?: string | null;
  activo?: boolean;
  altaExigencia?: boolean;
}

export interface AsociarResponsablePayload {
  clienteId: number;
}

export interface CrearResponsablePayload {
  nombre: string;
  telefono: string;
}

export function validarCrearMascota(payload: unknown): { ok: boolean; errores: string[]; data?: CrearMascotaPayload } {
  const errores: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errores: ["Payload inválido"] };
  }

  const p = payload as Record<string, unknown>;

  const nombre = p.nombre;
  if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
    errores.push("nombre es obligatorio y no puede estar vacío");
  } else if (nombre.length > 255) {
    errores.push("nombre no puede exceder 255 caracteres");
  }

  const raza = p.raza;
  if (raza !== undefined && raza !== null && (typeof raza !== "string" || raza.length > 100)) {
    errores.push("raza no puede exceder 100 caracteres");
  }

  const fecha_nacimiento = p.fecha_nacimiento;
  if (fecha_nacimiento !== undefined && fecha_nacimiento !== null) {
    if (typeof fecha_nacimiento !== "string" || isNaN(Date.parse(fecha_nacimiento))) {
      errores.push("fecha_nacimiento debe ser una fecha válida (YYYY-MM-DD)");
    }
  }

  const sexo = p.sexo;
  if (sexo !== undefined && sexo !== null && (typeof sexo !== "string" || sexo.length > 20)) {
    errores.push("sexo no puede exceder 20 caracteres");
  }

  const tamano = p.tamano;
  if (tamano !== undefined && tamano !== null && (typeof tamano !== "string" || tamano.length > 20)) {
    errores.push("tamano no puede exceder 20 caracteres");
  }

  const tipo_pelo = p.tipo_pelo;
  if (tipo_pelo !== undefined && tipo_pelo !== null && (typeof tipo_pelo !== "string" || tipo_pelo.length > 50)) {
    errores.push("tipo_pelo no puede exceder 50 caracteres");
  }

  const observaciones = p.observaciones;
  if (observaciones !== undefined && observaciones !== null && typeof observaciones !== "string") {
    errores.push("observaciones debe ser texto");
  }

  if (errores.length > 0) {
    return { ok: false, errores };
  }

  return {
    ok: true,
    errores: [],
    data: {
      nombre: (nombre as string).trim(),
      raza: (raza as string)?.trim() || null,
      fecha_nacimiento: fecha_nacimiento as string | null,
      sexo: (sexo as string)?.trim() || null,
      tamano: (tamano as string)?.trim() || null,
      tipo_pelo: (tipo_pelo as string)?.trim() || null,
      observaciones: (observaciones as string)?.trim() || null,
    },
  };
}

export function validarEditarMascota(payload: unknown): { ok: boolean; errores: string[]; data?: EditarMascotaPayload } {
  const errores: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errores: ["Payload inválido"] };
  }

  const p = payload as Record<string, unknown>;

  const nombre = p.nombre;
  if (nombre !== undefined) {
    if (typeof nombre !== "string" || nombre.trim() === "") {
      errores.push("nombre no puede estar vacío");
    } else if (nombre.length > 255) {
      errores.push("nombre no puede exceder 255 caracteres");
    }
  }

  const raza = p.raza;
  if (raza !== undefined && raza !== null && (typeof raza !== "string" || raza.length > 100)) {
    errores.push("raza no puede exceder 100 caracteres");
  }

  const fecha_nacimiento = p.fecha_nacimiento;
  if (fecha_nacimiento !== undefined && fecha_nacimiento !== null) {
    if (typeof fecha_nacimiento !== "string" || isNaN(Date.parse(fecha_nacimiento))) {
      errores.push("fecha_nacimiento debe ser una fecha válida (YYYY-MM-DD)");
    }
  }

  const sexo = p.sexo;
  if (sexo !== undefined && sexo !== null && (typeof sexo !== "string" || sexo.length > 20)) {
    errores.push("sexo no puede exceder 20 caracteres");
  }

  const tamano = p.tamano;
  if (tamano !== undefined && tamano !== null && (typeof tamano !== "string" || tamano.length > 20)) {
    errores.push("tamano no puede exceder 20 caracteres");
  }

  const tipo_pelo = p.tipo_pelo;
  if (tipo_pelo !== undefined && tipo_pelo !== null && (typeof tipo_pelo !== "string" || tipo_pelo.length > 50)) {
    errores.push("tipo_pelo no puede exceder 50 caracteres");
  }

  const observaciones = p.observaciones;
  if (observaciones !== undefined && observaciones !== null && typeof observaciones !== "string") {
    errores.push("observaciones debe ser texto");
  }

  const activo = p.activo;
  if (activo !== undefined && typeof activo !== "boolean") {
    errores.push("activo debe ser boolean");
  }

  const altaExigencia = p.altaExigencia;
  if (altaExigencia !== undefined && typeof altaExigencia !== "boolean") {
    errores.push("altaExigencia debe ser boolean");
  }

  if (errores.length > 0) {
    return { ok: false, errores };
  }

  const data: EditarMascotaPayload = {};
  if (nombre !== undefined) data.nombre = (nombre as string).trim();
  if (raza !== undefined) data.raza = (raza as string)?.trim() || null;
  if (fecha_nacimiento !== undefined) data.fecha_nacimiento = fecha_nacimiento as string | null;
  if (sexo !== undefined) data.sexo = (sexo as string)?.trim() || null;
  if (tamano !== undefined) data.tamano = (tamano as string)?.trim() || null;
  if (tipo_pelo !== undefined) data.tipo_pelo = (tipo_pelo as string)?.trim() || null;
  if (observaciones !== undefined) data.observaciones = (observaciones as string)?.trim() || null;
  if (activo !== undefined) data.activo = activo as boolean;
  if (altaExigencia !== undefined) data.altaExigencia = altaExigencia as boolean;

  return { ok: true, errores: [], data };
}

export function validarAsociarResponsable(payload: unknown): { ok: boolean; errores: string[]; data?: AsociarResponsablePayload } {
  const errores: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errores: ["Payload inválido"] };
  }

  const p = payload as Record<string, unknown>;

  const clienteId = p.clienteId;
  if (clienteId === undefined || typeof clienteId !== "number" || !Number.isInteger(clienteId) || clienteId <= 0) {
    errores.push("clienteId es obligatorio y debe ser un entero positivo");
  }

  if (errores.length > 0) {
    return { ok: false, errores };
  }

  return { ok: true, errores: [], data: { clienteId: clienteId as number } };
}

export function validarCrearResponsable(payload: unknown): { ok: boolean; errores: string[]; data?: CrearResponsablePayload } {
  const errores: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errores: ["Payload inválido"] };
  }

  const p = payload as Record<string, unknown>;

  const nombre = p.nombre;
  if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
    errores.push("nombre es obligatorio");
  } else if (nombre.length > 255) {
    errores.push("nombre no puede exceder 255 caracteres");
  }

  const telefono = p.telefono;
  if (!telefono || typeof telefono !== "string" || telefono.trim() === "") {
    errores.push("telefono es obligatorio");
  } else if (telefono.length > 50) {
    errores.push("telefono no puede exceder 50 caracteres");
  }

  if (errores.length > 0) {
    return { ok: false, errores };
  }

  return {
    ok: true,
    errores: [],
    data: {
      nombre: (nombre as string).trim(),
      telefono: (telefono as string).trim(),
    },
  };
}
