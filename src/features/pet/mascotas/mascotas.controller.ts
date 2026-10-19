import { Response } from "express";
import { InvalidClientPhoneError } from "../../../shared/phone/normalizeClientPhone";
import { ClientPhoneConflictError } from "../../../shared/phone/clientPhoneDuplicate";
import { AuthRequest } from "../../../middlewares/auth.middleware";
import {
  validarCrearMascota,
  validarEditarMascota,
  validarAsociarResponsable,
  validarCrearResponsable,
  validarReservaOnline,
  validarBusquedaMascotas,
  MascotaSearchError,
} from "./mascotas.types";
import * as petService from "./mascotas.service";

export const crearMascota = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const validation = validarCrearMascota(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.errores.join(", ") });
    }

    const mascota = await petService.crearMascota(localId, validation.data!);
    return res.status(201).json(mascota);
  } catch (error: any) {
    return res.status(500).json({ error: "Error creando mascota" });
  }
};

export const listarMascotas = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const mascotas = await petService.listarMascotas(localId);
    return res.json(mascotas);
  } catch (error: any) {
    return res.status(500).json({ error: "Error listando mascotas" });
  }
};

export const buscarMascotas = async (req: AuthRequest, res: Response) => {
  const localId: unknown = req.user?.localId;
  if (typeof localId !== "number" || !Number.isSafeInteger(localId) || localId < 1 || localId > 2147483647) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const query = validarBusquedaMascotas(req.query);
    return res.json(await petService.buscarMascotas(localId, query));
  } catch (error: unknown) {
    if (error instanceof MascotaSearchError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "Error buscando mascotas" });
  }
};

export const obtenerMascota = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const mascotaId = parseInt(req.params.id as string, 10);
    if (isNaN(mascotaId)) {
      return res.status(400).json({ error: "ID de mascota inválido" });
    }

    const mascota = await petService.obtenerMascotaConResponsables(localId, mascotaId);
    if (!mascota) {
      return res.status(404).json({ error: "Mascota no encontrada" });
    }

    return res.json(mascota);
  } catch (error: any) {
    return res.status(500).json({ error: "Error obteniendo mascota" });
  }
};

export const editarMascota = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const mascotaId = parseInt(req.params.id as string, 10);
    if (isNaN(mascotaId)) {
      return res.status(400).json({ error: "ID de mascota inválido" });
    }

    const validation = validarEditarMascota(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.errores.join(", ") });
    }

    const mascota = await petService.editarMascota(localId, mascotaId, validation.data!);
    return res.json(mascota);
  } catch (error: any) {
    if (error.message === "No hay campos para actualizar") {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === "Mascota no encontrada o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Error editando mascota" });
  }
};

export const editarReservaOnline = async (req: AuthRequest, res: Response) => {
  const localId = req.user?.localId;
  if (!Number.isSafeInteger(localId) || localId < 1) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const rawId = req.params.id;
  if (typeof rawId !== "string" || !/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) > 2147483647) {
    return res.status(400).json({ error: "ID de mascota inválido" });
  }

  const validation = validarReservaOnline(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.errores.join(", ") });

  try {
    const result = await petService.editarReservaOnline(localId, Number(rawId), validation.data!);
    return res.json(result);
  } catch (error: unknown) {
    if (error instanceof petService.MascotaReservaOnlineError) {
      return res.status(error.status).json({ error: error.code });
    }
    return res.status(500).json({ error: "Error actualizando habilitación de reserva online" });
  }
};

export const crearResponsable = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const validation = validarCrearResponsable(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.errores.join(", ") });
    }

    const responsable = await petService.crearResponsable(localId, validation.data!);
    return res.status(responsable.isNew ? 201 : 200).json(responsable);
  } catch (error: any) {
    if (error instanceof InvalidClientPhoneError) return res.status(400).json({ error: error.code });
    if (error instanceof ClientPhoneConflictError) return res.status(409).json({ error: error.code });
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "El teléfono ya existe en este local" });
    }
    return res.status(500).json({ error: "Error creando responsable" });
  }
};

export const asociarResponsable = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const mascotaId = parseInt(req.params.mascotaId as string, 10);
    if (isNaN(mascotaId)) {
      return res.status(400).json({ error: "ID de mascota inválido" });
    }

    const validation = validarAsociarResponsable(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.errores.join(", ") });
    }

    await petService.asociarResponsable(localId, mascotaId, validation.data!);
    return res.status(201).json({ message: "Responsable asociado correctamente" });
  } catch (error: any) {
    if (error.message === "Mascota no encontrada o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === "Cliente no encontrado o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === "El responsable ya está asociado a esta mascota") {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: "Error asociando responsable" });
  }
};

export const desasociarResponsable = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const mascotaId = parseInt(req.params.mascotaId as string, 10);
    const clienteId = parseInt(req.params.clienteId as string, 10);

    if (isNaN(mascotaId) || isNaN(clienteId)) {
      return res.status(400).json({ error: "IDs inválidos" });
    }

    await petService.desasociarResponsable(localId, mascotaId, clienteId);
    return res.json({ message: "Responsable desasociado correctamente" });
  } catch (error: any) {
    if (error.message === "Asociación no encontrada o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Error desasociando responsable" });
  }
};
