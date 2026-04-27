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
  } catch (error: any) {
    const mensaje = error.response?.data?.response?.message?.[0] || "";
    const yaExiste = mensaje.toLowerCase().includes("already in use");
    if (!yaExiste) {
      console.log("❌ Error creando instancia:", error.response?.data);
      return res.status(500).json({ error: "Error creando instancia" });
    }
    // Si ya existe, continuamos a obtener el QR
    console.log("⚠️ Instancia ya existe, obteniendo QR...");
  }

  try {
    const { data } = await evolutionClient.get(
  `/instance/connect/${localId}`
);
    return res.json({ qr: data.base64 });
  } catch (error: any) {
    console.log("❌ Error obteniendo QR:", error.response?.data);
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