// whatsapp.controller.ts
import { Request, Response } from "express";
import { evolutionClient } from "./infrastructure/evolution.client";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

export const conectarWhatsApp = async (req: AuthRequest, res: Response) => {
  const { localId } = req.params;
  const userLocalId = req.user?.localId;

  // 🔒 El localId de la URL debe coincidir con el del usuario logueado
  if (!userLocalId || Number(localId) !== userLocalId) {
    return res.status(403).json({ error: "No tenés permiso sobre este local" });
  }

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

    if (!yaExiste) {
      return res.status(500).json({
        error: "La API de WhatsApp no respondió a tiempo. Intentá de nuevo en unos segundos."
      });
    }

    console.log("⚠️ La instancia ya existía en Evolution API, continuamos para obtener el QR...");
  }

  try {
    const { data } = await evolutionClient.get(`/instance/connect/${localId}`);
    return res.json({ qr: data.base64 });
  } catch (error: any) {
    console.log("❌ Error obteniendo QR:", error.response?.data || error.message);
    return res.status(500).json({ error: "Error obteniendo QR" });
  }
};

export const estadoWhatsApp = async (req: AuthRequest, res: Response) => {
  const { localId } = req.params;
  const userLocalId = req.user?.localId;

  // 🔒 Mismo chequeo acá
  if (!userLocalId || Number(localId) !== userLocalId) {
    return res.status(403).json({ error: "No tenés permiso sobre este local" });
  }

  try {
    const { data } = await evolutionClient.get(`/instance/connectionState/${localId}`);
    const conectado = data.instance?.state === "open";
    return res.json({ conectado, estado: data.instance?.state });
  } catch (error: any) {
    return res.status(200).json({ conectado: false, estado: "close" });
  }
};