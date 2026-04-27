// src/features/notifications/whatsapp.routes.ts
import { Router } from "express";
import { conectarWhatsApp, estadoWhatsApp } from "./whatsapp.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

export const WhatsAppRouter = Router();

// Solo admins autenticados pueden conectar/ver estado
WhatsAppRouter.get("/conectar/:localId", authMiddleware, conectarWhatsApp);
WhatsAppRouter.get("/estado/:localId", authMiddleware, estadoWhatsApp);