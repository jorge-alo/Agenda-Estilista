import type { NextFunction, Request, Response } from "express";
import { isCanonicalOpaqueSecret } from "./opaqueSecret";
import { findPetPublicSession } from "./session.service";

export function parsePetSessionBearer(req: Pick<Request, "headers" | "rawHeaders">): string | null {
  let occurrences = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "authorization") occurrences++;
  }
  if (occurrences !== 1 || typeof req.headers.authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
  if (!match || !isCanonicalOpaqueSecret(match[1])) return null;
  // exec's '$' may match before a final newline: the whole header must match too.
  if (match[0] !== req.headers.authorization) return null;
  return match[1];
}

export async function petPublicSessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  const secret = parsePetSessionBearer(req);
  const slug = req.params.slug;
  if (!secret || typeof slug !== "string") {
    res.status(401).json({ error: "PET_SESSION_INVALID" });
    return;
  }
  try {
    const session = await findPetPublicSession(slug, secret);
    if (!session) {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    req.petSession = session;
    next();
  } catch (error: unknown) { next(error); }
}
