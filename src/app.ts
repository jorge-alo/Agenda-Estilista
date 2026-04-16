import express  from "express";
import cors from "cors"
import { AuthRouter } from "./features/auth/auth.routes";

const app = express();

app.use(cors())
app.use(express.json());

app.use("/api/auth", AuthRouter);

app.listen(3000, () => {
  console.log("Server corriendo en puerto 3000");
});

export default app