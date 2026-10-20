// INT signed del catálogo. Sin coerción ni fallback para duraciones inválidas/NULL.
export function duracionBeautyValida(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
