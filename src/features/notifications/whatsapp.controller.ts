// whatsapp.controller.ts
import { Request, Response } from "express";
import { evolutionClient } from "./infrastructure/evolution.client";
import { logEvolutionFailure } from "./infrastructure/evolution.logging";

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
  } catch (error: unknown) {
    logEvolutionFailure("createInstance", String(localId), error);

    const existingError = error as { response?: { data?: { response?: { message?: unknown } }; status?: number } };
    const responseMessage = existingError.response?.data?.response?.message;
    const mensaje = Array.isArray(responseMessage)
      ? responseMessage[0]
      : typeof responseMessage === "string" ? responseMessage : undefined;
    const yaExiste = (typeof mensaje === "string" && mensaje.toLowerCase().includes("already in use")) || existingError.response?.status === 400;

    if (!yaExiste) {
      return res.status(500).json({
        error: "La API de WhatsApp no respondió a tiempo. Intentá de nuevo en unos segundos."
      });
    }

    console.info("Evolution instance already exists; continuing connection", {
      provider: "evolution",
      operation: "createInstance",
      instance: /^\d{1,10}$/.test(String(localId)) ? String(localId) : "unknown",
      status: existingError.response?.status,
    });
  }

  try {
    const { data } = await evolutionClient.get(`/instance/connect/${localId}`);
    return res.json({ qr: data.base64 });
  } catch (error: unknown) {
    logEvolutionFailure("connectInstance", String(localId), error);
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
