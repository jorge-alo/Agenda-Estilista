import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import * as service from "./pet-servicios.service";
import { PetServicioError, validarDuracion, validarId } from "./pet-servicios.types";

function localDelJwt(req: AuthRequest): number {
  if (!req.user?.localId) throw new PetServicioError(401, "No autorizado");
  return req.user.localId;
}

function responderError(res: Response, error: unknown) {
  return res.status(error instanceof PetServicioError ? error.status : 500)
    .json({ error: error instanceof PetServicioError ? error.message : "Error gestionando servicios de mascota" });
}

export async function listarCatalogo(req: AuthRequest, res: Response) {
  try {
    return res.json(await service.listarCatalogo(localDelJwt(req)));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function listarConfigurados(req: AuthRequest, res: Response) {
  try {
    return res.json(await service.listarConfigurados(localDelJwt(req), validarId(req.params.mascotaId)));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function asignarServicio(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const mascotaId = validarId(req.params.mascotaId);
    const payload = validarDuracion(req.body, true);
    return res.status(201).json(await service.guardarConfiguracion(localId, mascotaId, payload.servicioId!, payload.duracionMinutos, true));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function editarDuracion(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const mascotaId = validarId(req.params.mascotaId);
    const servicioId = validarId(req.params.servicioId);
    const payload = validarDuracion(req.body);
    return res.json(await service.guardarConfiguracion(localId, mascotaId, servicioId, payload.duracionMinutos, false));
  } catch (error: unknown) { return responderError(res, error); }
}

export async function quitarServicio(req: AuthRequest, res: Response) {
  try {
    await service.quitarConfiguracion(localDelJwt(req), validarId(req.params.mascotaId), validarId(req.params.servicioId));
    return res.status(204).send();
  } catch (error: unknown) { return responderError(res, error); }
}
