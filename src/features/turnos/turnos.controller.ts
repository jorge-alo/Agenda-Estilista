import { Request, Response } from "express";
import * as turnoService from "./turnos.service";
export interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

export const create = async (req: AuthRequest, res: Response) => {
  try {
    const turnoId = await turnoService.createTurno(req.body);

    res.json({ message: "Turno creado", turnoId });
  } catch (error: any) {
    if (error.message === "Ese horario ya está ocupado") {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Error al crear turno" });
  }
};

export const reprogramar = async (req: AuthRequest, res: Response) => {
  try {
     const { id } = req.params; // 🔥 sacar el id de la URL
     console.log("Valor de req.body", req.body);
    const turnoId = await turnoService.reprogramarTurno({id: Number(id), ...req.body});

    res.json({ message: "Turno reprogramado", turnoId });
  } catch (error: any) {
    if (error.message === "Ese horario ya está ocupado") {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Error al reprogramar turno" });
  }
};

export const getByFechaAdmin = async (req: AuthRequest, res: Response) => {
  try {
    const { fecha } = req.query;

    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }


    const turnos = await turnoService.getTurnosByFecha(
      fecha as string,
      localId
    );

    res.json(turnos);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener turnos" });
  }
};

export const getByFechaPublico = async (req: Request, res: Response) => {
  try {
    const { fecha, slug } = req.query;

    const turnos = await turnoService.getTurnosByFechaPublico(
      fecha as string,
      slug as string
    );

    res.json(turnos);
  } catch {
    res.status(500).json({ error: "Error" });
  }
};


export const disponibilidad = async (
  req: Request,
  res: Response
) => {

  try {

    const {
      slug,
      fecha,
      estilista_id,
      servicio_id
    } = req.query;

    // 🔥 VALIDACIÓN
    if (
      !slug ||
      !fecha ||
      !estilista_id ||
      !servicio_id
    ) {

      return res.status(400).json({
        error: "Faltan parámetros"
      });
    }

    const data =
      await turnoService.getDisponibilidad(
        slug as string,
        fecha as string,
        Number(estilista_id),
        Number(servicio_id)
      );

    res.json(data);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: "Error interno"
    });
  }
};

export const disponibilidadAdmin = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const { fecha, estilista_id, servicio_id } = req.query;
    console.log("Valor de slug fecha estilista_id y servicio_id", `${localId}, ${fecha}, ${estilista_id} ${servicio_id}`)
    const data = await turnoService.getDisponibilidadAdmin(
      localId,
      fecha as string,
      Number(estilista_id),
      Number(servicio_id)
    );

    res.json(data);
  } catch (error) {
    res.status(400).json({ error: "Error" });
  }
};

export const cancelar = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await turnoService.cancelarTurno(Number(id));

    res.json({ message: "Turno cancelado" });
  } catch {
    res.status(500).json({ error: "Error cancelando turno" });
  }
};

export const getTurnosFuturos = async (req: AuthRequest, res: Response) => {
    try {
        const localId = req.user?.localId;

        if (!localId) {
            return res.status(401).json({ error: "No autorizado" });
        }

        const turnos = await turnoService.getTurnosFuturos(localId);

        res.json(turnos);
    } catch {
        res.status(500).json({ error: "Error obteniendo turnos" });
    }
};

export const completar = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await turnoService.completarTurno(Number(id));
        res.json({ message: "Turno completado" });
    } catch {
        res.status(500).json({ error: "Error completando turno" });
    }
};

export const createAdmin = async (req: AuthRequest, res: Response) => {
    try {
        const localId = req.user?.localId;

        if (!localId) {
            return res.status(401).json({ error: "No autorizado" });
        }

        const turnoId = await turnoService.createTurno({
            ...req.body,
            local_id: localId // 🔥 saca el localId del token
        });

        res.json({ message: "Turno creado", turnoId });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
};

export const getByRangoAdmin = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user?.localId;
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const { desde, hasta } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({ error: "Parámetros desde y hasta requeridos" });
    }

    const turnos = await turnoService.getTurnosByRango(
      desde as string,
      hasta as string,
      localId
    );

    res.json(turnos);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener turnos" });
  }
};
