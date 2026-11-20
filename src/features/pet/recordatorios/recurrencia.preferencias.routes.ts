import { Router } from 'express';
import type { Response } from 'express';
import type { AuthRequest } from '../../../middlewares/auth.middleware';
import { authorizeRole } from '../../../middlewares/authorizeRole';
import { cambiarPreferenciaD30, validarCambioD30, PreferenciaD30Error } from './recurrencia.preferencias';

const router = Router();
router.patch('/responsables/:clienteId/recordatorios-d30', authorizeRole('admin'), async (req: AuthRequest, res: Response) => {
  const localId: unknown = req.user?.localId;
  const operadorId: unknown = req.user?.userId;
  const id = req.params.clienteId;
  if (typeof localId !== 'number' || !Number.isSafeInteger(localId) || localId < 1
    || typeof operadorId !== 'number' || !Number.isSafeInteger(operadorId) || operadorId < 1) {
    return res.status(401).json({ error: 'PET_D30_UNAUTHORIZED' });
  }
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return res.status(400).json({ error: 'PET_D30_INVALID' });
  try {
    return res.json(await cambiarPreferenciaD30(localId, Number(id), operadorId, validarCambioD30(req.body)));
  } catch (error: unknown) {
    if (error instanceof PreferenciaD30Error) return res.status(error.status).json({ error: error.code });
    return res.status(500).json({ error: 'PET_D30_WRITE_FAILED' });
  }
});
export default router;
