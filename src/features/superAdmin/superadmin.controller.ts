import { Request, Response } from "express";
import * as superadminService from "./superadmin.service";

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, nombreLocal, telefono } = req.body;
    const userId = await superadminService.registerUser(email, password, nombreLocal, telefono);
    res.json({ status: "Ok", message: "Usuario creado", userId });
  } catch (error: any) {
    if (error.message === "El email ya está registrado") {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "El email ya existe" });
    }
    res.status(500).json({ error: "Error interno" });
  }
};

export const getLocales = async (req: Request, res: Response) => {
  try {
    const locales = await superadminService.getAllLocales();
    res.json(locales);
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
};

export const getLocal = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const local = await superadminService.getLocalById(id);
    res.json(local);
  } catch (error: any) {
    if (error.message === "Local no encontrado") {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error interno" });
  }
};

export const toggleLocal = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const resultado = await superadminService.toggleLocalActivo(id);
    const mensaje = resultado.activo === 1 ? "Local activado" : "Local bloqueado";
    res.json({ message: mensaje, ...resultado });
  } catch (error: any) {
    if (error.message === "Local no encontrado") {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: "Error interno" });
  }
};

export const deleteLocal = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    await superadminService.deleteLocal(id);
    res.json({ message: "Local eliminado correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
};

