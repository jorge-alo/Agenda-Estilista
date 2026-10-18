import { Router } from "express";
import { obtener } from "./publicBooking.controller";
import { petPublicSessionMiddleware } from "../session/petPublicSession.middleware";

const publicBookingRouter = Router();

publicBookingRouter.get("/:slug/mascotas/:mascotaId/opciones-reserva", petPublicSessionMiddleware, obtener);

export default publicBookingRouter;
