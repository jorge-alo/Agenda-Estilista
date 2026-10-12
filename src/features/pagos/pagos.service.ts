import { MercadoPagoConfig, Payment, Preference } from "mercadopago";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../config/db";

interface RegistrarIntentoPagoData {
  turnoId: number;
  localId: number;
  monto: number;
  tipo: "seña" | "completo";
}

interface PagoPersistido extends RowDataPacket {
  id: number;
  turno_id: number;
  local_id: number;
  preference_id: string | null;
  monto: string;
  tipo: "seña" | "completo";
  estado: "pendiente" | "aprobado" | "rechazado" | "cancelado";
  mp_payment_id: string | null;
  mp_status: string | null;
  mp_status_detail: string | null;
}

interface ContextoPago extends PagoPersistido {
  turno_estado: "pendiente_pago" | "activo" | "cancelado" | "completado" | null;
  turno_pago_id: number | null;
  mp_access_token: string | null;
  sena_aprobada_id: number | null;
}

interface TurnoBloqueado extends RowDataPacket {
  id: number;
  local_id: number;
  estado: ContextoPago["turno_estado"];
  pago_id: number | null;
}

interface DatosConfirmacionTurno extends RowDataPacket {
  clienteNombre: string;
  clienteTelefono: string;
  fecha: string;
  hora: string;
  servicioNombre: string;
  localNombre: string | null;
  localTelefono: string | null;
  localId: number;
}

interface TurnoParaPago extends RowDataPacket {
  id: number;
  nombre: string;
  precio: string | null;
  slug: string | null;
  mp_access_token: string | null;
  estado: ContextoPago["turno_estado"];
}

type EtapaCreacionPreference = "verificacion_intento" | "creacion_preference"
  | "respuesta_preference" | "vinculacion_preference";

interface DetallesCreacionPreference {
  etapa: EtapaCreacionPreference;
  pagoId: number;
  turnoId: number;
  localId: number;
  preferenceId: string | null;
  status?: number;
  codigo?: string;
}

export class SenaYaAprobadaError extends Error {
  readonly codigo = "SENA_YA_APROBADA";

  constructor(readonly detalles?: DetallesCreacionPreference) {
    super("El turno ya tiene una seña aprobada");
    this.name = "SenaYaAprobadaError";
  }
}

export class ErrorCreacionPreference extends Error {
  readonly detalles: DetallesCreacionPreference;

  constructor(detalles: DetallesCreacionPreference, error: unknown) {
    super("No se pudo completar la creación del enlace de pago de turno");
    this.name = "ErrorCreacionPreference";
    let status: number | undefined;
    let codigo: string | undefined;
    if (typeof error === "object" && error !== null) {
      if ("status" in error && typeof error.status === "number") status = error.status;
      else if ("statusCode" in error && typeof error.statusCode === "number") status = error.statusCode;
      if ("code" in error && typeof error.code === "string" && /^ER_[A-Z_]+$/.test(error.code)) codigo = error.code;
    }
    // No conservar el error completo/cause: el SDK puede incluir credenciales.
    this.detalles = { ...detalles, status, codigo };
  }
}

