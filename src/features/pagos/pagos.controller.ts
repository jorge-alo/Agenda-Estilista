import { Request, Response } from 'express';
import { ErrorCreacionPreference, pagosService, SenaYaAprobadaError } from './pagos.service';
import type { AuthRequest } from '../../middlewares/auth.middleware';
import { sendTurnoConfirmado } from '../notifications/application/sendWhatsAppNotification';
import { formatPhoneAR } from '../../helpers/formatPhoneAR';
import { procesarPagoSuscripcion } from '../suscripcion/suscripcion.pagos';

function esRegistro(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idNumerico(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && value.length <= 255 ? value : null;
}

export const normalizarPaymentId = (req: Pick<Request, 'body' | 'query'>): string | null => {
  const rawBody: unknown = req.body;
  const body = esRegistro(rawBody) ? rawBody : {};
  const query = esRegistro(req.query) ? req.query : {};
  const topics = [body.type, body.topic, query.type, query.topic].filter((value) => value !== undefined);
  if (topics.some((value) => value !== 'payment')) return null;
  if (topics.length === 0 && body.action !== 'payment.created' && body.action !== 'payment.updated') return null;

  const candidates: unknown[] = [];
  if (body.data !== undefined) {
    if (!esRegistro(body.data)) return null;
    if ('id' in body.data) candidates.push(body.data.id);
  }
  if ('resource' in body) {
    if (typeof body.resource !== 'string') return null;
    candidates.push(body.resource.split(/[?#]/)[0].replace(/\/$/, '').split('/').pop());
  }
  for (const key of ['data.id', 'id']) {
    if (key in query) candidates.push(query[key]);
  }
  if ('data' in query) {
    if (!esRegistro(query.data)) return null;
    if ('id' in query.data) candidates.push(query.data.id);
  }
  const ids = candidates.map(idNumerico);
  const paymentId = ids[0];
  if (!paymentId || ids.some((id) => id !== paymentId)) return null;
  return paymentId;
};

function estadoHttpDelError(error: unknown): number | undefined {
  if (!esRegistro(error)) return undefined;
  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
}

async function intentarWhatsAppConfirmado(pagoId: number, turnoId: number, localId: number): Promise<void> {
  try {
    const datos = await pagosService.obtenerDatosConfirmacionTurno(turnoId, localId);
    if (!datos) {
      console.warn('Confirmación sin datos para WhatsApp:', { pagoId, turnoId, localId });
      return;
    }
    await sendTurnoConfirmado({
      clienteNombre: datos.clienteNombre,
      clienteTelefono: formatPhoneAR(datos.clienteTelefono),
      fecha: new Date(datos.fecha + 'T00:00:00').toLocaleDateString('es-AR'),
      hora: datos.hora,
      servicio: datos.servicioNombre,
      localNombre: datos.localNombre ?? '',
      localTelefono: datos.localTelefono ? formatPhoneAR(datos.localTelefono) : '',
      localId: String(datos.localId),
    });
  } catch (error: unknown) {
    console.error('Error en WhatsApp posterior a la confirmación:', {
      pagoId, turnoId, localId, status: estadoHttpDelError(error),
    });
  }
}

export const webhookTurno = async (req: Request, res: Response) => {
  const paymentId = normalizarPaymentId(req);
  if (!paymentId) return res.status(200).send('OK');

  const idTexto = idNumerico(req.query?.pago_id);
  const pagoId = idTexto ? Number(idTexto) : 0;
  if (!Number.isSafeInteger(pagoId) || pagoId <= 0) {
    console.warn('Webhook de turnos ignorado: pago_id inválido o ausente.');
    return res.status(200).send('OK');
  }

  try {
    const contexto = await pagosService.obtenerContextoPago(pagoId);
    if (!contexto) {
      console.warn('Webhook de turnos sin intento consistente:', { pagoId, paymentId });
      return res.status(200).send('OK');
    }
    const accessToken = contexto.mp_access_token;
    if (!accessToken?.trim()) {
      console.error('Webhook de turnos sin credencial local:', { pagoId, localId: contexto.local_id });
      return res.status(500).send('Error');
    }

    const payment = await pagosService.obtenerPaymentInfo(paymentId, accessToken);
    const resultado = await pagosService.procesarPagoTurno({ pagoId, paymentId, payment });
    if (resultado.requiereConciliacion || resultado.resultado === 'pago_invalido'
      || resultado.resultado === 'relacion_inconsistente' || resultado.resultado === 'intento_no_encontrado') {
      console.warn('Resultado de pago de turno para revisión:', {
        pagoId, paymentId, turnoId: resultado.turnoId, localId: resultado.localId,
        resultado: resultado.resultado, motivo: resultado.motivo,
        mpPaymentIdPersistido: resultado.mpPaymentIdPersistido,
      });
    }

    // El service solo devuelve confirmado después del COMMIT. La respuesta
    // se envía antes de WhatsApp para que su fallo no provoque reintentos MP.
    const respuesta = res.status(200).send('OK');
    if (resultado.resultado === 'confirmado' && resultado.notificarWhatsApp
      && resultado.turnoId !== null && resultado.localId !== null) {
      void intentarWhatsAppConfirmado(pagoId, resultado.turnoId, resultado.localId);
    }
    return respuesta;
  } catch (error: unknown) {
    console.error('Error en webhook de turnos:', { pagoId, paymentId, status: estadoHttpDelError(error) });
    return res.status(500).send('Error');
  }
};

async function procesarWebhookSuscripcion(req: Request, res: Response, historico: boolean) {
  const paymentId = normalizarPaymentId(req);
  if (!paymentId) return res.status(200).send('OK');
  if (historico && esRegistro(req.query) && 'pago_id' in req.query) {
    console.warn('Webhook histórico ignorado: contexto de turno fuera de compatibilidad.', { paymentId });
    return res.status(200).send('OK');
  }

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken?.trim()) {
    console.error('Webhook de suscripciones sin credencial global.');
    return res.status(500).send('Error');
  }

  try {
    let payment: Awaited<ReturnType<typeof pagosService.obtenerPaymentInfo>>;
    try {
      payment = await pagosService.obtenerPaymentInfo(paymentId, accessToken);
    } catch (error: unknown) {
      if (historico && estadoHttpDelError(error) === 404) {
        // No inferir que es una seña ni buscar credenciales de otro vendedor.
        console.warn('Pago histórico no accesible con cuenta global; revisión específica pendiente.', { paymentId });
        return res.status(200).send('OK');
      }
      throw error;
    }
    if (idNumerico(payment.id) !== paymentId) {
      console.warn('Webhook de suscripciones ignorado: Payment ID no coincide.', { paymentId });
      return res.status(200).send('OK');
    }
    const externalReference = payment.external_reference;
    if (typeof externalReference !== 'string' || !externalReference.startsWith('suscripcion-')) {
      console.warn('Webhook de suscripciones ignorado: referencia de otro flujo.', { paymentId });
      return res.status(200).send('OK');
    }
    if (typeof payment.status !== 'string' || !payment.status) {
      console.error('Consulta de suscripción sin estado de pago.', { paymentId });
      return res.status(500).send('Error');
    }
    const resultado = await procesarPagoSuscripcion({
      externalReference, status: payment.status, mpPaymentId: paymentId,
    });
    if (resultado === 'segundo_pago_aprobado' || resultado === 'intento_no_encontrado'
      || resultado === 'local_inexistente' || resultado === 'referencia_invalida') {
      console.warn('Resultado de suscripción para revisión:', { paymentId, resultado });
    }
    return res.status(200).send('OK');
  } catch (error: unknown) {
    console.error('Error en webhook de suscripciones:', {
      paymentId, historico, status: estadoHttpDelError(error),
    });
    return res.status(500).send('Error');
  }
}

export const webhookSuscripcion = (req: Request, res: Response) => procesarWebhookSuscripcion(req, res, false);

export const crearLinkPago = async (req: Request, res: Response) => {
  try {
    const body: unknown = req.body;
    if (!esRegistro(body)) return res.status(400).json({ error: 'Datos de pago inválidos' });
    const { turnoId, tipo, porcentajeSeña } = body;

    if (tipo !== undefined && tipo !== 'seña' && tipo !== 'completo') {
      return res.status(400).json({ error: 'Tipo de pago inválido' });
    }

    if (
      porcentajeSeña !== undefined &&
      (typeof porcentajeSeña !== 'number' || !Number.isFinite(porcentajeSeña) ||
        porcentajeSeña < 1 ||
        porcentajeSeña > 100)
    ) {
      return res.status(400).json({ error: 'Porcentaje de seña inválido' });
    }
    const localId: unknown = (req as AuthRequest).user?.localId;

    if (typeof localId !== 'number' || !Number.isSafeInteger(localId) || localId <= 0) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const idTurno = typeof turnoId === 'number' || typeof turnoId === 'string' ? Number(turnoId) : Number.NaN;

    if (!Number.isSafeInteger(idTurno) || idTurno <= 0) {
      return res.status(400).json({ error: 'turnoId inválido' });
    }

    const turno = await pagosService.obtenerTurnoParaPago(idTurno, localId);
    if (!turno) {
      return res.status(404).json({ error: 'Turno no encontrado' });
    }
    if (turno.estado !== 'pendiente_pago' && turno.estado !== 'activo') {
      return res.status(400).json({ error: 'El turno no admite un nuevo enlace de pago' });
    }
    if (!turno.mp_access_token?.trim()) {
      return res.status(400).json({ error: 'El local no tiene Mercado Pago configurado' });
    }
    if (!turno.slug) return res.status(400).json({ error: 'El local no tiene slug configurado' });

    // Crear preference de pago
    const resultado = await pagosService.crearPreference({
      turnoId: idTurno,
      localId,
      servicioNombre: turno.nombre,
      monto: Number(turno.precio),
      tipo: tipo ?? 'seña',
      porcentajeSeña: porcentajeSeña ?? 30,
      slug: turno.slug,
      accessToken: turno.mp_access_token,
    });

    res.json({
      message: 'Link de pago creado exitosamente',
      link: resultado.initPoint,
      pagoId: resultado.pagoId,
    });
  } catch (error: unknown) {
    if (error instanceof SenaYaAprobadaError) {
      if (error.detalles) console.warn('Nuevo enlace de seña rechazado:', error.detalles);
      return res.status(409).json({ error: error.message, codigo: error.codigo });
    }
    console.error('Error creando link de pago:', error instanceof ErrorCreacionPreference
      ? error.detalles : { status: estadoHttpDelError(error) });
    res.status(500).json({ error: 'Error al crear el link de pago' });
  }
};


// Compatibilidad mínima: solo suscripciones de la cuenta global verificadas
// contra MP y el intento registrado. No deriva pagos a otros receptores.
export const webhook = (req: Request, res: Response) => procesarWebhookSuscripcion(req, res, true);
