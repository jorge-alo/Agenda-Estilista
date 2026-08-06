import { Router } from 'express';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { crearLinkSuscripcion, obtenerEstadoSuscripcion } from './suscripcion.controller';

const suscripcionRouter = Router();

// Obtener el estado actual de la suscripción del local
suscripcionRouter.get('/estado', authMiddleware, obtenerEstadoSuscripcion);

// Crear link de pago para renovar la suscripción
suscripcionRouter.post('/pagar', authMiddleware, crearLinkSuscripcion);

export default suscripcionRouter;