function baseUrlPago(value: string | undefined, nombre: string): string {
  try {
    const url = new URL(value ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("URL inválida");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${nombre} no está configurada correctamente para el pago`);
  }
}

function intentoDisponibleParaLink(contexto: ContextoPago | null, pagoId: number, turnoId: number, localId: number): boolean {
  return contexto !== null && contexto.id === pagoId && contexto.turno_id === turnoId
    && contexto.local_id === localId && contexto.turno_pago_id === pagoId
    && contexto.estado === "pendiente" && contexto.mp_payment_id === null
    && (contexto.turno_estado === "pendiente_pago" || contexto.turno_estado === "activo");
}

export interface PagoMPConsultado {
  id?: string | number;
  external_reference?: string | null;
  transaction_amount?: string | number;
  currency_id?: string;
  status?: string;
  status_detail?: string | null;
  preference_id?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

type MotivoPagoInvalido =
  | "payment_id_invalido"
  | "payment_id_no_coincide"
  | "referencia_no_coincide"
  | "monto_invalido"
  | "monto_no_coincide"
  | "moneda_no_coincide"
  | "metadata_no_coincide"
  | "preference_id_no_coincide"
  | "status_invalido"
  | "status_detail_invalido";

export type ValidacionPagoDelIntento =
  | { valido: false; motivo: MotivoPagoInvalido }
  | { valido: true; mpPaymentId: string; status: string; statusDetail: string | null };

type TipoResultadoPagoTurno =
  | "confirmado"
  | "pago_rechazado"
  | "pago_cancelado"
  | "registrado_sin_confirmar"
  | "ya_procesado"
  | "conflicto_de_pago"
  | "estado_no_final"
  | "pago_invalido"
  | "intento_no_encontrado"
  | "relacion_inconsistente";

export interface ResultadoPagoTurno {
  resultado: TipoResultadoPagoTurno;
  motivo: MotivoPagoInvalido | "payment_id_diferente" | "payment_id_de_otro_intento"
    | "estado_previamente_procesado" | "turno_cancelado" | "turno_completado"
    | "turno_ya_activo" | "intento_no_vigente" | null;
  pagoId: number;
  turnoId: number | null;
  localId: number | null;
  mpPaymentId: string | null;
  mpPaymentIdPersistido: string | null;
  turnoPagoId: number | null;
  notificarWhatsApp: boolean;
  requiereConciliacion: boolean;
  turnoCancelado: boolean;
}

interface ProcesarPagoTurnoData {
  pagoId: number;
  paymentId: string;
  payment: PagoMPConsultado;
}

function normalizarIdMP(id: unknown): string | null {
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  return typeof id === "string" && /^[1-9]\d*$/.test(id) && id.length <= 255 ? id : null;
}

function montoEnCentavos(monto: unknown): number | null {
  const texto = typeof monto === "number" && Number.isFinite(monto)
    ? String(monto)
    : typeof monto === "string" ? monto : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(texto)) return null;
  const [entero, decimal = ""] = texto.split(".");
  const centavos = Number(entero) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(centavos) && centavos > 0 ? centavos : null;
}

function esDuplicadoDePaymentId(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "ER_DUP_ENTRY"
    && "sqlMessage" in error && typeof error.sqlMessage === "string"
    && error.sqlMessage.includes("uq_pagos_mp_payment_id");
}

function validarIdPositivo(id: number, campo: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${campo} inválido`);
  }
}

interface CrearPagoData {
  turnoId: number;
  localId: number;
  servicioNombre: string;
  monto: number | string;
  tipo: "seña" | "completo";
  porcentajeSeña?: number;
  accessToken: string;
  slug: string;
}

