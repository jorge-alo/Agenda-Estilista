import { pool } from "../../config/db";
import { MercadoPagoConfig, Payment } from "mercadopago";

export const validarTokenMP = async (token: string): Promise<boolean> => {
  try {
    const client = new MercadoPagoConfig({ accessToken: token });
    const paymentClient = new Payment(client);

    // Intentamos obtener un pago inexistente.
    // Si el token es inválido → MP devuelve 401
    // Si el token es válido → MP devuelve 404 (pago no encontrado), lo cual está bien
    await paymentClient.get({ id: "0" });
    return true;
  } catch (error: any) {
    // 401 = token inválido
    if (error.status === 401 || error.statusCode === 401) {
      return false;
    }
    // Cualquier otro error (404, 500, etc.) = el token SÍ es válido
    return true;
  }
};

export const guardarTokenMP = async (localId: number, token: string) => {
  await pool.query(
    "UPDATE locales SET mp_access_token = ? WHERE id = ?",
    [token, localId]
  );
};

export const obtenerEstadoMP = async (localId: number) => {
  const [rows]: any = await pool.query(
    "SELECT mp_access_token FROM locales WHERE id = ?",
    [localId]
  );

  const configurado = !!rows[0]?.mp_access_token;

  return {
    configurado,
    // NO devolvemos el token completo por seguridad, solo los últimos 4 caracteres
    token_preview: configurado
      ? `****${rows[0].mp_access_token.slice(-4)}`
      : null,
  };
};