import { Router } from 'express';
import { crearLinkPago, webhook, webhookTurno, webhookSuscripcion } from './pagos.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';

const pagosRouter = Router();

// Ruta para crear link de pago (requiere autenticación)
pagosRouter.post('/crear-link', authMiddleware, crearLinkPago);

// Webhook de Mercado Pago (NO requiere autenticación, MP lo llama directamente)
pagosRouter.post('/webhook', webhook);
pagosRouter.post('/webhook/turnos', webhookTurno);
pagosRouter.post('/webhook/suscripciones', webhookSuscripcion);

export default pagosRouter;
