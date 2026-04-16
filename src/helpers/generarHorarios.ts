import { sumarMinutos } from "./sumarMinutos";

export const generarHorarios = (inicio: string, fin: string) => {
  const horarios: string[] = [];
  let actual = inicio;

  while (actual < fin) {
    horarios.push(actual);
    actual = sumarMinutos(actual, 30);
  }

  return horarios;
};