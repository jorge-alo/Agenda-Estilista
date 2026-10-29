import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./settings.service";
import { PetSettingsError, validarPayload } from "./settings.types";

function localDelJwt(req: AuthRequest): number {
  const id: unknown = req.user?.localId;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    throw new PetSettingsError(401, "No autorizado");
  }
  return id;
}

function errorHttp(res: Response, error: unknown) {
  return res.status(error instanceof PetSettingsError ? error.status : 500)
    .json({ error: error instanceof PetSettingsError ? error.message : "Error gestionando settings PET" });
}

export async function obtener(req: AuthRequest, res: Response) {
  try {
    return res.json(await service.obtener(localDelJwt(req)));
  } catch (error: unknown) {
    return errorHttp(res, error);
  }
}

export async function guardar(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const payload = validarPayload(req.body);
    return res.json(await service.guardar(localId, payload));
  } catch (error: unknown) {
    return errorHttp(res, error);
  }
}

export async function guardarCapacidad(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    return res.json(await service.guardarCapacidad(localId, req.body));
  } catch (error: unknown) {
    return errorHttp(res, error);
  }
}
