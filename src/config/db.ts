import mysql from "mysql2/promise"
import dotenv from 'dotenv'
dotenv.config();

// 👇 AGREGÁ ESTO
console.log("DB_HOST:", process.env.DB_HOST)
console.log("DB_PORT:", process.env.DB_PORT)
console.log("DB_USER:", process.env.DB_USER)
console.log("DB_NAME:", process.env.DB_NAME)
console.log("DATABASE_URL:", process.env.DATABASE_URL)

export const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
})

// 🔥 probar DB
pool.getConnection()
  .then(() => console.log("✅ DB conectada"))
  .catch((err) => console.log("❌ Error DB:", err));