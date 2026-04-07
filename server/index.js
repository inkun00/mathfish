import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server as SocketIOServer } from "socket.io";

import { createGame } from "./state.js";
import { loadQuestionData } from "./questions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(projectRoot, "public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" }
});

const questionData = await loadQuestionData(path.join(__dirname, "data"));
const game = createGame({ io, questionData });

io.on("connection", (socket) => {
  game.onConnect(socket);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[MathFish] listening on :${PORT}`);
});

