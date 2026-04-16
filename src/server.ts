import express from "express";
import cors from "cors";
import { AuthRouter } from "./features/auth/auth.routes";
import { EstilistasRouter } from "./features/estilistas/estilistas.routes";
import { TurnosRouter } from "./features/turnos/turnos.routes";
import { PublicRouter } from "./features/public/public.routes";
import {  ServiciosRouter } from "./features/servicios/servicio.routes";
import { HorariosRouter } from "./features/horarios/horarios.routes";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", AuthRouter);
app.use("/api/estilistas", EstilistasRouter);
app.use("/api/turnos", TurnosRouter);
app.use("/api/public", PublicRouter);
app.use("/api/servicios", ServiciosRouter);
app.use("/api/horarios", HorariosRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server corriendo en puerto", PORT);
});