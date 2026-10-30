export function buildPetAppointmentReminder(data: {
  localNombre: string; mascotaNombre: string; fecha: string; hora: string;
}): string {
  return `Hola. Te recordamos que mañana ${data.mascotaNombre} tiene turno en ${data.localNombre} a las ${data.hora} (${data.fecha}).`;
}
