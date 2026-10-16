export interface MinuteInterval {
  startMinutes: number;
  endMinutes: number;
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
  intervals?: MinuteInterval[];
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
