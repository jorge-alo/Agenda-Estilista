// src/features/notifications/infrastructure/evolution.client.ts
import axios from "axios";

const EVOLUTION_URL = process.env.EVOLUTION_API_URL!;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY!;

export const evolutionClient = axios.create({
  baseURL: EVOLUTION_URL,
   timeout: 5000,
  headers: {
    apikey: EVOLUTION_KEY,
    "Content-Type": "application/json",
  },
});