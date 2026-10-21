// src/features/notifications/whatsapp.routes.ts
import { Router } from "express";
import { conectarWhatsApp, estadoWhatsApp } from "./whatsapp.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { authorizeRole } from "../../middlewares/authorizeRole";

export const WhatsAppRouter = Router();

// Solo admins autenticados pueden conectar/ver estado
WhatsAppRouter.get("/conectar/:localId", authMiddleware, authorizeRole("admin"), conectarWhatsApp);
WhatsAppRouter.get("/estado/:localId", authMiddleware, authorizeRole("admin"), estadoWhatsApp);