export const pagosService = {
  validarPagoDelIntento: (
    intento: Pick<PagoPersistido, "id" | "turno_id" | "local_id" | "monto" | "tipo" | "preference_id">,
    payment: PagoMPConsultado,
    paymentIdEsperado: string
  ): ValidacionPagoDelIntento => {
    const mpPaymentId = normalizarIdMP(payment.id);
    const esperado = normalizarIdMP(paymentIdEsperado);
    if (!mpPaymentId || !esperado) return { valido: false, motivo: "payment_id_invalido" };
    if (mpPaymentId !== esperado) return { valido: false, motivo: "payment_id_no_coincide" };
    if (payment.external_reference !== `turno-${intento.turno_id}-pago-${intento.id}`) {
      return { valido: false, motivo: "referencia_no_coincide" };
    }

    const recibido = montoEnCentavos(payment.transaction_amount);
    const registrado = montoEnCentavos(intento.monto);
    if (recibido === null || registrado === null) return { valido: false, motivo: "monto_invalido" };
    if (recibido !== registrado) return { valido: false, motivo: "monto_no_coincide" };
    if (payment.currency_id !== "ARS") return { valido: false, motivo: "moneda_no_coincide" };

    if (payment.metadata !== undefined && payment.metadata !== null) {
      if (typeof payment.metadata !== "object" || Array.isArray(payment.metadata)) {
        return { valido: false, motivo: "metadata_no_coincide" };
      }
      for (const [campo, valor] of [
        ["turno_id", intento.turno_id], ["local_id", intento.local_id], ["pago_id", intento.id],
      ] as const) {
        if (campo in payment.metadata && normalizarIdMP(payment.metadata[campo]) !== String(valor)) {
          return { valido: false, motivo: "metadata_no_coincide" };
        }
      }
      if ("tipo" in payment.metadata && payment.metadata.tipo !== intento.tipo) {
        return { valido: false, motivo: "metadata_no_coincide" };
      }
    }
    if (intento.preference_id !== null && payment.preference_id !== undefined && payment.preference_id !== null
      && String(payment.preference_id) !== intento.preference_id) {
      return { valido: false, motivo: "preference_id_no_coincide" };
    }
    if (typeof payment.status !== "string" || !payment.status || payment.status.length > 50) {
      return { valido: false, motivo: "status_invalido" };
    }
    if (payment.status_detail !== undefined && payment.status_detail !== null
      && (typeof payment.status_detail !== "string" || payment.status_detail.length > 100)) {
      return { valido: false, motivo: "status_detail_invalido" };
    }
    return {
      valido: true,
      mpPaymentId,
      status: payment.status,
      statusDetail: payment.status_detail ?? null,
    };
  },

  procesarPagoTurno: async ({ pagoId, paymentId, payment }: ProcesarPagoTurnoData): Promise<ResultadoPagoTurno> => {
    validarIdPositivo(pagoId, "pagoId");
    const contexto = await pagosService.obtenerContextoPago(pagoId);
    const datos: Omit<ResultadoPagoTurno, "resultado"> = {
      motivo: null,
      pagoId,
      turnoId: contexto?.turno_id ?? null,
      localId: contexto?.local_id ?? null,
      mpPaymentId: normalizarIdMP(paymentId),
      mpPaymentIdPersistido: contexto?.mp_payment_id ?? null,
      turnoPagoId: contexto?.turno_pago_id ?? null,
      notificarWhatsApp: false,
      requiereConciliacion: false,
      turnoCancelado: false,
    };
    const resultado = (tipo: TipoResultadoPagoTurno, detalles: Partial<typeof datos> = {}): ResultadoPagoTurno =>
      ({ ...datos, ...detalles, resultado: tipo });
    if (!contexto) return resultado("intento_no_encontrado");

    const previa = pagosService.validarPagoDelIntento(contexto, payment, paymentId);
    if (!previa.valido) return resultado("pago_invalido", { motivo: previa.motivo });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Mismo orden que registrarIntentoPago: turno primero, intento después.
      const [turnos] = await connection.query<TurnoBloqueado[]>(
        `SELECT id, local_id, estado, pago_id FROM turnos
         WHERE id = ? AND local_id = ? FOR UPDATE`,
        [contexto.turno_id, contexto.local_id]
      );
      const [pagos] = await connection.query<PagoPersistido[]>(
        `SELECT id, turno_id, local_id, preference_id, monto, tipo, estado,
                mp_payment_id, mp_status, mp_status_detail
         FROM pagos WHERE id = ? AND local_id = ? FOR UPDATE`,
        [pagoId, contexto.local_id]
      );
      const turno = turnos[0];
      const pago = pagos[0];
      if (!turno || !pago || pago.turno_id !== turno.id || pago.local_id !== turno.local_id
        || !["pendiente_pago", "activo", "cancelado", "completado"].includes(turno.estado ?? "")) {
        await connection.rollback();
        return resultado("relacion_inconsistente");
      }
      datos.mpPaymentIdPersistido = pago.mp_payment_id;
      datos.turnoPagoId = turno.pago_id;

      // Se revalida con los datos bloqueados, no con el contexto previo.
      const validacion = pagosService.validarPagoDelIntento(pago, payment, paymentId);
      if (!validacion.valido) {
        await connection.rollback();
        return resultado("pago_invalido", { motivo: validacion.motivo });
      }
      if (pago.mp_payment_id !== null && pago.mp_payment_id !== validacion.mpPaymentId) {
        await connection.rollback();
        return resultado("conflicto_de_pago", { motivo: "payment_id_diferente", requiereConciliacion: true });
      }

      const estado = validacion.status === "approved" ? "aprobado"
        : validacion.status === "rejected" ? "rechazado"
          : validacion.status === "cancelled" ? "cancelado" : null;
      if (estado === null) {
        await connection.rollback();
        return resultado("estado_no_final");
      }

      // La idempotencia y la protección de estados finales ocurren bajo lock.
      if (pago.estado !== "pendiente") {
        await connection.rollback();
        if (pago.mp_payment_id === validacion.mpPaymentId && pago.estado === estado) {
          return resultado("ya_procesado");
        }
        return resultado("conflicto_de_pago", { motivo: "estado_previamente_procesado", requiereConciliacion: true });
      }

      const [asociados] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM pagos WHERE mp_payment_id = ? AND local_id = ?",
        [validacion.mpPaymentId, pago.local_id]
      );
      if (asociados.some((asociado) => asociado.id !== pago.id)) {
        await connection.rollback();
        return resultado("conflicto_de_pago", { motivo: "payment_id_de_otro_intento", requiereConciliacion: true });
      }

      const [actualizacionPago] = await connection.query<ResultSetHeader>(
        `UPDATE pagos SET estado = ?, mp_payment_id = ?, mp_status = ?, mp_status_detail = ?
         WHERE id = ? AND local_id = ? AND estado = 'pendiente'
           AND (mp_payment_id IS NULL OR mp_payment_id = ?)`,
        [estado, validacion.mpPaymentId, validacion.status, validacion.statusDetail,
          pago.id, pago.local_id, validacion.mpPaymentId]
      );
      if (actualizacionPago.affectedRows !== 1) {
        throw new Error("No se pudo actualizar el pago del intento esperado");
      }

      let final: ResultadoPagoTurno;
      const vigente = turno.pago_id === pago.id;
      if (estado === "aprobado") {
        if (turno.estado === "pendiente_pago" && vigente) {
          const [actualizacionTurno] = await connection.query<ResultSetHeader>(
            `UPDATE turnos SET estado = 'activo'
             WHERE id = ? AND local_id = ? AND estado = 'pendiente_pago' AND pago_id = ?`,
            [turno.id, turno.local_id, pago.id]
          );
          if (actualizacionTurno.affectedRows !== 1) throw new Error("No se pudo confirmar el turno esperado");
          final = resultado("confirmado", { notificarWhatsApp: true });
        } else {
          const motivo = turno.estado === "cancelado" ? "turno_cancelado"
            : turno.estado === "completado" ? "turno_completado"
              : !vigente ? "intento_no_vigente" : "turno_ya_activo";
          final = resultado("registrado_sin_confirmar", {
            motivo,
            requiereConciliacion: motivo !== "turno_ya_activo",
          });
        }
      } else {
        let turnoCancelado = false;
        if (turno.estado === "pendiente_pago" && vigente) {
          const [actualizacionTurno] = await connection.query<ResultSetHeader>(
            `UPDATE turnos SET estado = 'cancelado'
             WHERE id = ? AND local_id = ? AND estado = 'pendiente_pago' AND pago_id = ?`,
            [turno.id, turno.local_id, pago.id]
          );
          if (actualizacionTurno.affectedRows !== 1) throw new Error("No se pudo cancelar el turno esperado");
          turnoCancelado = true;
        }
        final = resultado(estado === "rechazado" ? "pago_rechazado" : "pago_cancelado", { turnoCancelado });
      }
      await connection.commit();
      return { ...final, mpPaymentIdPersistido: validacion.mpPaymentId };
    } catch (error) {
      await connection.rollback();
      // El índice único también protege conflictos entre locales y carreras.
      if (esDuplicadoDePaymentId(error)) {
        return resultado("conflicto_de_pago", { motivo: "payment_id_de_otro_intento", requiereConciliacion: true });
      }
      throw error;
    } finally {
      connection.release();
    }
  },

  registrarIntentoPago: async (data: RegistrarIntentoPagoData) => {
    const { turnoId, localId, monto, tipo } = data;
    validarIdPositivo(turnoId, "turnoId");
    validarIdPositivo(localId, "localId");

    if (!Number.isFinite(monto) || monto <= 0) {
      throw new Error("Monto inválido");
    }
    if (tipo !== "seña" && tipo !== "completo") {
      throw new Error("Tipo de pago inválido");
    }

    const montoFinal = Number(monto.toFixed(2));
    if (montoFinal <= 0) {
      throw new Error("Monto inválido");
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [turnos] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM turnos
         WHERE id = ? AND local_id = ?
         FOR UPDATE`,
        [turnoId, localId]
      );
      if (turnos.length === 0) {
        throw new Error("Turno no encontrado en el local indicado");
      }

      if (tipo === "seña") {
        // Lectura actual bajo el lock del turno, compartido con la aprobación.
        // Revisar todo el historial, aunque pago_id apunte a otro intento.
        const [aprobadas] = await connection.query<RowDataPacket[]>(
          `SELECT id FROM pagos
           WHERE turno_id = ? AND local_id = ? AND tipo = 'seña' AND estado = 'aprobado'
           LIMIT 1 FOR UPDATE`,
          [turnoId, localId]
        );
        if (aprobadas.length > 0) throw new SenaYaAprobadaError();
      }

      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO pagos (turno_id, local_id, preference_id, monto, tipo, estado)
         VALUES (?, ?, NULL, ?, ?, 'pendiente')`,
        [turnoId, localId, montoFinal, tipo]
      );
      const pagoId = result.insertId;

      const [actualizacion] = await connection.query<ResultSetHeader>(
        "UPDATE turnos SET pago_id = ? WHERE id = ? AND local_id = ?",
        [pagoId, turnoId, localId]
      );
      if (actualizacion.affectedRows !== 1) {
        throw new Error("No se pudo vincular el intento al turno del local");
      }

      await connection.commit();
      return { pagoId, monto: montoFinal };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  vincularPreference: async (pagoId: number, localId: number, preferenceId: string): Promise<void> => {
    validarIdPositivo(pagoId, "pagoId");
    validarIdPositivo(localId, "localId");
    if (typeof preferenceId !== "string" || !preferenceId.trim() || preferenceId.length > 255) {
      throw new Error("preferenceId inválido");
    }

    // Compare-and-set: solo permite la primera vinculación; nunca cambia estado.
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE pagos SET preference_id = ?
       WHERE id = ? AND local_id = ? AND preference_id IS NULL`,
      [preferenceId, pagoId, localId]
    );
    if (result.affectedRows === 1) return;

    const [pagos] = await pool.query<RowDataPacket[]>(
      "SELECT preference_id FROM pagos WHERE id = ? AND local_id = ?",
      [pagoId, localId]
    );
    if (pagos.length === 0) {
      throw new Error("Intento de pago no encontrado en el local indicado");
    }
    if (pagos[0].preference_id !== preferenceId) {
      throw new Error("El intento ya tiene una preferencia diferente");
    }
    // Repetir la misma vinculación es válido y no modifica ningún otro campo.
  },

  obtenerContextoPago: async (pagoId: number): Promise<ContextoPago | null> => {
    validarIdPositivo(pagoId, "pagoId");
    const [rows] = await pool.query<ContextoPago[]>(
      `SELECT p.id, p.turno_id, p.local_id, p.preference_id, p.monto, p.tipo,
              p.estado, p.mp_payment_id, p.mp_status, p.mp_status_detail,
              t.estado AS turno_estado, t.pago_id AS turno_pago_id,
              l.mp_access_token,
              (SELECT anterior.id FROM pagos anterior
               WHERE anterior.turno_id = p.turno_id AND anterior.local_id = p.local_id
                 AND anterior.tipo = 'seña' AND anterior.estado = 'aprobado'
               LIMIT 1) AS sena_aprobada_id
       FROM pagos p
       JOIN turnos t ON t.id = p.turno_id AND t.local_id = p.local_id
       JOIN locales l ON l.id = p.local_id
       WHERE p.id = ?`,
      [pagoId]
    );
    return rows[0] ?? null;
  },

  obtenerDatosConfirmacionTurno: async (turnoId: number, localId: number): Promise<DatosConfirmacionTurno | null> => {
    validarIdPositivo(turnoId, "turnoId");
    validarIdPositivo(localId, "localId");
    const [rows] = await pool.query<DatosConfirmacionTurno[]>(
      `SELECT t.cliente_nombre AS clienteNombre, t.cliente_telefono AS clienteTelefono,
              DATE_FORMAT(t.fecha, '%Y-%m-%d') AS fecha, t.hora,
              s.nombre AS servicioNombre, l.nombre AS localNombre,
              l.telefono AS localTelefono, l.id AS localId
       FROM turnos t
       JOIN servicios s ON s.id = t.servicio_id AND s.local_id = t.local_id
       JOIN locales l ON l.id = t.local_id
       WHERE t.id = ? AND t.local_id = ? AND t.estado = 'activo'`,
      [turnoId, localId]
    );
    return rows[0] ?? null;
  },

  obtenerTurnoParaPago: async (turnoId: number, localId: number): Promise<TurnoParaPago | null> => {
    validarIdPositivo(turnoId, "turnoId");
    validarIdPositivo(localId, "localId");
    const [rows] = await pool.query<TurnoParaPago[]>(
      `SELECT t.id, t.estado, s.nombre, s.precio, l.slug, l.mp_access_token
       FROM turnos t
       JOIN servicios s ON s.id = t.servicio_id AND s.local_id = t.local_id
       JOIN locales l ON l.id = t.local_id
       WHERE t.id = ? AND t.local_id = ?`,
      [turnoId, localId]
    );
    return rows[0] ?? null;
  },

  obtenerPaymentInfo: async (paymentId: string, accessToken: string) => {
    if (!accessToken?.trim()) {
      throw new Error("Se requiere un Access Token explícito de Mercado Pago");
    }

    const client = new MercadoPagoConfig({ accessToken });
    const paymentClient = new Payment(client);

    return paymentClient.get({ id: paymentId });
  },

  crearPreference: async (data: CrearPagoData) => {
    const {
      turnoId,
      localId,
      servicioNombre,
      monto,
      tipo,
      porcentajeSeña = 30,
      accessToken,
      slug,
    } = data;

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("No hay token de Mercado Pago configurado para este local");
    }
    if (tipo !== "seña" && tipo !== "completo") throw new Error("Tipo de pago inválido");
    if (!Number.isFinite(porcentajeSeña) || porcentajeSeña < 1 || porcentajeSeña > 100) {
      throw new Error("Porcentaje de seña inválido");
    }
    const montoBase = typeof monto === "string" && monto.trim() ? Number(monto) : monto;
    if (typeof montoBase !== "number" || !Number.isFinite(montoBase) || montoBase <= 0) {
      throw new Error("Monto inválido");
    }
    if (typeof slug !== "string" || !slug.trim()) throw new Error("Slug del local inválido");
    const backendUrl = baseUrlPago(process.env.BACKEND_URL, "BACKEND_URL");
    const frontendUrl = baseUrlPago(process.env.FRONTEND_URL, "FRONTEND_URL");
    const montoACobrar = tipo === "seña" ? (montoBase * porcentajeSeña) / 100 : montoBase;
    const { pagoId, monto: montoFinal } = await pagosService.registrarIntentoPago({
      turnoId, localId, monto: montoACobrar, tipo,
    });

    let etapa: EtapaCreacionPreference = "verificacion_intento";
    let preferenceId: string | null = null;
    try {
      const contexto = await pagosService.obtenerContextoPago(pagoId);
      if (tipo === "seña" && contexto?.sena_aprobada_id != null) {
        throw new SenaYaAprobadaError();
      }
      if (!intentoDisponibleParaLink(contexto, pagoId, turnoId, localId)
        || contexto?.mp_access_token !== accessToken) {
        throw new Error("El intento o la credencial local ya no están disponibles para crear el enlace");
      }
      const client = new MercadoPagoConfig({ accessToken });
      const preferenceClient = new Preference(client);
      etapa = "creacion_preference";
      const preference = await preferenceClient.create({
        // Clave estable por intento; no representa una transacción con MySQL.
        requestOptions: { idempotencyKey: `turno-intento-${pagoId}` },
        body: {
          items: [
            {
              id: `turno-${turnoId}`,
              title: tipo === "seña" ? `Seña - ${servicioNombre}` : servicioNombre,
              description:
                tipo === "seña"
                  ? `Seña del ${porcentajeSeña}% para confirmar tu turno`
                  : "Pago completo del turno",
              quantity: 1,
              unit_price: montoFinal,
              currency_id: "ARS",
            },
          ],
          back_urls: {
            success: `${frontendUrl}/pago-exitoso?turno=${turnoId}&slug=${encodeURIComponent(slug)}`,
            failure: `${frontendUrl}/pago-fallido?turno=${turnoId}&slug=${encodeURIComponent(slug)}`,
            pending: `${frontendUrl}/pago-pendiente?turno=${turnoId}&slug=${encodeURIComponent(slug)}`,
          },
          auto_return: "approved",
          external_reference: `turno-${turnoId}-pago-${pagoId}`,
          notification_url: `${new URL("/api/pagos/webhook/turnos", backendUrl)}?pago_id=${pagoId}`,
          metadata: {
            turno_id: turnoId,
            local_id: localId,
            pago_id: pagoId,
            tipo: tipo,
          },
        },
      });

      etapa = "respuesta_preference";
      if (typeof preference.id !== "string" || !preference.id.trim() || preference.id.length > 255) {
        throw new Error("Mercado Pago no devolvió un ID de preferencia válido");
      }
      preferenceId = preference.id;
      etapa = "vinculacion_preference";
      await pagosService.vincularPreference(pagoId, localId, preferenceId);

      // No se recrea ni se elimina el intento si esta fase falla. El ID remoto
      // conocido queda en el error seguro para una recuperación específica.
      etapa = "respuesta_preference";
      if (typeof preference.init_point !== "string" || !preference.init_point.trim()) {
        throw new Error("Mercado Pago no devolvió el enlace de la preferencia");
      }
      etapa = "verificacion_intento";
      const vinculado = await pagosService.obtenerContextoPago(pagoId);
      // Una aprobación puede haberse comprometido después del registro y
      // durante MP. Conservar el intento/preferencia, pero no entregar link.
      if (tipo === "seña" && vinculado?.sena_aprobada_id != null) {
        throw new SenaYaAprobadaError();
      }
      if (!intentoDisponibleParaLink(vinculado, pagoId, turnoId, localId) || vinculado?.preference_id !== preferenceId) {
        throw new Error("El intento vinculado ya no está disponible para devolver el enlace");
      }
      return { pagoId, initPoint: preference.init_point, sandboxInitPoint: preference.sandbox_init_point };
    } catch (error: unknown) {
      // Fallo cerrado: nunca devolver init_point ni ejecutar otro create de MP.
      // Una respuesta SQL fallida puede ser ambigua; no se afirma que la
      // preferencia esté necesariamente NULL y no se borra información.
      const detalles = { etapa, pagoId, turnoId, localId, preferenceId };
      if (error instanceof SenaYaAprobadaError) throw new SenaYaAprobadaError(detalles);
      throw new ErrorCreacionPreference(detalles, error);
    }
  },

  obtenerPagoPorPreferenceId: async (preferenceId: string) => {
    const [rows]: any = await pool.query(
      "SELECT * FROM pagos WHERE preference_id = ?",
      [preferenceId]
    );
    return rows[0];
  },

  obtenerPagoPorTurnoId: async (turnoId: number) => {
    const [rows]: any = await pool.query(
      "SELECT * FROM pagos WHERE turno_id = ? ORDER BY id DESC LIMIT 1",
      [turnoId]
    );
    return rows[0];
  },
  obtenerPagoPorMpPaymentId: async (mpPaymentId: string) => {
    const [rows]: any = await pool.query(
      "SELECT * FROM pagos WHERE mp_payment_id = ?",
      [mpPaymentId]
    );

    return rows[0];
  },

  actualizarEstadoPago: async (
    pagoId: number,
    estado: "aprobado" | "rechazado" | "cancelado",
    mpPaymentId: string | null,
    mpStatus: string | null,
    mpStatusDetail: string | null
  ) => {
    await pool.query(
      `UPDATE pagos 
       SET estado = ?, mp_payment_id = ?, mp_status = ?, mp_status_detail = ?
       WHERE id = ?`,
      [estado, mpPaymentId, mpStatus, mpStatusDetail, pagoId]
    );
  },
};
