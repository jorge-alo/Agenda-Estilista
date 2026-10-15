import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./horarios.service";
import { HorarioError, validarId, validarPayload } from "./horarios.types";

function localDelJwt(req: AuthRequest): number {
  const id: unknown = req.user?.localId;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647) throw new HorarioError(401, "No autorizado");
  return id;
}

function errorHttp(res: Response, error: unknown) {
  return res.status(error instanceof HorarioError ? error.status : 500)
    .json({ error: error instanceof HorarioError ? error.message : "Error gestionando horarios PET" });
}

export async function listar(req: AuthRequest, res: Response) {
  try { return res.json(await service.listar(localDelJwt(req))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function crear(req: AuthRequest, res: Response) {
  try { return res.status(201).json(await service.guardar(localDelJwt(req), validarPayload(req.body, true))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function editar(req: AuthRequest, res: Response) {
  try { return res.json(await service.guardar(localDelJwt(req), validarPayload(req.body, false), validarId(req.params.horarioId))); }
  catch (error: unknown) { return errorHttp(res, error); }
}

export async function eliminar(req: AuthRequest, res: Response) {
  try {
    await service.eliminar(localDelJwt(req), validarId(req.params.horarioId));
    return res.status(204).send();
  } catch (error: unknown) { return errorHttp(res, error); }
}
