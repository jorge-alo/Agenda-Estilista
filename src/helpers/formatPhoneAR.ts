export const formatPhoneAR = (phone: string): string => {
  // sacar espacios, guiones, etc
  let cleaned = phone.replace(/\D/g, "");

  // si empieza con 54, lo dejamos
  if (cleaned.startsWith("54")) {
    return cleaned;
  }

  // si empieza con 0 (ej: 011...)
  if (cleaned.startsWith("0")) {
    cleaned = cleaned.slice(1);
  }

  // si empieza con 15 (móvil típico)
  if (cleaned.startsWith("15")) {
    cleaned = cleaned.slice(2);
  }

  return "549" + cleaned;
};