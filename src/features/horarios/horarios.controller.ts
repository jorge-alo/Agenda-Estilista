import { Request, Response } from "express";
import * as horarioService from "./horarios.service";

export const createHorario = async (req: Request, res: Response) => {
  try {
    const { estilista_id, dia_semana, hora_inicio, hora_fin } = req.body;

    if (!estilista_id || dia_semana === undefined || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const id = await horarioService.createHorario(
      estilista_id,
      dia_semana,
      hora_inicio,
      hora_fin
    );

    res.json({ message: "Horario creado", id });
  } catch (error) {
    res.status(500).json({ error: "Error creando horario" });
  }
};

export const getHorarios = async (req: Request, res: Response) => {
  try {
    const { estilista_id } = req.params;

    const data = await horarioService.getHorariosByEstilista(
      Number(estilista_id)
    );

    res.json(data);
  } catch {
    res.status(500).json({ error: "Error" });
  }
};

export const deleteHorario = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await horarioService.desactivarHorario(Number(id));

    res.json({ message: "Horario desactivado" });
  } catch {
    res.status(500).json({ error: "Error eliminando horario" });
  }
};

export const toggle = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await horarioService.toggleHorario(Number(id));

    res.json({ message: "Horario actualizado" });
  } catch {
    res.status(500).json({ error: "Error" });
  }
};