import type {
  AvailabilityBlock,
  AvailableInterval,
  CalculateAvailabilityInput,
  HighDemandInput,
  HighDemandInterval,
  HighDemandSettings,
  MinuteInterval,
} from "./disponibilidad.types";

const MINUTES_PER_DAY = 24 * 60;
const SLOT_STEP_MINUTES = 30;

function esEnteroMinuto(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;
}

function validarMinuto(value: number, name: string): void {
  if (!esEnteroMinuto(value)) {
    throw new RangeError(`${name} debe ser un minuto entero entre 0 y 1439`);
  }
}

function validarIntervalo(interval: MinuteInterval, name: string): void {
  validarMinuto(interval.startMinutes, `${name}.startMinutes`);
  validarMinuto(interval.endMinutes, `${name}.endMinutes`);
  if (interval.startMinutes >= interval.endMinutes) {
    throw new RangeError(`${name} debe tener inicio menor que fin y no cruzar medianoche`);
  }
}

function validarConfiguracion(settings: HighDemandSettings): void {
  if (settings.rule === "MIN_GAP") {
    if (!Number.isSafeInteger(settings.gapMinutes) || settings.gapMinutes <= 0) {
      throw new RangeError("gapMinutes debe ser un entero positivo seguro");
    }
    return;
  }
  if (settings.rule === "MAX_PER_DAY") {
    if (!Number.isSafeInteger(settings.maxPerDay) || settings.maxPerDay <= 0) {
      throw new RangeError("maxPerDay debe ser un entero positivo seguro");
    }
    return;
  }
  throw new TypeError("Regla high-demand desconocida");
}

function validarHighDemand(highDemand: HighDemandInput | undefined): void {
  if (!highDemand?.isHighDemand) return;
  if (highDemand.settings === null) {
    throw new RangeError("Faltan settings para una mascota de alta exigencia");
  }
  validarConfiguracion(highDemand.settings);

  if (highDemand.settings.rule === "MIN_GAP") {
    for (const interval of highDemand.intervals ?? []) {
      validarIntervalo(interval, "highDemand.intervals[]");
      const dayOffset = interval.dayOffset ?? 0;
      if (!Number.isSafeInteger(dayOffset)) {
        throw new RangeError("highDemand.intervals[].dayOffset debe ser un entero seguro");
      }
    }
    return;
  }

  if (!Number.isSafeInteger(highDemand.count) || (highDemand.count as number) < 0) {
    throw new RangeError("count debe ser un entero no negativo para MAX_PER_DAY");
  }
}

/** Convert HH:mm or HH:mm:ss to an integer minute offset from midnight. */
export function horaAMinutos(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new RangeError("Hora inválida: usar HH:mm o HH:mm:ss");

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new RangeError("Hora fuera de rango");
  if (seconds !== 0) throw new RangeError("La precisión del motor es de minutos; los segundos deben ser 00");
  return hours * 60 + minutes;
}

