// whatsapp.controller.ts
import { Request, Response } from "express";
import { evolutionClient } from "./infrastructure/evolution.client";
import { buildEvolutionInstancePayload } from "./infrastructure/evolution.contract";
import { logEvolutionFailure } from "./infrastructure/evolution.logging";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existingInstanceStatus(error: unknown, instanceName: string): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  const { status, data } = error.response;
  if (status !== 400 && status !== 403) return undefined;
  if (!isRecord(data) || !isRecord(data.response)) return undefined;
  const message = data.response.message;
  const messages: unknown[] = Array.isArray(message) ? message : [message];
  // Both supported releases use this message. Never infer a duplicate from status alone.
  return messages.length === 1 && messages[0] === `This name "${instanceName}" is already in use.`
    ? status : undefined;
}

export const conectarWhatsApp = async (req: AuthRequest, res: Response) => {
  const { localId } = req.params;
  const userLocalId = req.user?.localId;

  // 🔒 El localId de la URL debe coincidir con el del usuario logueado
  if (!userLocalId || Number(localId) !== userLocalId) {
    return res.status(403).json({ error: "No tenés permiso sobre este local" });
  }

  try {
    await evolutionClient.post("/instance/create", buildEvolutionInstancePayload(String(localId)));
  } catch (error: unknown) {
    logEvolutionFailure("createInstance", String(localId), error);

    const status = existingInstanceStatus(error, String(localId));

    if (status === undefined) {
      return res.status(500).json({
        error: "La API de WhatsApp no respondió a tiempo. Intentá de nuevo en unos segundos."
      });
    }

    console.info("Evolution instance already exists; continuing connection", {
      provider: "evolution",
      operation: "createInstance",
      instance: /^\d{1,10}$/.test(String(localId)) ? String(localId) : "unknown",
      status,
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
