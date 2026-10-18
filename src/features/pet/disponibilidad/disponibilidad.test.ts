import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { after, before, beforeEach, describe, it, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import petRouter from "../pet.routes";
import {
  calcularDuracionTotal,
  calcularSlotsDisponibles,
  horaAMinutos,
  intervaloValido,
  intervalosSeSolapan,
  minutosAHora,
} from "./disponibilidad.engine";
import { contextoTemporalArgentina } from "./disponibilidad.service";
import type { CalculateAvailabilityInput, HighDemandInterval, MinuteInterval } from "./disponibilidad.types";

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
    const highDemand = (intervals: HighDemandInterval[]) => ({ isHighDemand: true, settings, intervals });

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

    it("normaliza dayOffset ausente y cero como el mismo eje intradía", () => {
      const sinOffset = calculate({ highDemand: highDemand([ventana(480, 540)]) });
      const conOffsetCero = calculate({ highDemand: highDemand([{ ...ventana(480, 540), dayOffset: 0 }]) });
      assert.deepEqual(starts(sinOffset), starts(conOffsetCero));
    });

    it("aplica el gap interfecha desde el vecino anterior con dayOffset negativo", () => {
      const cincoHoras = { isHighDemand: true as const, settings: { rule: "MIN_GAP" as const, gapMinutes: 300 } };
      const result = calcularSlotsDisponibles({
        schedules: [ventana(0, 120)],
        blocks: [],
        durationMinutes: 30,
        highDemand: { ...cincoHoras, intervals: [{ ...ventana(18 * 60, 19 * 60 + 30), dayOffset: -1 }] },
      });
      // D 19:30 + 5h = D+1 00:30 (absoluto -1440 + 1170 + 300 = 30).
      assert.deepEqual(starts(result), [30, 60, 90]);
    });

    it("acepta la igualdad exacta interfecha y rechaza un minuto antes", () => {
      const cincoHoras = { isHighDemand: true as const, settings: { rule: "MIN_GAP" as const, gapMinutes: 300 } };
      const previo = { ...cincoHoras, intervals: [{ ...ventana(18 * 60, 19 * 60 + 30), dayOffset: -1 }] };
      assert.deepEqual(starts(calcularSlotsDisponibles({
        schedules: [ventana(30, 120)], blocks: [], durationMinutes: 30, highDemand: previo,
      })), [30, 60, 90]);
      assert.deepEqual(starts(calcularSlotsDisponibles({
        schedules: [ventana(29, 120)], blocks: [], durationMinutes: 30, highDemand: previo,
      })), [59, 89], "00:29 queda fuera y el siguiente inicio de la grilla es 00:59");
    });

    it("respeta el vecino posterior en otra fecha (fin + gap <= inicio)", () => {
      const cincoHoras = { isHighDemand: true as const, settings: { rule: "MIN_GAP" as const, gapMinutes: 300 } };
      const result = calcularSlotsDisponibles({
        schedules: [ventana(17 * 60, 19 * 60)],
        blocks: [],
        durationMinutes: 60,
        highDemand: { ...cincoHoras, intervals: [{ ...ventana(0, 30), dayOffset: 1 }] },
      });
      // Vecino D+1 00:00 (absoluto 1440); el candidato debe terminar a lo sumo 19:00.
      assert.deepEqual(starts(result), [17 * 60, 17 * 60 + 30, 18 * 60]);
    });

    it("soporta un gap mayor a 24 horas", () => {
      const treintaHoras = { isHighDemand: true as const, settings: { rule: "MIN_GAP" as const, gapMinutes: 1800 } };
      const result = calcularSlotsDisponibles({
        schedules: [ventana(17 * 60, 20 * 60)],
        blocks: [],
        durationMinutes: 60,
        highDemand: { ...treintaHoras, intervals: [{ ...ventana(12 * 60, 13 * 60), dayOffset: -1 }] },
      });
      // D-1 13:00 + 30h = D 19:00 (absoluto -1440 + 780 + 1800 = 1140).
      assert.deepEqual(starts(result), [19 * 60]);
    });

    it("rechaza dayOffset no entero", () => {
      assert.throws(() => calculate({
        highDemand: highDemand([{ ...ventana(480, 540), dayOffset: 1.5 }]),
      }), /dayOffset/);
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

describe("PET-07C GET disponibilidad admin", () => {
  const secret = "PET07C_FIXTURE_SECRET_SOLO_TEST";
  const fechaFutura = "2099-10-20";
  const fechaPasada = "2000-01-01";
  const diaFuturo = new Date(Date.UTC(2099, 9, 20)).getUTCDay();
  const locales: number[] = [];
  let localPet = 0;
  let localAjeno = 0;
  let localBeauty = 0;
  let mascotaId = 0;
  let mascotaAjenaId = 0;
  let servicioId = 0;
  let servicioAjenoId = 0;
  let extraUnoId = 0;
  let extraDosId = 0;
  let extraInactivoId = 0;
  let extraAjenoId = 0;
  let server: Server;
  let port: number;

  async function crearLocal(businessType: string): Promise<number> {
    const [result] = await pool.query<ResultSetHeader>(
      "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)",
      ["Fixture PET-07C", randomUUID(), businessType],
    );
    locales.push(result.insertId);
    return result.insertId;
  }

  function queryPath(options: {
    mascotaId?: string | number;
    servicioId?: string | number;
    fecha?: string;
    extraIds?: Array<string | number>;
  } = {}): string {
    const query = new URLSearchParams();
    if (options.mascotaId !== undefined) query.append("mascotaId", String(options.mascotaId));
    if (options.servicioId !== undefined) query.append("servicioId", String(options.servicioId));
    if (options.fecha !== undefined) query.append("fecha", options.fecha);
    for (const extraId of options.extraIds ?? []) query.append("extraIds", String(extraId));
    return `/api/pet/admin/disponibilidad?${query.toString()}`;
  }

  async function http(path: string, localId: number | null = localPet): Promise<{ status: number; body: string }> {
    const token = localId === null ? undefined : jwt.sign(
      { userId: 1, rol: "admin", localId }, secret, { expiresIn: "1m" },
    );
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  function json<T>(result: { body: string }): T {
    return JSON.parse(result.body) as T;
  }

  async function agregarHorario(inicio: string, fin: string, dia = diaFuturo, localId = localPet): Promise<void> {
    await pool.query(
      "INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, 1)",
      [localId, dia, inicio, fin],
    );
  }

  async function agregarBloqueo(
    fecha: string,
    completo: boolean,
    inicio: string | null = null,
    fin: string | null = null,
    localId = localPet,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO bloqueos_local (local_id, fecha, hora_inicio, hora_fin, es_dia_completo)
       VALUES (?, ?, ?, ?, ?)`,
      [localId, fecha, inicio, fin, completo ? 1 : 0],
    );
  }

  async function agregarTurno(
    hora: string,
    horaFin: string,
    estado: "activo" | "pendiente_pago" | "cancelado" | "completado",
    highDemand: 0 | 1,
    fecha = fechaFutura,
  ): Promise<number> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO turnos (
        fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono,
        estado, mascota_id, alta_exigencia_snapshot, servicio_nombre_snapshot, duracion_servicio_snapshot
      ) VALUES (?, ?, ?, NULL, ?, 'PET07C fixture', 'PET07C fixture', ?, ?, ?, 'Fixture service', 45)`,
      [fecha, hora, horaFin, localPet, estado, mascotaId, highDemand],
    );
    return result.insertId;
  }

  async function configurarRegla(rule: "MIN_GAP" | "MAX_PER_DAY", amount: number): Promise<void> {
    await pool.query(
      `INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day)
       VALUES (?, ?, ?, ?) AS nuevo
       ON DUPLICATE KEY UPDATE
         high_demand_rule = nuevo.high_demand_rule,
         high_demand_gap_minutes = nuevo.high_demand_gap_minutes,
         high_demand_max_per_day = nuevo.high_demand_max_per_day`,
      [localPet, rule, rule === "MIN_GAP" ? amount : null, rule === "MAX_PER_DAY" ? amount : null],
    );
  }

  before(async () => {
    localPet = await crearLocal("PET_GROOMING");
    localAjeno = await crearLocal("PET_GROOMING");
    localBeauty = await crearLocal("BEAUTY");

    const [pet] = await pool.query<ResultSetHeader>("INSERT INTO mascotas (local_id, nombre) VALUES (?, 'Fixture pet')", [localPet]);
    mascotaId = pet.insertId;
    const [petAjeno] = await pool.query<ResultSetHeader>("INSERT INTO mascotas (local_id, nombre) VALUES (?, 'Fixture pet')", [localAjeno]);
    mascotaAjenaId = petAjeno.insertId;
    const [service] = await pool.query<ResultSetHeader>("INSERT INTO servicios (nombre, duracion, local_id, activo) VALUES ('Fixture service', 99, ?, 1)", [localPet]);
    servicioId = service.insertId;
    const [serviceAjeno] = await pool.query<ResultSetHeader>("INSERT INTO servicios (nombre, duracion, local_id, activo) VALUES ('Fixture foreign service', 99, ?, 1)", [localAjeno]);
    servicioAjenoId = serviceAjeno.insertId;
    const [extraUno] = await pool.query<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Fixture extra one', 1)", [localPet]);
    extraUnoId = extraUno.insertId;
    const [extraDos] = await pool.query<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Fixture extra two', 1)", [localPet]);
    extraDosId = extraDos.insertId;
    const [extraInactivo] = await pool.query<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Fixture inactive extra', 0)", [localPet]);
    extraInactivoId = extraInactivo.insertId;
    const [extraAjeno] = await pool.query<ResultSetHeader>("INSERT INTO extras (local_id, nombre, activo) VALUES (?, 'Fixture foreign extra', 1)", [localAjeno]);
    extraAjenoId = extraAjeno.insertId;

    const app = express();
    app.use("/api/pet/admin", petRouter);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = address.port;
  });

  beforeEach(async t => {
    assert.ok("mock" in t);
    t.mock.property(process, "env", { JWT_SECRET: secret });
    await pool.query("DELETE FROM turnos WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("DELETE FROM bloqueos_local WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("DELETE FROM horarios_local WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("DELETE FROM pet_settings WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("DELETE FROM mascota_servicios WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("DELETE FROM mascota_extras WHERE local_id IN (?, ?)", [localPet, localAjeno]);
    await pool.query("UPDATE mascotas SET activo = 1, alta_exigencia = 0 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    await pool.query("UPDATE servicios SET activo = 1 WHERE id IN (?, ?)", [servicioId, servicioAjenoId]);
    await pool.query("UPDATE extras SET activo = 1 WHERE id IN (?, ?, ?)", [extraUnoId, extraDosId, extraAjenoId]);
    await pool.query("UPDATE extras SET activo = 0 WHERE id = ?", [extraInactivoId]);
    await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 45)", [localPet, mascotaId, servicioId]);
    await pool.query("INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, 15), (?, ?, ?, 25), (?, ?, ?, 5)", [
      localPet, mascotaId, extraUnoId,
      localPet, mascotaId, extraDosId,
      localPet, mascotaId, extraInactivoId,
    ]);
  });

  after(async () => {
    const errors: unknown[] = [];
    try {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) { errors.push(error); }
    try {
      if (locales.length) {
        const placeholders = locales.map(() => "?").join(", ");
        await pool.query(`DELETE FROM turnos WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM bloqueos_local WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM horarios_local WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM pet_settings WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM mascota_servicios WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM mascota_extras WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM mascotas WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM estilistas WHERE local_id IN (${placeholders}) AND nombre = 'Fixture beauty stylist'`, locales);
        await pool.query(`DELETE FROM extras WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM servicios WHERE local_id IN (${placeholders})`, locales);
        await pool.query(`DELETE FROM locales WHERE id IN (${placeholders})`, locales);
      }
    } catch (error) { errors.push(error); }
    try { await pool.end(); } catch (error) { errors.push(error); }
    assert.equal(errors.length, 0, "Fixtures de disponibilidad PET deben limpiarse");
  });

  it("requiere auth PET y rechaza locales BEAUTY", async () => {
    const path = queryPath({ mascotaId, servicioId, fecha: fechaFutura });
    assert.equal((await http(path, null)).status, 401);
    assert.equal((await http(path, localBeauty)).status, 403);
  });

  it("valida IDs, fecha, repetición, duplicados, campos extra y valores vacíos", async () => {
    const invalidPaths = [
      "/api/pet/admin/disponibilidad",
      queryPath({ mascotaId: "0", servicioId, fecha: fechaFutura }),
      queryPath({ mascotaId: 2147483648, servicioId, fecha: fechaFutura }),
      queryPath({ mascotaId, servicioId, fecha: "2026-02-30" }),
      queryPath({ mascotaId, servicioId, fecha: "20-10-2026" }),
      `${queryPath({ mascotaId, servicioId, fecha: fechaFutura })}&mascotaId=${mascotaId}`,
      `${queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraUnoId, extraUnoId] })}`,
      `${queryPath({ mascotaId, servicioId, fecha: fechaFutura })}&localId=${localAjeno}`,
      `${queryPath({ mascotaId, servicioId, fecha: fechaFutura })}&duracion=45`,
      `${queryPath({ mascotaId, servicioId, fecha: fechaFutura })}&extraIds=`,
    ];
    for (const path of invalidPaths) assert.equal((await http(path)).status, 400, path);
  });

  it("aísla mascota, servicio y extra por local", async () => {
    const foreignPet = await http(queryPath({ mascotaId: mascotaAjenaId, servicioId, fecha: fechaFutura }));
    const foreignService = await http(queryPath({ mascotaId, servicioId: servicioAjenoId, fecha: fechaFutura }));
    const foreignExtra = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraAjenoId] }));
    assert.equal(foreignPet.status, 404);
    assert.equal(foreignService.status, 404);
    assert.equal(foreignExtra.status, 404);
  });

  it("rechaza mascota/servicio/extra inactivos y relaciones faltantes", async () => {
    await pool.query("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }))).status, 409);
    await pool.query("UPDATE mascotas SET activo = 1 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);

    await pool.query("UPDATE servicios SET activo = 0 WHERE id = ? AND local_id = ?", [servicioId, localPet]);
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }))).status, 409);
    await pool.query("UPDATE servicios SET activo = 1 WHERE id = ? AND local_id = ?", [servicioId, localPet]);

    await pool.query("DELETE FROM mascota_servicios WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [localPet, mascotaId, servicioId]);
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }))).status, 409);
    await pool.query("INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 45)", [localPet, mascotaId, servicioId]);

    await pool.query("UPDATE extras SET activo = 0 WHERE id = ? AND local_id = ?", [extraUnoId, localPet]);
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraUnoId] }))).status, 409);
    await pool.query("UPDATE extras SET activo = 1 WHERE id = ? AND local_id = ?", [extraUnoId, localPet]);

    await pool.query("DELETE FROM mascota_extras WHERE local_id = ? AND mascota_id = ? AND extra_id = ?", [localPet, mascotaId, extraUnoId]);
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraUnoId] }))).status, 409);
  });

  it("calcula duración desde relación mascota-servicio y cero/uno/varios extras", async () => {
    const noExtras = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.equal(noExtras.status, 200);
    assert.equal(json<{ duracionMinutos: number }>(noExtras).duracionMinutos, 45);
    const oneExtra = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraUnoId] }));
    assert.equal(json<{ duracionMinutos: number }>(oneExtra).duracionMinutos, 60);
    const twoExtras = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura, extraIds: [extraUnoId, extraDosId] }));
    assert.equal(json<{ duracionMinutos: number }>(twoExtras).duracionMinutos, 85);
  });

  it("devuelve vacío sin horarios y calcula franjas únicas y múltiples", async () => {
    assert.deepEqual(json<{ slots: unknown[] }>(await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }))).slots, []);
    await agregarHorario("09:00:00", "10:00:00");
    const oneWindow = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string; horaFin: string }> }>(oneWindow).slots, [{ horaInicio: "09:00", horaFin: "09:45" }]);
    await agregarHorario("11:00:00", "12:00:00");
    const twoWindows = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string; horaFin: string }> }>(twoWindows).slots, [
      { horaInicio: "09:00", horaFin: "09:45" },
      { horaInicio: "11:00", horaFin: "11:45" },
    ]);
  });

  it("resta bloqueos parciales y de día completo", async () => {
    await agregarHorario("09:00:00", "12:00:00");
    await agregarBloqueo(fechaFutura, false, "10:00:00", "11:00:00");
    const partial = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(partial).slots.map(slot => slot.horaInicio), ["09:00", "11:00"]);

    await pool.query("DELETE FROM bloqueos_local WHERE local_id = ? AND fecha = ?", [localPet, fechaFutura]);
    await agregarBloqueo(fechaFutura, true);
    const full = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: unknown[] }>(full).slots, []);
  });

  it("activo y pendiente_pago bloquean; cancelado y completado no ocupan físicamente", async () => {
    await agregarHorario("09:00:00", "12:00:00");
    for (const state of ["activo", "pendiente_pago"] as const) {
      await agregarTurno("09:00:00", "10:00:00", state, 0);
      const response = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
      const startsAvailable = json<{ slots: Array<{ horaInicio: string }> }>(response).slots.map(slot => slot.horaInicio);
      assert.deepEqual(startsAvailable, ["10:00", "10:30", "11:00"]);
      await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    }
    for (const state of ["cancelado", "completado"] as const) {
      await agregarTurno("09:00:00", "10:00:00", state, 0);
      const response = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
      assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(response).slots.map(slot => slot.horaInicio), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
      await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    }
  });

  it("no exige settings para mascota normal y devuelve código estable si high-demand no está configurado", async () => {
    await agregarHorario("09:00:00", "11:00:00");
    assert.equal((await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }))).status, 200);
    await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    const result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.equal(result.status, 409);
    assert.equal(json<{ code: string }>(result).code, "PET_HIGH_DEMAND_SETTINGS_REQUIRED");
  });

  it("MIN_GAP usa snapshots high-demand de activo, pendiente y completado, pero ignora cancelado", async () => {
    await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    await configurarRegla("MIN_GAP", 30);
    await agregarHorario("09:00:00", "10:30:00");
    await agregarTurno("08:00:00", "09:00:00", "completado", 1);
    let result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(result).slots.map(slot => slot.horaInicio), ["09:30"]);

    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    await agregarTurno("08:00:00", "09:00:00", "pendiente_pago", 1);
    result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(result).slots.map(slot => slot.horaInicio), ["09:30"]);

    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    await agregarTurno("08:00:00", "09:00:00", "cancelado", 1);
    result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(result).slots.map(slot => slot.horaInicio), ["09:00", "09:30"]);
  });

  it("MIN_GAP respeta el vecino high-demand posterior y la igualdad del gap", async () => {
    await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    await configurarRegla("MIN_GAP", 30);
    await pool.query("UPDATE mascota_servicios SET duracion_minutos = 30 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [localPet, mascotaId, servicioId]);
    await agregarHorario("09:00:00", "10:30:00");
    await agregarTurno("10:00:00", "10:30:00", "activo", 1);
    const result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(result).slots.map(slot => slot.horaInicio), ["09:00"]);
  });

  it("MAX_PER_DAY cuenta activos, pendientes y completados high-demand; excluye cancelados", async () => {
    await pool.query("UPDATE mascotas SET alta_exigencia = 1 WHERE id = ? AND local_id = ?", [mascotaId, localPet]);
    await configurarRegla("MAX_PER_DAY", 1);
    await agregarHorario("09:00:00", "11:00:00");
    await agregarTurno("08:00:00", "08:30:00", "completado", 1);
    let result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: unknown[] }>(result).slots, []);

    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    await agregarTurno("08:00:00", "08:30:00", "cancelado", 1);
    result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.ok(json<{ slots: unknown[] }>(result).slots.length > 0);

    await pool.query("DELETE FROM turnos WHERE local_id = ? AND mascota_id = ?", [localPet, mascotaId]);
    await agregarTurno("08:00:00", "08:30:00", "pendiente_pago", 1);
    result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: unknown[] }>(result).slots, []);
  });

  it("omite turnos BEAUTY y no mezcla su ocupación/high-demand con PET", async () => {
    await agregarHorario("09:00:00", "10:30:00");
    const [beautyStylist] = await pool.query<ResultSetHeader>("INSERT INTO estilistas (nombre, local_id) VALUES ('Fixture beauty stylist', ?)", [localPet]);
    await pool.query(
      `INSERT INTO turnos (fecha, hora, hora_fin, estilista_id, local_id, cliente_nombre, cliente_telefono, estado)
       VALUES (?, '09:00:00', '10:00:00', ?, ?, 'Fixture beauty turn', 'Fixture beauty', 'activo')`,
      [fechaFutura, beautyStylist.insertId, localPet],
    );
    const result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(result).slots.map(slot => slot.horaInicio), ["09:00", "09:30"]);
    await pool.query("DELETE FROM turnos WHERE local_id = ? AND estilista_id = ?", [localPet, beautyStylist.insertId]);
    await pool.query("DELETE FROM estilistas WHERE id = ? AND local_id = ?", [beautyStylist.insertId, localPet]);
  });

  it("fecha pasada devuelve 200 vacío y una fecha futura conserva los horarios", async () => {
    await agregarHorario("09:00:00", "10:30:00");
    const past = await http(queryPath({ mascotaId, servicioId, fecha: fechaPasada }));
    assert.equal(past.status, 200);
    assert.deepEqual(json<{ slots: unknown[] }>(past).slots, []);
    const future = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.equal(future.status, 200);
    assert.deepEqual(json<{ slots: Array<{ horaInicio: string }> }>(future).slots.map(slot => slot.horaInicio), ["09:00", "09:30"]);
  });

  it("filtra inicios pasados de hoy según el reloj Argentina y redondea segundos al minuto siguiente", async () => {
    const knownInstant = new Date("2026-10-20T13:30:20.000Z");
    assert.deepEqual(contextoTemporalArgentina(knownInstant), { fecha: "2026-10-20", minimumStartMinutes: 631 });

    await pool.query("UPDATE servicios SET duracion = 15 WHERE id = ?", [servicioId]);
    await pool.query("UPDATE mascota_servicios SET duracion_minutos = 15 WHERE local_id = ? AND mascota_id = ? AND servicio_id = ?", [localPet, mascotaId, servicioId]);
    const now = contextoTemporalArgentina();
    const [year, month, day] = now.fecha.split("-").map(Number);
    const todayDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    await agregarHorario("00:00:00", "23:59:00", todayDay);
    const result = await http(queryPath({ mascotaId, servicioId, fecha: now.fecha }));
    assert.equal(result.status, 200);
    const available = json<{ slots: Array<{ horaInicio: string }> }>(result).slots;
    assert.ok(available.every(slot => horaAMinutos(slot.horaInicio) >= now.minimumStartMinutes));
  });

  it("responde solo fecha, duración y slots; no expone tenant ni configuración interna", async () => {
    await agregarHorario("09:00:00", "10:30:00");
    const result = await http(queryPath({ mascotaId, servicioId, fecha: fechaFutura }));
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(json<Record<string, unknown>>(result)).sort(), ["duracionMinutos", "fecha", "slots"]);
    assert.deepEqual(json<{ slots: unknown[] }>(result).slots, [
      { horaInicio: "09:00", horaFin: "09:45" },
      { horaInicio: "09:30", horaFin: "10:15" },
    ]);
  });
});
