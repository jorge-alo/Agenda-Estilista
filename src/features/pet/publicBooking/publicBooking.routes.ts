import { Router } from "express";
import { disponibilidad, obtener } from "./publicBooking.controller";
import { petPublicSessionMiddleware } from "../session/petPublicSession.middleware";

const publicBookingRouter = Router();

publicBookingRouter.get("/:slug/mascotas/:mascotaId/opciones-reserva", petPublicSessionMiddleware, obtener);
publicBookingRouter.post("/:slug/disponibilidad", petPublicSessionMiddleware, disponibilidad);

export default publicBookingRouter;
