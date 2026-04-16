export type UserRole = "admin" | "estilista";

export type User = {
  id: number;
  email: string;
  password: string;
  rol: UserRole;
  local_id: number;
};