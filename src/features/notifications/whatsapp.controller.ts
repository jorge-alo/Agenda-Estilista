// src/features/notifications/whatsapp.controller.ts
import { Request, Response } from "express";
import { evolutionClient } from "./infrastructure/evolution.client";

// Crea la instancia y devuelve el QR
export const conectarWhatsApp = async (req: Request, res: Response) => {
  const { localId } = req.params;

  try {
    await evolutionClient.post("/instance/create", {
      instanceName: String(localId),
      qrcode: true,
    });
    console.log(`✨ Instancia ${localId} creada con éxito.`);
  } catch (error: any) {
    console.log("❌ ERROR O TIMEOUT AL CREAR INSTANCIA");
    
    const mensaje = error?.response?.data?.response?.message?.[0] || "";
    const yaExiste = mensaje.toLowerCase().includes("already in use") || error?.response?.status === 400;

    // Si NO es porque ya existe (es decir, fue un Timeout o error de Red de Railway), frenamos acá
    if (!yaExiste) {
      return res.status(500).json({
        error: "La API de WhatsApp no respondió a tiempo. Intentá de nuevo en unos segundos."
      });
    }

    console.log("⚠️ La instancia ya existía en Evolution API, continuamos para obtener el QR...");
  }

  try {
    const { data } = await evolutionClient.get(
  `/instance/connect/${localId}`
);
    return res.json({ qr: data.base64 });
  } catch (error: any) {
    console.log(
  "❌ Error obteniendo QR:",
  error.response?.data || error.message
);
console.log("❌ ERROR COMPLETO:");
console.log(error);
    return res.status(500).json({ error: "Error obteniendo QR" });
  }
};

// Devuelve el estado de conexión del local
export const estadoWhatsApp = async (req: Request, res: Response) => {
  const { localId } = req.params;

  try {
    const { data } = await evolutionClient.get(
      `/instance/connectionState/${localId}`
    );

    // open = conectado, close = desconectado
    const conectado = data.instance?.state === "open";

    return res.json({ conectado, estado: data.instance?.state });
  } catch (error: any) {
    return res.status(200).json({ conectado: false, estado: "close" });
  }
};