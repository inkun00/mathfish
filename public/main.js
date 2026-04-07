import { createUI } from "./ui.js";
import { createGameClient } from "./phaserGame.js";

function showFatal(msg) {
  const el = document.getElementById("fatalOverlay");
  if (!el) return;
  el.textContent = String(msg ?? "알 수 없는 오류");
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
}

window.addEventListener("error", (e) => {
  const m = e?.error?.stack || e?.message || "스크립트 오류";
  showFatal(`[치명적 오류]\n${m}`);
});

window.addEventListener("unhandledrejection", (e) => {
  const r = e?.reason;
  const m = r?.stack || String(r ?? "Promise 오류");
  showFatal(`[치명적 오류]\n${m}`);
});

if (!window.Phaser) {
  showFatal(
    [
      "[치명적 오류]",
      "Phaser 라이브러리를 불러오지 못했어.",
      "원인 후보: 인터넷/방화벽으로 CDN 차단, 확장프로그램 차단, 오프라인.",
      "해결: 인터넷 연결 확인 후 새로고침 또는 Phaser를 로컬 파일로 포함."
    ].join("\n")
  );
}

const socket = window.io();

let ui = null;
let game = null;

try {
  ui = createUI({
    socket,
    els: {
      me: document.getElementById("me"),
      levelHud: document.getElementById("levelHud"),
      startOverlay: document.getElementById("startOverlay"),
      nameModal: document.getElementById("nameModal"),
      nameTitle: document.getElementById("nameTitle"),
      namePrompt: document.getElementById("namePrompt"),
      nameInput: document.getElementById("nameInput"),
      nameSubmit: document.getElementById("nameSubmit"),
      rankingList: document.getElementById("rankingList"),
      toast: document.getElementById("toast"),
      questionModal: document.getElementById("questionModal"),
      qTitle: document.getElementById("qTitle"),
      qPrompt: document.getElementById("qPrompt"),
      qTimer: document.getElementById("qTimer"),
      qInputArea: document.getElementById("qInputArea"),
      qCancel: document.getElementById("qCancel"),
      qSubmit: document.getElementById("qSubmit"),
      turtleBar: document.getElementById("turtleBar"),
      turtlePrompt: document.getElementById("turtlePrompt"),
      turtleAnswer: document.getElementById("turtleAnswer"),
      turtleSubmit: document.getElementById("turtleSubmit")
    }
  });
} catch (e) {
  showFatal(`[UI 초기화 실패]\n${e?.stack || e}`);
}

try {
  if (ui && window.Phaser) {
    game = createGameClient({
      mountId: "game",
      socket,
      ui
    });
  }
} catch (e) {
  showFatal(`[게임 초기화 실패]\n${e?.stack || e}`);
}

socket.on("hello", ({ selfId, world, name }) => {
  ui?.setMe({ selfId, name });
  game?.setWorld(world);
  game?.setControlsEnabled?.(false);
  ui
    ?.promptName?.({ title: "이름 설정", cta: "시작" })
    ?.then(() => {
      ui?.startCountdown?.(5);
      window.setTimeout(() => game?.setControlsEnabled?.(true), 5000);
    });
});

socket.on("state", (snap) => {
  game?.onState(snap);
  ui?.onState?.(snap);
});

socket.on("ranking", ({ top }) => {
  ui?.setRanking(top);
});

socket.on("question", ({ q }) => {
  ui?.openQuestion(q);
});

socket.on("answer_result", ({ ok, correctAnswer }) => {
  ui?.onAnswerResult({ ok, correctAnswer });
});

socket.on("hint", ({ tooltip, extraHint }) => {
  ui?.toast([tooltip, extraHint].filter(Boolean).join(" "));
});

socket.on("toast", ({ msg, to }) => {
  const self = ui?.getSelfId?.();
  if (to && to !== self) return;
  ui?.toast(msg);
});

socket.on("food_spawn", (f) => game?.onFoodSpawn?.(f));
socket.on("food_despawn", ({ id }) => game?.onFoodDespawn?.(id));
socket.on("player_respawn", (p) => {
  game?.onPlayerRespawn?.(p);
  const self = ui?.getSelfId?.();
  if (self && p?.id === self) {
    game?.setControlsEnabled?.(false);
    ui
      ?.promptName?.({ title: "새로 태어났어!", cta: "다시 시작" })
      ?.then(() => {
        ui?.startCountdown?.(5);
        window.setTimeout(() => game?.setControlsEnabled?.(true), 5000);
      });
  }
});
socket.on("player_eaten", (e) => game?.onPlayerEaten?.(e));

socket.on("turtle_start", ({ id, prompt }) => {
  ui?.openTurtle({ id, prompt });
});

socket.on("turtle_end", ({ answeredBy }) => {
  ui?.closeTurtle({ answeredBy });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ui?.submitQuestionIfOpen?.();
});

