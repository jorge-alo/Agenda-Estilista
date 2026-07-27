import { Request, Response } from "express";
import * as estilistaService from "./estilistas.service";
export interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

export const create = async (req: AuthRequest, res: Response) => {
  try {
    const { nombre } = req.body;
    
    if (!nombre) {
      return res.status(400).json({ error: "Nombre requerido" });
    }
    // ⚠️ después lo vamos a sacar del token
    const localId = req.user?.localId;

    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const id = await estilistaService.createEstilista(nombre, localId);

    res.json({ message: "Estilista creado", id });
  } catch (error) {
    res.status(500).json({ error: "Error al crear estilista" });
  }
};

export const getEstilistas = async (req: Request, res: Response) => {
  try {
    const { slug } = req.query;

    const estilistas = await estilistaService.getEstilistasByLocal(
      slug as string
    );

    res.json(estilistas);
  } catch {
    res.status(500).json({ error: "Error" });
  }
};
export const getEstilistasAdmin = async (req: AuthRequest, res: Response) => {
    try {
        const localId = req.user?.localId;
      console.log("Valor de localID", localId);
        if (!localId) {
            return res.status(401).json({ error: "No autorizado" });
        }

        const estilistas = await estilistaService.getEstilistasByLocalId(localId);

        res.json(estilistas);
    } catch {
        res.status(500).json({ error: "Error" });
    }
};

export const update = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { nombre } = req.body;
    const localId = req.user?.localId;

    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    if (!nombre) {
      return res.status(400).json({ error: "Nombre requerido" });
    }

    await estilistaService.updateEstilista(Number(id), nombre, localId);

    res.json({ message: "Estilista actualizado" });
  } catch (error: any) {
    if (error.message === "Estilista no encontrado o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error al actualizar estilista" });
  }
};

export const remove = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const localId = req.user?.localId;

    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    await estilistaService.deleteEstilista(Number(id), localId);

    res.json({ message: "Estilista eliminado" });
  } catch (error: any) {
    if (error.message === "Tiene turnos activos futuros") {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === "Estilista no encontrado o no pertenece a tu local") {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error al eliminar estilista" });
  }
};