export const sumarMinutos = (hora: string, minutos: number) => {
  const partes = hora.slice(0, 5).split(":").map(Number); // ← solo "HH:MM"

  const h = partes[0];
  const m = partes[1];

  const fecha = new Date();
  fecha.setHours(h, m + minutos, 0);

  return fecha.toTimeString().slice(0, 5); // ← "HH:MM"
};