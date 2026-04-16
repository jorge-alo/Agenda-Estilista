import { Request, Response } from "express";
import * as servicioService from "./servicio.service";

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}


export const createServicio = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const { nombre, duracion, precio } = req.body;

    if (!nombre || !duracion || !localId || precio == null) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const id = await servicioService.createServicio(
      nombre,
      duracion,
      precio,
      localId
    );

    res.json({ message: "Servicio creado", id });
  } catch (error) {
    res.status(500).json({ error: "Error creando servicio" });
  }
};

export const getServicios = async (req: Request, res: Response) => {
  try {
    const { slug } = req.query;

    const servicios = await servicioService.getServiciosByLocal(
      slug as string
    );

    res.json(servicios);
  } catch (error) {
    res.status(500).json({ error: "Error obteniendo servicios" });
  }
};

export const getServiciosByLocalId = async (req: AuthRequest, res: Response) => {
  const localId = req.user?.localId;

  if (!localId) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const servicios = await servicioService.getServiciosAdminByLocalId(
      localId
    );

    res.json(servicios);
  } catch (error) {
    res.status(500).json({ error: "Error obteniendo servicios" });
  }
};



export const asignarServicio = async (req: Request, res: Response) => {
  try {
    const { estilista_id, servicio_id } = req.body;

    if (!estilista_id || !servicio_id) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    await servicioService.asignarServicioAEstilista(
      estilista_id,
      servicio_id
    );

    res.json({ message: "Servicio asignado al estilista" });
  } catch (error) {
    res.status(500).json({ error: "Error asignando servicio" });
  }
};

export const getServiciosPorEstilista = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const servicios = await servicioService.getServiciosByEstilista(
      Number(id)
    );

    res.json(servicios);
  } catch (error) {
    res.status(500).json({ error: "Error obteniendo servicios" });
  }
};

export const removeServicio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await servicioService.deleteServicio(Number(id));

    res.json({ message: "Servicio eliminado" });
  } catch (error: any) {
    if (error.message === "Tiene turnos asociados") {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Error eliminando servicio" });
  }
};

export const toggleServicio = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await servicioService.toggleServicio(Number(id));

    res.json({ message: "Estado actualizado" });
  } catch (error) {
    console.log("ERROR TOGGLE:", error); // 👈 CLAVE
    res.status(500).json({ error: "Error" });
  }
};

export const desasignarServicio = async (req: Request, res: Response) => {
  try {
    const { estilista_id, servicio_id } = req.body;

    if (!estilista_id || !servicio_id) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    await servicioService.desasignarServicio(estilista_id, servicio_id);

    res.json({ message: "Servicio desasignado" });
  } catch (error) {
    res.status(500).json({ error: "Error desasignando servicio" });
  }
};