import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { authorizeRole } from "../../middlewares/authorizeRole";
import { getConfiguracion, updateConfiguracion } from "./configuracion.controller";
import { configurarMP, obtenerEstadoMP } from "./configuracionMP.controller";

const routerConfiguracion = Router();

routerConfiguracion.get("/", authMiddleware, authorizeRole("admin"), getConfiguracion);
routerConfiguracion.put("/", authMiddleware, authorizeRole("admin"), updateConfiguracion);

// ✅ NUEVAS rutas de Mercado Pago
routerConfiguracion.post("/mercadopago", authMiddleware, authorizeRole("admin"), configurarMP);
routerConfiguracion.get("/mercadopago/estado", authMiddleware, authorizeRole("admin"), obtenerEstadoMP);

export default routerConfiguracion;