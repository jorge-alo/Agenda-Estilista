import { Request, Response } from "express";
import { AuthRequest } from "../../../middlewares/auth.middleware";
import * as service from "./solicitudes.service";
import { SolicitudError, validarCambio, validarCrear, validarFiltro, validarId } from "./solicitudes.types";

function errorResponse(error: unknown, res: Response): Response {
  if (error instanceof SolicitudError) return res.status(error.status).json({ error: error.code });
  return res.status(500).json({ error: "Error procesando solicitud PET" });
}

export async function crear(req: Request, res: Response) {
  try {
    const slug = req.params.slug;
    if (typeof slug !== "string" || !slug || slug.length > 100) throw new SolicitudError(404, "PET_LOCAL_NOT_FOUND");
    const localId = await service.resolverLocal(slug);
    const data = validarCrear(req.body);
    await service.crear(localId, data);
    return res.status(201).json({ ok: true });
  } catch (error) { return errorResponse(error, res); }
}

export async function listar(req: AuthRequest, res: Response) {
  try {
    const localId = req.user?.localId;
    if (!Number.isSafeInteger(localId) || localId <= 0) return res.status(401).json({ error: "No autorizado" });
    const estado = validarFiltro(req.query);
    return res.json(await service.listar(localId, estado));
  } catch (error) { return errorResponse(error, res); }
}

export async function cambiarEstado(req: AuthRequest, res: Response) {
  try {
    const localId = req.user?.localId;
    if (!Number.isSafeInteger(localId) || localId <= 0) return res.status(401).json({ error: "No autorizado" });
    const id = validarId(req.params.id);
    const estado = validarCambio(req.body);
    await service.cambiarEstado(localId, id, estado);
    return res.json({ ok: true });
  } catch (error) { return errorResponse(error, res); }
}

export async function convertir(req: AuthRequest, res: Response) {
  try {
    const localId = req.user?.localId;
    if (!Number.isSafeInteger(localId) || localId <= 0) return res.status(401).json({ error: "No autorizado" });
    const id = validarId(req.params.id);
    const resultado = await service.convertir(localId, id, req.body);
    return res.status(201).json(resultado);
  } catch (error) { return errorResponse(error, res); }
}
