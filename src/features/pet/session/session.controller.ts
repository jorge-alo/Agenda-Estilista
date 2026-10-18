import type { NextFunction, Request, Response } from "express";
import { consumePetAccess, getPetSessionMe, logoutPetPublicSession, requestPetAccess } from "./session.service";
import { parsePetSessionBearer } from "./petPublicSession.middleware";
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

export async function consumeAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const slug = req.params.slug;
    if (typeof slug !== "string") throw new PetSessionRequestError(401, "PET_ACCESS_INVALID");
    const consumed = await consumePetAccess(slug, req.body);
    res.status(201).json(consumed);
  } catch (error: unknown) {
    if (error instanceof PetSessionRequestError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error);
  }
}

export async function getSessionMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const context = req.petSession;
    if (!context) {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    const result = await getPetSessionMe(context);
    if (!result) {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    res.status(200).json(result);
  } catch (error: unknown) { next(error); }
}

export async function logoutSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  const secret = parsePetSessionBearer(req);
  if (!secret) {
    res.status(401).json({ error: "PET_SESSION_INVALID" });
    return;
  }
  try {
    const slug = req.params.slug;
    if (typeof slug !== "string") throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
    await logoutPetPublicSession(slug, secret);
    res.status(204).end();
  } catch (error: unknown) {
    if (error instanceof PetSessionRequestError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error);
  }
}
