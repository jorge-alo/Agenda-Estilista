const ZONA = "America/Argentina/Buenos_Aires";
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function partes(instante: Date) {
  const values = Object.fromEntries(formatter.formatToParts(instante)
    .filter(part => part.type !== "literal")
    .map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second };
}

function fechaUtc(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Convert a local Argentine calendar boundary to an instant, using the IANA timezone. */
function corteArgentino(year: number, month: number, day: number): Date {
  const desired = Date.UTC(year, month - 1, day, 10);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = partes(new Date(guess));
    const observed = Date.UTC(local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second);
    guess += desired - observed;
  }
  const result = new Date(guess);
  const actual = partes(result);
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== 10
    || actual.minute !== 0 || actual.second !== 0) throw new Error("PET_REMINDER_TIMEZONE_INVALID");
  return result;
}

export interface VentanaRecordatorioPet { manana: string; corteUtc: Date }

/** [10:00:00.000, 12:00:00.000) ART, irrespective of the host's timezone. */
export function ventanaRecordatorioPet(ahoraUtc: Date): VentanaRecordatorioPet | null {
  if (!Number.isFinite(ahoraUtc.getTime())) throw new Error("PET_REMINDER_CLOCK_INVALID");
  const hoy = partes(ahoraUtc);
  if (hoy.hour < 10 || hoy.hour >= 12) return null;
  const siguiente = new Date(Date.UTC(hoy.year, hoy.month - 1, hoy.day + 1));
  return {
    manana: fechaUtc(siguiente.getUTCFullYear(), siguiente.getUTCMonth() + 1, siguiente.getUTCDate()),
    corteUtc: corteArgentino(hoy.year, hoy.month, hoy.day),
  };
}

/** SQL connection must have session time_zone = '+00:00'. */
export function fechaHoraSqlUtc(value: Date): string {
  const date = fechaUtc(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  return `${date} ${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}:${String(value.getUTCSeconds()).padStart(2, "0")}.${String(value.getUTCMilliseconds()).padStart(3, "0")}`;
}
