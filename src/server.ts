import express from "express";
import cors from "cors";
import { AuthRouter } from "./features/auth/auth.routes";
import { EstilistasRouter } from "./features/estilistas/estilistas.routes";
import { TurnosRouter } from "./features/turnos/turnos.routes";
import { PublicRouter } from "./features/public/public.routes";
import {  ServiciosRouter } from "./features/servicios/servicio.routes";
import { HorariosRouter } from "./features/horarios/horarios.routes";
import routerSuperAdmin from "./features/superAdmin/superadmin.routes";
import { WhatsAppRouter } from "./features/notifications/whatsapp.routes";
import { iniciarCronRecordatorios } from "./features/cron/recordatorios.cron";
import dashboardRouter from "./features/dashboard/dashboard.routes";
import bloqueosRouter from "./features/bloqueos/bloqueos.routes";
import clientesRouter from "./features/clientes/clientes.routes";
import routerConfiguracion from "./features/configuracion/configuracion.routes";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

if (!process.env.JWT_SECRET) {
  console.error("❌ FALTA JWT_SECRET en variables de entorno");
  process.exit(1);
}

if (!process.env.CORS_ORIGINS) {
  console.error("❌ FALTA CORS_ORIGINS en variables de entorno");
  process.exit(1);
}

const app = express();
app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim()); // saca espacios de más, por si acaso

app.use(cors({
  origin: (origin, callback) => {
    // 'origin' es undefined cuando el pedido no viene de un navegador
    // (por ejemplo, Postman, o un curl, o un servidor llamando a otro servidor)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true); // ✅ permitido
    } else {
      callback(new Error("No permitido por CORS")); // ❌ bloqueado
    }
  },
  credentials: true, // si en algún momento usás cookies, esto es necesario
}));

app.use(express.json({ limit: "1mb" }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
});
app.use(globalLimiter);

app.use("/api/auth", AuthRouter);
app.use("/api/estilistas", EstilistasRouter);
app.use("/api/turnos", TurnosRouter);
app.use("/api/public", PublicRouter);
app.use("/api/servicios", ServiciosRouter);
app.use("/api/horarios", HorariosRouter);
app.use("/api/superAdmin", routerSuperAdmin);
app.use("/api/whatsapp", WhatsAppRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/bloqueos", bloqueosRouter);
app.use("/api/clientes", clientesRouter);
app.use("/api/configuracion", routerConfiguracion);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server corriendo en puerto", PORT);
   iniciarCronRecordatorios();
});