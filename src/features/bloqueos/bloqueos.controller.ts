import { Request, Response } from "express";

import {
  crearBloqueoService,
  obtenerBloqueosService
} from "./bloqueos.service";

interface AuthRequest extends Request {
  user?: {
    userId: number;
    localId: number;
  };
}

export const crearBloqueoController =
  async (
    req: AuthRequest,
    res: Response
  ) => {

    try {

      const localId = req.user?.localId;

      if (!localId) {
        return res
          .status(401)
          .json({
            error: "No autorizado"
          });
      }

      const {
        estilista_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo
      } = req.body;

      await crearBloqueoService({
        local_id: localId,
        estilista_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo
      });

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Error creando bloqueo"
      });
    }
  };

export const obtenerBloqueosController =
  async (
    req: AuthRequest,
    res: Response
  ) => {

    try {

      const localId = req.user?.localId;

      if (!localId) {
        return res
          .status(401)
          .json({
            error: "No autorizado"
          });
      }

      const fecha = req.query.fecha as string;

      const bloqueos =
        await obtenerBloqueosService(
          localId,
          fecha
        );

      res.json(bloqueos);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Error obteniendo bloqueos"
      });
    }
  };