import { Response } from "express";
import { AuthRequest }
  from "../../middlewares/auth.middleware";

import {
  obtenerClientesService
} from "./clientes.service";

export const obtenerClientesController =
  async (
    req: AuthRequest,
    res: Response
  ) => {

    try {

      const localId = req.user?.localId;

      if (!localId) {
        return res.status(401).json({
          error: "No autorizado"
        });
      }

      const clientes =
        await obtenerClientesService(localId);

      res.json(clientes);

    } catch (error) {

      res.status(500).json({
        error: "Error obteniendo clientes"
      });

    }
  };