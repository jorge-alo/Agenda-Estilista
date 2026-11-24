// Manual transport-only probe: no dotenv, Express, database or scheduler imports.
async function main(): Promise<void> {
  if (process.env.EVOLUTION_API_VERSION !== "v2") {
    console.error("La prueba requiere EVOLUTION_API_VERSION=v2.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const recipient = process.env.EVOLUTION_TEST_RECIPIENT;
  if (!url || !key?.trim() || !recipient) {
    console.error("Definí EVOLUTION_API_URL, EVOLUTION_API_KEY y EVOLUTION_TEST_RECIPIENT.");
    process.exitCode = 1;
    return;
  }
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
  } catch {
    console.error("EVOLUTION_API_URL debe ser una URL HTTP(S) sin credenciales, query ni fragmento.");
    process.exitCode = 1;
    return;
  }
  if (!/^[1-9]\d{7,14}$/.test(recipient)) {
    console.error("EVOLUTION_TEST_RECIPIENT debe tener 8–15 dígitos, con código de país y sin +.");
    process.exitCode = 1;
    return;
  }

  // Load only after validating the environment: axios captures URL/key on import.
  const { sendPetWhatsAppWithReceipt } = await import("../features/notifications/infrastructure/whatsapp.provider");
  const receipt = await sendPetWhatsAppWithReceipt(
    recipient,
    "Prueba aislada de AgendaOK con Evolution API v2 (agendaok-test).",
    "agendaok-test",
  );
  if (receipt === null) {
    console.error("Resultado ambiguo: sin key.id válido. Revisá Evolution antes de repetir el envío.");
    process.exitCode = 1;
    return;
  }
  console.info("Evolution aceptó el mensaje para agendaok-test (key.id válido); no acredita entrega.");
}

void main().catch(() => {
  // Never print the Axios error, request, response, credentials or recipient.
  console.error("La prueba no pudo confirmar el envío. Revisá Evolution antes de repetirla.");
  process.exitCode = 1;
});

export {};
