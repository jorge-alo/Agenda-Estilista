import { Request, Response } from "express";
import * as turnoService from "./disponibilidad.service"

export const disponibilidad = async (req: Request, res: Response) => {
  try {
    const { slug, fecha, servicio_id  } = req.query;
console.log("Valor de slug fecha y servicio_id", `${slug}, ${fecha}, ${servicio_id}`)
    const data = await turnoService.getDisponibilidad(
      slug as string,
      fecha as string,
      Number(servicio_id)
    );

    res.json(data);
  } catch (error) {
    res.status(400).json({ error: "Error" });
  }
};