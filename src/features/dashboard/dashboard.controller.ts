import { Request, Response } from "express";

import {
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