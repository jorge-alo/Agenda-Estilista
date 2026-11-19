import { fechaPetValida } from "../disponibilidad/disponibilidad.types";
import { ventanaRecordatorioPet } from "./recordatorios.time";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function sumarDiasCalendarioPet(fecha: string, dias: number): string {
  if (!fechaPetValida(fecha) || !Number.isSafeInteger(dias)) {
    throw new Error("PET_RECURRENCE_DATE_INVALID");
  }
  // UTC is only a calendar arithmetic carrier: fecha is NOT a UTC service instant.
  const date = new Date(`${fecha}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dias);
  if (!Number.isFinite(date.getTime())) throw new Error("PET_RECURRENCE_DATE_INVALID");
  const result = date.toISOString().slice(0, 10);
  if (!fechaPetValida(result)) throw new Error("PET_RECURRENCE_DATE_INVALID");
  return result;
}

export function fechasRecurrenciaPet(d0: string) {
  return { d0, d30: sumarDiasCalendarioPet(d0, 30), d35: sumarDiasCalendarioPet(d0, 35) };
}

export function contextoRecurrenciaPet(ahoraUtc: Date) {
  if (!Number.isFinite(ahoraUtc.getTime())) throw new Error("PET_RECURRENCE_CLOCK_INVALID");
  const parts = Object.fromEntries(formatter.formatToParts(ahoraUtc)
    .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const hoyArgentina = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    hoyArgentina,
    horaArgentina: `${parts.hour}:${parts.minute}:${parts.second}`,
    fechaServicioD30: sumarDiasCalendarioPet(hoyArgentina, -30),
    enVentana: ventanaRecordatorioPet(ahoraUtc) !== null,
  };
}
