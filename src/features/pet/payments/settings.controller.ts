import type { NextFunction, Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./settings.service";
import { PetDepositSettingsError, validarPayload } from "./settings.types";

function localDelJwt(req: AuthRequest): number {
  const id: unknown = req.user?.localId;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    throw new PetDepositSettingsError(401, "No autorizado");
  }
  return id;
}

// Debe ejecutarse antes de requirePetBusiness, cuyo 404 para IDs inválidos
// se conserva en las demás rutas PET.
export function validarLocalContext(req: AuthRequest, res: Response, next: NextFunction) {
  try { localDelJwt(req); next(); }
  catch { res.status(401).json({ error: "No autorizado" }); }
}

function errorHttp(res: Response, error: unknown) {
  if (error instanceof PetDepositSettingsError) {
    return res.status(error.status).json({ error: error.code });
  }
  return res.status(500).json({ error: "Error interno" });
}

export async function obtener(req: AuthRequest, res: Response) {
  res.set("Cache-Control", "no-store");
  try { return res.json(await service.obtener(localDelJwt(req))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function guardar(req: AuthRequest, res: Response) {
  res.set("Cache-Control", "no-store");
  try { return res.json(await service.guardar(localDelJwt(req), validarPayload(req.body))); }
  catch (error: unknown) { return errorHttp(res, error); }
}
