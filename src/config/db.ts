import mysql from "mysql2/promise"
import dotenv from 'dotenv'
dotenv.config();

export const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
})

pool.getConnection()
    .then((conn) => {
        console.log("✅ DB conectada")
        conn.ping()
            .then(() => console.log("✅ Ping OK"))
            .catch(() => console.log("❌ Ping falló"))
        conn.release()
    })
    .catch(() => console.log("❌ Error DB"))