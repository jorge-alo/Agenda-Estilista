import { Request, Response } from "express";
import * as horarioService from "./horarios.service";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

export const createHorario = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const { estilista_id, dia_semana, hora_inicio, hora_fin } = req.body;

    if (!estilista_id || dia_semana === undefined || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const id = await horarioService.createHorario(
      estilista_id,
      dia_semana,
      hora_inicio,
      hora_fin,
      localId
    );

    res.json({ message: "Horario creado", id });
  } catch (error: any) {
    if (error.message.includes("no pertenece")) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error creando horario" });
  }
};

export const getHorarios = async (req: Request, res: Response) => {
  try {
    const { estilista_id } = req.params;
    const data = await horarioService.getHorariosByEstilista(Number(estilista_id));
    res.json(data);
  } catch {
    res.status(500).json({ error: "Error" });
  }
};

export const deleteHorario = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    await horarioService.desactivarHorario(Number(id), localId);

    res.json({ message: "Horario desactivado" });
  } catch (error: any) {
    if (error.message.includes("no pertenece")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error eliminando horario" });
  }
};

export const toggle = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    await horarioService.toggleHorario(Number(id), localId);

    res.json({ message: "Horario actualizado" });
  } catch (error: any) {
    if (error.message.includes("no pertenece")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error" });
  }
};