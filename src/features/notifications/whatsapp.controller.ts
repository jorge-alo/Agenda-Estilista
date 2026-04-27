// src/features/notifications/whatsapp.controller.ts
import { Request, Response } from "express";
import { evolutionClient } from "./infrastructure/evolution.client";

// Crea la instancia y devuelve el QR
export const conectarWhatsApp = async (req: Request, res: Response) => {
  const { localId } = req.params;

  try {
    // Intentar crear la instancia
    await evolutionClient.post("/instance/create", {
      instanceName: String(localId),
      qrcode: true,
    });
  } catch (error: any) {
    // Si ya existe la instancia no es un error, seguimos
    const yaExiste = error.response?.data?.message
      ?.toLowerCase()
      .includes("already");
    if (!yaExiste) {
      return res.status(500).json({ error: "Error creando instancia" });
    }
  }

  try {
    // Obtener el QR
    const { data } = await evolutionClient.get(
      `/instance/qrcode/${localId}`,
      { params: { image: true } }
    );

    return res.json({
      qr: data.base64, // base64 que el frontend renderiza como imagen
    });
  } catch (error: any) {
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