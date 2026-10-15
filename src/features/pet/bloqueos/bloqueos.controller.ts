import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./bloqueos.service";
import { BloqueoError, validarId, validarPayload, validarRango } from "./bloqueos.types";

function localDelJwt(req: AuthRequest): number {
  const id: unknown = req.user?.localId;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647) throw new BloqueoError(401, "No autorizado");
  return id;
}

function errorHttp(res: Response, error: unknown) {
  return res.status(error instanceof BloqueoError ? error.status : 500)
    .json({ error: error instanceof BloqueoError ? error.message : "Error gestionando bloqueos PET" });
}

export async function listar(req: AuthRequest, res: Response) {
  try { return res.json(await service.listar(localDelJwt(req), validarRango(req.query))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function crear(req: AuthRequest, res: Response) {
  try { return res.status(201).json(await service.guardar(localDelJwt(req), validarPayload(req.body, true))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function editar(req: AuthRequest, res: Response) {
  try { return res.json(await service.guardar(localDelJwt(req), validarPayload(req.body, false), validarId(req.params.bloqueoId))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function eliminar(req: AuthRequest, res: Response) {
  try {
    await service.eliminar(localDelJwt(req), validarId(req.params.bloqueoId));
    return res.status(204).send();
  } catch (error: unknown) { return errorHttp(res, error); }
}