/** Convert an integer minute offset to HH:mm without wrapping into another day. */
export function minutosAHora(minutesSinceMidnight: number): string {
  validarMinuto(minutesSinceMidnight, "minutesSinceMidnight");
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** True when a minute interval has positive length and remains within this day. */
export function intervaloValido(interval: MinuteInterval): boolean {
  return Number.isInteger(interval.startMinutes)
    && Number.isInteger(interval.endMinutes)
    && interval.startMinutes >= 0
    && interval.startMinutes < interval.endMinutes
    && interval.endMinutes < MINUTES_PER_DAY;
}

/** Half-open interval overlap; adjacent intervals do not overlap. */
export function intervalosSeSolapan(
  candidateStart: number,
  candidateEnd: number,
  existingStart: number,
  existingEnd: number,
): boolean {
  validarIntervalo({ startMinutes: candidateStart, endMinutes: candidateEnd }, "candidate");
  validarIntervalo({ startMinutes: existingStart, endMinutes: existingEnd }, "existing");
  return candidateStart < existingEnd && candidateEnd > existingStart;
}

/** Add positive minute durations without allowing unsafe integer overflow. */
export function calcularDuracionTotal(
  duracionServicio: number,
  duracionesExtras: readonly number[],
): number {
  const duraciones = [duracionServicio, ...duracionesExtras];
  let total = 0;
  for (const duracion of duraciones) {
    if (!Number.isSafeInteger(duracion) || duracion <= 0) {
      throw new RangeError("Cada duración debe ser un entero positivo seguro");
    }
    total += duracion;
    if (!Number.isSafeInteger(total)) throw new RangeError("La duración total excede el rango entero seguro");
  }
  return total;
}

function validarBloque(block: AvailabilityBlock, index: number): void {
  if (block.kind === "FULL_DAY") return;
  if (block.kind !== "PARTIAL") throw new TypeError(`blocks[${index}].kind inválido`);
  validarIntervalo(block, `blocks[${index}]`);
}

/**
 * Existing high-demand intervals live on an absolute day axis. The candidate sits on
 * day 0, so every neighbor is shifted by `dayOffset * MINUTES_PER_DAY`; intra-day
 * intervals keep `dayOffset = 0` and behave exactly as before.
 */
function candidatoCumpleMinGap(candidate: MinuteInterval, intervals: readonly HighDemandInterval[], gap: number): boolean {
  let previousEnd: number | null = null;
  let nextStart: number | null = null;

  for (const interval of intervals) {
    const offset = (interval.dayOffset ?? 0) * MINUTES_PER_DAY;
    const absoluteStart = offset + interval.startMinutes;
    const absoluteEnd = offset + interval.endMinutes;
    if (absoluteEnd <= candidate.startMinutes) {
      previousEnd = previousEnd === null ? absoluteEnd : Math.max(previousEnd, absoluteEnd);
    } else if (absoluteStart >= candidate.endMinutes) {
      nextStart = nextStart === null ? absoluteStart : Math.min(nextStart, absoluteStart);
    } else {
      // An existing high-demand interval intersects the candidate.
      return false;
    }
  }

  return (previousEnd === null || candidate.startMinutes >= previousEnd + gap)
    && (nextStart === null || candidate.endMinutes + gap <= nextStart);
}

function cumpleReglaHighDemand(candidate: MinuteInterval, highDemand: HighDemandInput | undefined): boolean {
  if (!highDemand?.isHighDemand) return true;
  // validarHighDemand has already guaranteed settings here.
  const settings = highDemand.settings as HighDemandSettings;
  if (settings.rule === "MIN_GAP") {
    return candidatoCumpleMinGap(candidate, highDemand.intervals ?? [], settings.gapMinutes);
  }
  return (highDemand.count as number) < settings.maxPerDay;
}

/**
 * Calculate deterministic PET availability candidates from already validated,
 * normalized business inputs. This function performs no IO and reads no clock.
 */
export function calcularSlotsDisponibles(input: CalculateAvailabilityInput): AvailableInterval[] {
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new RangeError("durationMinutes debe ser un entero positivo seguro");
  }
  if (input.minimumStartMinutes !== undefined && input.minimumStartMinutes !== null) {
    validarMinuto(input.minimumStartMinutes, "minimumStartMinutes");
  }
  input.schedules.forEach((schedule, index) => validarIntervalo(schedule, `schedules[${index}]`));
  input.blocks.forEach(validarBloque);
  (input.occupiedIntervals ?? []).forEach((interval, index) => validarIntervalo(interval, `occupiedIntervals[${index}]`));
  validarHighDemand(input.highDemand);

  if (input.blocks.some(block => block.kind === "FULL_DAY")) return [];

  const results = new Map<string, AvailableInterval>();
  for (const schedule of input.schedules) {
    for (let start = schedule.startMinutes; start + input.durationMinutes <= schedule.endMinutes; start += SLOT_STEP_MINUTES) {
      if (input.minimumStartMinutes !== undefined && input.minimumStartMinutes !== null && start < input.minimumStartMinutes) {
        continue;
      }
      const candidate = { startMinutes: start, endMinutes: start + input.durationMinutes };
      if (input.blocks.some(block => block.kind === "PARTIAL"
        && intervalosSeSolapan(candidate.startMinutes, candidate.endMinutes, block.startMinutes, block.endMinutes))) {
        continue;
      }
      if ((input.occupiedIntervals ?? []).some(interval => intervalosSeSolapan(
        candidate.startMinutes, candidate.endMinutes, interval.startMinutes, interval.endMinutes,
      ))) {
        continue;
      }
      if (!cumpleReglaHighDemand(candidate, input.highDemand)) continue;

      results.set(`${candidate.startMinutes}:${candidate.endMinutes}`, candidate);
    }
  }

  return [...results.values()].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
}
