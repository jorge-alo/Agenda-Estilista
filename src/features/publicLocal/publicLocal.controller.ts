import type { Request, Response } from "express";
import { obtenerContextoPublico, PublicLocalError } from "./publicLocal.service";

export async function obtenerContextoLocal(req: Request, res: Response) {
  const slug = req.params.slug;
  if (typeof slug !== "string" || !slug || slug.length > 100) {
    return res.status(404).json({ code: "LOCAL_NOT_FOUND" });
  }

  try {
    return res.json(await obtenerContextoPublico(slug));
  } catch (error) {
    if (error instanceof PublicLocalError) return res.status(error.status).json({ code: error.code });
    return res.status(500).json({ code: "PUBLIC_LOCAL_LOOKUP_FAILED" });
  }
}
