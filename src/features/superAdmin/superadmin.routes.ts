import { Router } from "express";
import { register,
  getLocales,
  getLocal,
  toggleLocal,
  deleteLocal, } from "./superadmin.controller";
import { authorizeRole } from "../../middlewares/authorizeRole";
import { authMiddleware } from "../../middlewares/auth.middleware";

const routerSuperAdmin = Router();
const superadminGuard = [authMiddleware, authorizeRole("superadmin")]
// Solo superadmin puede crear nuevos locales/admins
routerSuperAdmin.post( "/register", authMiddleware, authorizeRole("superadmin"), register
);

routerSuperAdmin.get("/locales", ...superadminGuard, getLocales);
routerSuperAdmin.get("/locales/:id", ...superadminGuard, getLocal);
routerSuperAdmin.patch("/locales/:id/toggle", ...superadminGuard, toggleLocal);
routerSuperAdmin.delete("/locales/:id", ...superadminGuard, deleteLocal);

export default routerSuperAdmin;