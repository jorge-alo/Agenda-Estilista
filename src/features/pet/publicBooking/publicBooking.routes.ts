import { Router } from "express";
import { crear, disponibilidad, obtener } from "./publicBooking.controller";
import { petPublicSessionMiddleware } from "../session/petPublicSession.middleware";

const publicBookingRouter = Router();

publicBookingRouter.get("/:slug/mascotas/:mascotaId/opciones-reserva", petPublicSessionMiddleware, obtener);
publicBookingRouter.post("/:slug/disponibilidad", petPublicSessionMiddleware, disponibilidad);
publicBookingRouter.post("/:slug/turnos", petPublicSessionMiddleware, crear);

export default publicBookingRouter;
