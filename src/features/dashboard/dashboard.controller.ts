import { Request, Response } from "express";

import {
    getHistorialClientesService,
    getReporteMensualService,
    getResumenDiaService
} from "./dashboard.service";

export interface AuthRequest extends Request {
    user?: {
        userId: number;
        localId: number;
    };
}

export const getResumenDiaController =
    async (
        req: AuthRequest,
        res: Response
    ) => {

        try {

            const fecha = req.query.fecha as string;

            if (!fecha) {
                return res.status(400).json({
                    error: 'La fecha es requerida'
                });
            }

            const localId = req.user?.localId;
            if (!localId) {
                return res.status(401).json({ error: "No autorizado" });
            }

            const data =
                await getResumenDiaService(
                    fecha,
                    localId
                );

            res.json(data);

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    'Error al obtener resumen'
            });
        }
    };

export const getHistorialClientesController =
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

      const data =
        await getHistorialClientesService(
          localId
        );

      res.json(data);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Error al obtener clientes"
      });
    }
  };

  export const getReporteMensualController =
  async (
    req: AuthRequest,
    res: Response
  ) => {

    try {

      const localId =
        req.user?.localId;

      if (!localId) {

        return res.status(401).json({
          error: "No autorizado"
        });
      }

      const data =
        await getReporteMensualService(
          localId
        );

      res.json(data);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Error reporte mensual"
      });
    }
  };
