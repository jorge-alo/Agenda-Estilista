import type { NextFunction, Request, Response } from "express";
import { requestPetAccess } from "./session.service";
import { PetSessionRequestError } from "./session.types";

export async function requestAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const slug = req.params.slug;
    if (typeof slug !== "string") throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
    await requestPetAccess(slug, req.body);
    res.status(202).json({ ok: true });
  } catch (error: unknown) {
    if (error instanceof PetSessionRequestError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error); // PET-11C.1.1 logs only safe metadata, never the raw SQL/parser error.
  }
}
