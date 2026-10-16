import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calcularDuracionTotal,
  calcularSlotsDisponibles,
  horaAMinutos,
  intervaloValido,
  intervalosSeSolapan,
  minutosAHora,
} from "./disponibilidad.engine";
import type { CalculateAvailabilityInput, MinuteInterval } from "./disponibilidad.types";

const ventana = (startMinutes: number, endMinutes: number): MinuteInterval => ({ startMinutes, endMinutes });
const starts = (intervals: MinuteInterval[]) => intervals.map(interval => interval.startMinutes);
const calculate = (overrides: Partial<CalculateAvailabilityInput> = {}) => calcularSlotsDisponibles({
  schedules: [ventana(9 * 60, 13 * 60)],
  blocks: [],
  durationMinutes: 60,
  ...overrides,
});

describe("PET-07B motor puro de disponibilidad", () => {
  describe("conversión de horas e intervalos", () => {
    it("convierte HH:mm y HH:mm:ss con segundos cero a minutos desde medianoche", () => {
      assert.equal(horaAMinutos("09:00"), 540);
      assert.equal(horaAMinutos("10:15:00"), 615);
      assert.equal(horaAMinutos("18:30"), 1110);
    });

    it("formatea minutos como HH:mm y no permite wrap", () => {
      assert.equal(minutosAHora(540), "09:00");
      assert.equal(minutosAHora(615), "10:15");
      assert.throws(() => minutosAHora(1440), RangeError);
    });

    it("rechaza horas inválidas, segundos no representables y rangos fuera del día", () => {
      for (const value of ["9:00", "24:00", "12:60", "12:00:60", "12:00:01"]) {
        assert.throws(() => horaAMinutos(value), RangeError, value);
      }
    });

    it("valida intervalos positivos dentro del día", () => {
      assert.equal(intervaloValido(ventana(540, 600)), true);
      assert.equal(intervaloValido(ventana(600, 600)), false);
      assert.equal(intervaloValido(ventana(-1, 600)), false);
      assert.equal(intervaloValido(ventana(1380, 1440)), false);
    });
  });

  describe("duración total", () => {
    it("acepta servicio solo, extras y duraciones no múltiplos de slots", () => {
      assert.equal(calcularDuracionTotal(75, []), 75);
      assert.equal(calcularDuracionTotal(75, [15]), 90);
      assert.equal(calcularDuracionTotal(75, [15, 20, 25]), 135);
    });

    it("rechaza duraciones no enteras, no positivas, no seguras y overflow de suma", () => {
      for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => calcularDuracionTotal(duration, []), RangeError);
      }
      assert.throws(() => calcularDuracionTotal(10, [0]), RangeError);
      assert.throws(() => calcularDuracionTotal(Number.MAX_SAFE_INTEGER, [1]), /rango entero seguro/);
    });
  });

  describe("solapamiento", () => {
    it("detecta solape por inicio, por fin y contención en ambas direcciones", () => {
      assert.equal(intervalosSeSolapan(9 * 60, 10 * 60, 9 * 60 + 30, 10 * 60 + 30), true);
      assert.equal(intervalosSeSolapan(9 * 60 + 30, 10 * 60 + 30, 9 * 60, 10 * 60), true);
      assert.equal(intervalosSeSolapan(9 * 60, 12 * 60, 10 * 60, 11 * 60), true);
      assert.equal(intervalosSeSolapan(10 * 60, 11 * 60, 9 * 60, 12 * 60), true);
    });

    it("considera válida la adyacencia y rechaza intervalos inválidos", () => {
      assert.equal(intervalosSeSolapan(9 * 60, 10 * 60, 10 * 60, 11 * 60), false);
      assert.throws(() => intervalosSeSolapan(10, 10, 20, 30), RangeError);
    });
  });

  describe("horarios y generación de candidatos", () => {
    it("genera inicios cada 30 minutos desde el inicio de una franja y solo si cabe", () => {
      const result = calcularSlotsDisponibles({
        schedules: [ventana(540, 780)],
        blocks: [],
        durationMinutes: 90,
      });
      assert.deepEqual(starts(result), [540, 570, 600, 630, 660, 690]);
      assert.deepEqual(result[result.length - 1], ventana(690, 780));
    });

    it("genera desde :15, conserva el anclaje en cada franja y soporta varias franjas", () => {
      const result = calcularSlotsDisponibles({
        schedules: [ventana(9 * 60 + 15, 11 * 60), ventana(15 * 60 + 15, 16 * 60 + 15)],
        blocks: [],
        durationMinutes: 30,
      });
      assert.deepEqual(starts(result), [555, 585, 615, 915, 945]);
    });

    it("incluye el ajuste que cabe exactamente y excluye el que excede la franja", () => {
      assert.deepEqual(starts(calcularSlotsDisponibles({
        schedules: [ventana(540, 600)], blocks: [], durationMinutes: 60,
      })), [540]);
      assert.deepEqual(calcularSlotsDisponibles({
        schedules: [ventana(540, 599)], blocks: [], durationMinutes: 60,
      }), []);
    });

    it("no continúa una duración entre franjas adyacentes", () => {
      assert.deepEqual(calcularSlotsDisponibles({
        schedules: [ventana(540, 570), ventana(570, 600)],
        blocks: [],
        durationMinutes: 45,
      }), []);
    });

    it("devuelve resultados ordenados y sin duplicar candidatos de ventanas repetidas", () => {
      const result = calcularSlotsDisponibles({
        schedules: [ventana(570, 630), ventana(540, 600)],
        blocks: [], durationMinutes: 30,
      });
      assert.deepEqual(starts(result), [540, 570, 600]);
    });
  });

  describe("bloqueos", () => {
    it("descarta candidatos que se solapan o atraviesan un bloqueo parcial", () => {
      const result = calculate({
        schedules: [ventana(9 * 60, 18 * 60)],
        durationMinutes: 60,
        blocks: [{ kind: "PARTIAL", ...ventana(13 * 60, 15 * 60) }],
      });
      assert.equal(result.some(interval => interval.startMinutes === 12 * 60 + 30), false);
      assert.equal(result.some(interval => interval.startMinutes === 13 * 60), false);
      assert.equal(result.some(interval => interval.startMinutes === 15 * 60), true);
    });

    it("permite adyacencia a un bloqueo parcial", () => {
      const result = calculate({
        schedules: [ventana(540, 660)],
        durationMinutes: 60,
        blocks: [{ kind: "PARTIAL", ...ventana(600, 660) }],
      });
      assert.deepEqual(starts(result), [540]);
    });

    it("día completo elimina todos los candidatos", () => {
      assert.deepEqual(calculate({ blocks: [{ kind: "FULL_DAY" }] }), []);
    });
  });

  describe("ocupación abstracta", () => {
    it("filtra candidatos ocupados y conserva la adyacencia", () => {
      const result = calculate({
        schedules: [ventana(540, 720)],
        durationMinutes: 60,
        occupiedIntervals: [ventana(600, 660)],
      });
      assert.deepEqual(starts(result), [540, 660]);
    });

    it("aplica varios intervalos ocupados", () => {
      const result = calculate({
        schedules: [ventana(540, 750)],
        durationMinutes: 30,
        occupiedIntervals: [ventana(570, 600), ventana(660, 690)],
      });
      assert.deepEqual(starts(result), [540, 600, 630, 690, 720]);
    });
  });

  describe("MIN_GAP", () => {
    const settings = { rule: "MIN_GAP" as const, gapMinutes: 60 };
    const highDemand = (intervals: MinuteInterval[]) => ({ isHighDemand: true, settings, intervals });

    it("aplica el gap desde el final del vecino anterior, con igualdad incluida", () => {
      const result = calculate({
        schedules: [ventana(600, 660)], durationMinutes: 60,
        highDemand: highDemand([ventana(480, 540)]),
      });
      assert.deepEqual(starts(result), [600]);
    });

    it("elimina el candidato si queda un minuto menos que el gap anterior", () => {
      const result = calculate({
        schedules: [ventana(599, 660)], durationMinutes: 60,
        highDemand: highDemand([ventana(480, 540)]),
      });
      assert.deepEqual(result, []);
    });

    it("aplica el gap antes del vecino posterior, con igualdad incluida", () => {
      const result = calculate({
        schedules: [ventana(540, 600)], durationMinutes: 60,
        highDemand: highDemand([ventana(660, 720)]),
      });
      assert.deepEqual(starts(result), [540]);
    });

    it("aplica ambos vecinos y rechaza un intervalo high-demand que se cruza", () => {
      const neighbors = [ventana(480, 540), ventana(720, 780)];
      const valid = calculate({ schedules: [ventana(600, 660)], durationMinutes: 60, highDemand: highDemand(neighbors) });
      assert.deepEqual(starts(valid), [600]);
      const crossing = calculate({
        schedules: [ventana(600, 660)], durationMinutes: 60,
        highDemand: highDemand([ventana(630, 690)]),
      });
      assert.deepEqual(crossing, []);
    });

    it("mascota normal ignora MIN_GAP y alta exigencia sin settings falla explícitamente", () => {
      assert.deepEqual(calculate({ highDemand: { isHighDemand: false, settings: null } }).length, 7);
      assert.throws(() => calculate({ highDemand: { isHighDemand: true, settings: null } }), /Faltan settings/);
    });
  });

  describe("MAX_PER_DAY", () => {
    const maxSettings = { rule: "MAX_PER_DAY" as const, maxPerDay: 2 };

    it("permite candidatos por debajo del máximo y vacía en el máximo o encima", () => {
      assert.equal(calculate({ highDemand: { isHighDemand: true, settings: maxSettings, count: 1 } }).length, 7);
      assert.deepEqual(calculate({ highDemand: { isHighDemand: true, settings: maxSettings, count: 2 } }), []);
      assert.deepEqual(calculate({ highDemand: { isHighDemand: true, settings: maxSettings, count: 3 } }), []);
    });

    it("mascota normal ignora MAX_PER_DAY", () => {
      assert.equal(calculate({
        highDemand: { isHighDemand: false, settings: maxSettings, count: 2 },
      }).length, 7);
    });

    it("falla explícitamente si falta el conteo o la regla es inválida", () => {
      assert.throws(() => calculate({ highDemand: { isHighDemand: true, settings: maxSettings } }), /count/);
      assert.throws(() => calculate({
        highDemand: { isHighDemand: true, settings: { rule: "MIN_GAP", gapMinutes: 0 }, intervals: [] },
      }), /gapMinutes/);
    });
  });

  describe("minimumStartMinutes y combinación", () => {
    it("elimina inicios anteriores, permite igualdad y no filtra con null", () => {
      assert.deepEqual(starts(calculate({ minimumStartMinutes: 600 })), [600, 630, 660, 690, 720]);
      assert.equal(calculate({ minimumStartMinutes: null }).length, 7);
      assert.throws(() => calculate({ minimumStartMinutes: 1440 }), RangeError);
    });

    it("combina horario, bloqueo, ocupación, duración y MIN_GAP sin DB", () => {
      const result = calcularSlotsDisponibles({
        schedules: [ventana(540, 780)],
        blocks: [{ kind: "PARTIAL", ...ventana(630, 660) }],
        durationMinutes: 60,
        occupiedIntervals: [ventana(690, 720)],
        minimumStartMinutes: 570,
        highDemand: {
          isHighDemand: true,
          settings: { rule: "MIN_GAP", gapMinutes: 30 },
          intervals: [ventana(480, 510), ventana(750, 780)],
        },
      });
      assert.deepEqual(result, [ventana(570, 630)]);
    });
  });
});
