import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./extras.service";
import {
  PetExtraError, enteroPositivo, validarId, validarCrearExtra,
  validarEditarExtra, validarAsociacion, validarDuracion,
} from "./extras.types";

function localDelJwt(req: AuthRequest): number {
  const localId: unknown = req.user?.localId;
  if (!enteroPositivo(localId)) throw new PetExtraError(401, "No autorizado");
  return localId;
}

function responderError(res: Response, error: unknown) {
  return res.status(error instanceof PetExtraError ? error.status : 500)
    .json({ error: error instanceof PetExtraError ? error.message : "Error gestionando extras" });
}

export async function listarCatalogo(req: AuthRequest, res: Response) {
  try {
    return res.json(await service.listarCatalogo(localDelJwt(req)));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function crearExtra(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const payload = validarCrearExtra(req.body);
    return res.status(201).json(await service.crearExtra(localId, payload.nombre));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function editarExtra(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const extraId = validarId(req.params.extraId);
    const payload = validarEditarExtra(req.body);
    return res.json(await service.editarExtra(localId, extraId, payload));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function eliminarExtra(req: AuthRequest, res: Response) {
  try {
    await service.eliminarExtra(localDelJwt(req), validarId(req.params.extraId));
    return res.status(204).send();
  } catch (error: unknown) { return responderError(res, error); }
}

export async function listarConfigurados(req: AuthRequest, res: Response) {
  try {
    return res.json(await service.listarConfigurados(localDelJwt(req), validarId(req.params.mascotaId)));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function asignarExtra(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const mascotaId = validarId(req.params.mascotaId);
    const payload = validarAsociacion(req.body);
    return res.status(201).json(await service.guardarConfiguracion(localId, mascotaId, payload.extraId, payload.duracionMinutos, true));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function editarDuracion(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const mascotaId = validarId(req.params.mascotaId);
    const extraId = validarId(req.params.extraId);
    const payload = validarDuracion(req.body);
    return res.json(await service.guardarConfiguracion(localId, mascotaId, extraId, payload.duracionMinutos, false));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function quitarExtra(req: AuthRequest, res: Response) {
  try {
    await service.quitarConfiguracion(localDelJwt(req), validarId(req.params.mascotaId), validarId(req.params.extraId));
    return res.status(204).send();
  } catch (error: unknown) { return responderError(res, error); }
}
