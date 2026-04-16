import { Request, Response } from "express";
import * as turnoService from "../public/public.service";

export const reservar = async (req: Request, res: Response) => {
  try {
    const {
      slug,
      fecha,
      hora,
      estilista_id,
      servicio_id,
      cliente_nombre,
      cliente_telefono,
    } = req.body;

    const turno = await turnoService.createTurnoPublico({
      slug,
      fecha,
      hora,
      estilista_id,
      servicio_id,
      cliente_nombre,
      cliente_telefono,
    });

    res.json({ message: "Turno reservado", telefono: turno.telefono });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};