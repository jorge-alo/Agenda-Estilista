export interface MinuteInterval {
  startMinutes: number;
  endMinutes: number;
}

/**
 * Existing high-demand interval on an absolute day axis.
 * `dayOffset` is relative to the candidate date (0 = candidate day, -1 = previous day).
 * Absent means 0, preserving intra-day callers.
 */
export interface HighDemandInterval extends MinuteInterval {
  dayOffset?: number;
}

export type AvailabilityBlock =
  | { kind: "FULL_DAY" }
  | ({ kind: "PARTIAL" } & MinuteInterval);

export type HighDemandSettings =
  | { rule: "MIN_GAP"; gapMinutes: number }
  | { rule: "MAX_PER_DAY"; maxPerDay: number };

export interface HighDemandInput {
  /** Whether the requested pet is currently classified as high-demand. */
  isHighDemand: boolean;
  /** Already-resolved local settings; null is valid for normal pets. */
  settings: HighDemandSettings | null;
  /** Existing high-demand intervals for MIN_GAP, already normalized by the caller. */
  intervals?: HighDemandInterval[];
  /** Existing high-demand daily count for MAX_PER_DAY, already normalized by the caller. */
  count?: number;
}

export interface CalculateAvailabilityInput {
  /** Active schedule windows, with times expressed as minutes since midnight. */
  schedules: MinuteInterval[];
  /** Partial or full-day blocks for the date being calculated. */
  blocks: AvailabilityBlock[];
  durationMinutes: number;
  /** Optional existing physical occupancy intervals, already normalized. */
  occupiedIntervals?: MinuteInterval[];
  /** Exclude candidate starts earlier than this day-minute; null disables the filter. */
  minimumStartMinutes?: number | null;
  /** Omit or set isHighDemand=false when calculating for a normal pet. */
  highDemand?: HighDemandInput;
}

export interface AvailableInterval extends MinuteInterval {}

/** Calendar date in the PET API format, independent of the host timezone. */
export function fechaPetValida(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
