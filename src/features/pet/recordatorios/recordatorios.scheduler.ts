import cron from "node-cron";
import {
  reclamarRecordatorioPet, seleccionarPaginaRecordatoriosPet,
  type CursorRecordatorioPet, type PaginaRecordatoriosPet,
} from "./recordatorios.service";
import { procesarRecordatorioPet, recuperarRecordatoriosPet } from "./recordatorios.processing";

export const PET_REMINDER_BATCH_SIZE = 20;
export const PET_REMINDER_CRON = "*/5 * * * *";
export const PET_REMINDER_TIMEZONE = "America/Argentina/Buenos_Aires";

type Recovery = Awaited<ReturnType<typeof recuperarRecordatoriosPet>>;
type Claim = Awaited<ReturnType<typeof reclamarRecordatorioPet>>;
type Processor = typeof procesarRecordatorioPet;

export interface PetReminderCycleDependencies {
  recover: () => Promise<Recovery>;
  page: (cursor: CursorRecordatorioPet | null) => Promise<PaginaRecordatoriosPet>;
  claim: (localId: number, turnoId: number) => Promise<Claim>;
  process: (id: number) => ReturnType<Processor>;
}

const defaultDependencies: PetReminderCycleDependencies = {
  recover: recuperarRecordatoriosPet,
  page: cursor => seleccionarPaginaRecordatoriosPet(cursor),
  claim: reclamarRecordatorioPet,
  process: id => procesarRecordatorioPet(id),
};

function isStructuralDatabaseFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("errno" in error || "sqlState" in error) return true;
  if (!("code" in error) || typeof error.code !== "string") return false;
  return error.code.startsWith("ER_") || error.code.startsWith("PROTOCOL_")
    || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(error.code);
}

/** Runs one bounded batch. A cursor advances over raw rows, not just claim winners. */
export async function runPetReminderCycle(
  deps: PetReminderCycleDependencies = defaultDependencies,
): Promise<{ recovered: Recovery; claimed: number; itemErrors: number }> {
  const recovered = await deps.recover();
  let claimed = 0;
  let itemErrors = 0;
  let cursor: CursorRecordatorioPet | null = null;
  // A disconnected local is probed once per run; this is not a distributed lock.
  const deferredLocals = new Set<number>();
  while (claimed < PET_REMINDER_BATCH_SIZE) {
    const page = await deps.page(cursor);
    for (const candidate of page.candidatos) {
      if (claimed === PET_REMINDER_BATCH_SIZE) break;
      if (deferredLocals.has(candidate.localId)) continue;
      try {
        const work = await deps.claim(candidate.localId, candidate.turnoId);
        if (!work) continue;
        claimed++; // Count each winning claim, even if processing returns pending/unknown/skipped.
        if (await deps.process(work.recordatorioId) === "pending") deferredLocals.add(candidate.localId);
      } catch (error) {
        if (isStructuralDatabaseFailure(error)) throw error;
        itemErrors++;
        console.warn("PET reminder item failed", {
          localId: candidate.localId, turnoId: candidate.turnoId, class: "ITEM_FAILURE",
        });
      }
    }
    if (!page.hayMas || !page.cursor || claimed === PET_REMINDER_BATCH_SIZE) break;
    cursor = page.cursor;
  }
  return { recovered, claimed, itemErrors };
}

export function isPetReminderSchedulerEnabled(value: string | undefined): boolean {
  return value === "true";
}

type SchedulerTask = { stop(): void };
type RegisterSchedule = (
  expression: string, callback: () => Promise<void>, options: { timezone: string },
) => SchedulerTask;
let registered: SchedulerTask | null = null;

/** Only registers a timer when explicitly enabled; importing this module has no side effects. */
export function startPetReminderScheduler(
  flag = process.env.PET_REMINDERS_ENABLED,
  schedule: RegisterSchedule = cron.schedule,
  cycle: () => Promise<unknown> = runPetReminderCycle,
): boolean {
  if (!isPetReminderSchedulerEnabled(flag)) return false;
  if (registered) return true; // Per-process registration guard, NOT distributed exclusion.
  registered = schedule(PET_REMINDER_CRON, async () => {
    try {
      await cycle();
    } catch {
      // Never log SQL/connection errors, phone numbers, message content or provider secrets.
      console.error("PET reminder cycle failed", { class: "STRUCTURAL_FAILURE" });
    }
  }, { timezone: PET_REMINDER_TIMEZONE });
  console.info("PET reminder scheduler enabled", { frequency: "5m", timezone: PET_REMINDER_TIMEZONE });
  return true;
}
