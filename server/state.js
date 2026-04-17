function nowMs() {
  return Date.now();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

function radiusForSize(size) {
  return 14 + size * 4;
}

function speedForSize(size, baseSpeed) {
  const slow = Math.max(0, size - 1) * 0.05;
  return Math.max(0.6, baseSpeed - slow);
}

function makeFood({ kind, x, y, questionKey }) {
  return {
    id: makeId("food"),
    kind,
    x,
    y,
    r: kind === "advanced" ? 12 : kind === "remedial" ? 10 : 9,
    questionKey
  };
}

function pickFoodQuestionKey({ kind, questionData }) {
  // 심화(자릿수 타임어택)는 비활성화
  if (kind === "advanced") return "mul_normal";
  // 나눗셈이 충분히 노출되도록 분포를 조정
  if (kind === "remedial") return Math.random() < 0.9 ? "div_10s" : "mul_zeros";
  // 사용자가 "안 나온다"를 느끼지 않게 기본은 나눗셈을 더 강하게 우선
  return Math.random() < 0.85 ? "div_normal" : "mul_normal";
}

function buildQuestion({ questionKey, questionData, player }) {
  if (questionKey === "mul_normal") {
    const tier = player?.mulBasicTier ?? questionData.mulBasicTier.default;
    return questionData.generators.mul_normal(tier);
  }
  if (questionKey === "mul_zeros") {
    const tier = player?.mulBasicTier ?? questionData.mulBasicTier.default;
    return questionData.generators.mul_zeros(tier);
  }
  if (questionKey === "div_normal") {
    const tier = player?.divBasicTier ?? questionData.divBasicTier.default;
    return questionData.generators.div_normal(tier);
  }
  const gen = questionData.generators[questionKey];
  if (!gen) throw new Error(`Unknown questionKey: ${questionKey}`);
  return gen();
}

export function createGame({ io, questionData }) {
  const WORLD = {
    w: 2400,
    h: 1600
  };

  const TICK_HZ = 20;
  const tickMs = Math.floor(1000 / TICK_HZ);
  const MOVE_SCALE = 0.7; // 이동 속도 30% 감소

  const players = new Map(); // socket.id -> player
  const foods = new Map(); // foodId -> food

  // 게임 오버(포식) 시점의 최고 기록 리더보드(서버 메모리)
  // - 의도: "죽었을 때의 크기"를 기록해 학습/플레이 성취감을 남긴다.
  // - 범위: 봇은 제외(사람 기록만)
  const gameOverRecords = []; // { name, size, byName, at }

  let turtleEvent = null; // { id, question, startedAt }
  let nextTurtleAt = nowMs() + 5 * 60 * 1000;

  const BOT_COUNT = 25;
  const botIds = new Set();
  let botSerial = 0;

  function pickBotSize() {
    // 1~20단계, 작은 물고기가 더 많도록 가중 분포
    const r = Math.random();
    if (r < 0.35) return Math.floor(rand(1, 5));    // 1~4: 35%
    if (r < 0.65) return Math.floor(rand(5, 10));   // 5~9: 30%
    if (r < 0.85) return Math.floor(rand(10, 15));  // 10~14: 20%
    return Math.floor(rand(15, 21));                 // 15~20: 15%
  }

  function makeBot() {
    botSerial += 1;
    const id = `bot_${botSerial}_${Math.random().toString(36).slice(2, 7)}`;
    const fixedSize = pickBotSize();
    const p = {
      id,
      name: `AI물고기${botSerial}`,
      x: rand(60, WORLD.w - 60),
      y: rand(60, WORLD.h - 60),
      vx: rand(-1, 1),
      vy: rand(-1, 1),
      size: fixedSize,
      combo: 0,
      baseSpeed: 1.3,
      speed: 1.3,
      shieldUntil: 0,
      pvpUntil: 0,
      pendingQuestion: null,
      streak: 0,
      bot: { nextDirAt: 0, fixedSize }
    };
    botIds.add(id);
    players.set(id, p);
  }

  for (let i = 0; i < BOT_COUNT; i += 1) makeBot();

  function safeEmit(socket, event, payload) {
    if (!socket) return;
    socket.emit(event, payload);
  }

  function resolveAnswer({ p, pq, userAnswer, socket }) {
    // 사람/AI 모두 풀이시간 기록 (askedAt 기반). 사람들의 가장 느린 속도에 AI를 맞추기 위함.
    if (pq?.askedAt) {
      const dur = nowMs() - pq.askedAt;
      if (Number.isFinite(dur) && dur >= 0) {
        const prev = Number.isFinite(p.avgSolveMs) ? p.avgSolveMs : dur;
        // EMA (20% 새 값)
        p.avgSolveMs = prev * 0.8 + dur * 0.2;
      }
    }

    const correct = userAnswer === pq.q.answer;

    if (correct) {
      p.streak += 1;
      p.combo += 1;
      if (pq.q.domain === "mul") p.mulWrongStreak = 0;
      if (pq.q.domain === "div") p.divWrongStreak = 0;
      if (!p.bot) {
        p.size += 1;
      }
      p.baseSpeed = clamp(p.baseSpeed + 0.02, 1.2, 2.2);
      if (pq.q.domain === "mul" && (pq.q.meta?.kind === "vertical_mul" || pq.q.meta?.kind === "mul_with_zeros")) {
        const { min, max } = questionData.mulBasicTier;
        p.mulBasicTier = clamp(p.mulBasicTier + 1, min, max);
      }
      if (pq.q.domain === "div") {
        const { min, max } = questionData.divBasicTier;
        p.divBasicTier = clamp(p.divBasicTier + 1, min, max);
      }
      if (p.streak >= 3) p.streak = 0;
      safeEmit(socket, "answer_result", { ok: true, correctAnswer: pq.q.answer });
    } else {
      p.streak = 0;
      p.combo = 0;
      p.baseSpeed = clamp(p.baseSpeed - 0.08, 1.0, 2.2);
      if (pq.q.domain === "mul") p.mulWrongStreak = (p.mulWrongStreak ?? 0) + 1;
      if (pq.q.domain === "div") p.divWrongStreak = (p.divWrongStreak ?? 0) + 1;

      const pattern = questionData.detectErrorPattern({
        domain: pq.q.domain,
        meta: pq.q.meta,
        correctAnswer: pq.q.answer,
        userAnswer
      });

      if (pattern) {
        safeEmit(socket, "hint", {
          code: pattern.code,
          tooltip: pattern.tooltip,
          extraHint: questionData.questions?.remedial?.[pattern.remedialKey]?.hint ?? null
        });
      } else {
        safeEmit(socket, "hint", { code: "GENERIC", tooltip: "천천히 다시 생각해봐!" });
      }

      p.bias.remedialNext = true;
      if (pq.q.domain === "div") p.bias.remedialNextKey = "div_10s";
      else if (pq.q.domain === "mul") p.bias.remedialNextKey = "mul_zeros";
      else p.bias.remedialNextKey = "div_10s";

      if (pq.q.domain === "mul" && (pq.q.meta?.kind === "vertical_mul" || pq.q.meta?.kind === "mul_with_zeros")) {
        const { min, max } = questionData.mulBasicTier;
        const extraDown = clamp(Math.floor(((p.mulWrongStreak ?? 1) - 1) / 2), 0, 2);
        p.mulBasicTier = clamp(p.mulBasicTier - (1 + extraDown), min, max);
      }
      if (pq.q.domain === "div") {
        const { min, max } = questionData.divBasicTier;
        const extraDown = clamp(Math.floor(((p.divWrongStreak ?? 1) - 1) / 2), 0, 2);
        p.divBasicTier = clamp(p.divBasicTier - (1 + extraDown), min, max);
      }
      spawnFood("remedial", { x: p.x, y: p.y });
      // 오답/기권 시 5초간 이동 불가 + 무적 패널티
      const penaltyMs = 5000;
      const penaltyEnd = nowMs() + penaltyMs;
      p.frozenUntil = penaltyEnd;
      p.shieldUntil = penaltyEnd;
      p.pvpUntil = penaltyEnd;
      p.vx = 0;
      p.vy = 0;
      safeEmit(socket, "penalty", { until: penaltyEnd, durationMs: penaltyMs });
      safeEmit(socket, "answer_result", { ok: false, correctAnswer: pq.q.answer });
    }

    p.pendingQuestion = null;
    if (correct) {
      p.shieldUntil = nowMs() + 800;
      p.pvpUntil = p.shieldUntil;
    }
  }

  function botThinkAndAct(p, t) {
    if (!p.bot) return;
    if (t < p.bot.nextDirAt) return;

    // 1~3초마다 랜덤 방향 전환, 자유롭게 떠다님
    p.bot.nextDirAt = t + rand(1000, 3000);
    const angle = Math.random() * Math.PI * 2;
    p.vx = Math.cos(angle) * rand(0.3, 0.8);
    p.vy = Math.sin(angle) * rand(0.3, 0.8);
  }

  function broadcastSnapshot() {
    const snap = {
      t: nowMs(),
      world: WORLD,
      players: Array.from(players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        size: p.size,
        speed: p.speed,
        shieldUntil: p.shieldUntil,
        frozenUntil: p.frozenUntil ?? 0,
        combo: p.combo
      })),
      foods: Array.from(foods.values()),
      turtleEvent: turtleEvent
        ? { id: turtleEvent.id, startedAt: turtleEvent.startedAt, prompt: turtleEvent.question.prompt }
        : null
    };
    io.emit("state", snap);
  }

  function emitRanking() {
    const top = Array.from(players.values())
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, size: p.size }));
    io.emit("ranking", { top });
  }

  function emitGameOverRanking(toSocket = null) {
    const top = gameOverRecords
      .slice()
      .sort((a, b) => b.size - a.size || b.at - a.at)
      .slice(0, 10)
      .map((r) => ({ name: r.name, size: r.size, byName: r.byName ?? null, at: r.at }));
    if (toSocket) toSocket.emit("gameover_ranking", { top });
    else io.emit("gameover_ranking", { top });
  }

  function recordGameOver({ victim, eater }) {
    if (!victim || victim.bot) return;
    const size = Number(victim.size);
    if (!Number.isFinite(size) || size <= 0) return;
    gameOverRecords.push({
      name: victim.name,
      size,
      byName: eater?.name ?? null,
      at: nowMs()
    });
    // 메모리 폭주 방지
    if (gameOverRecords.length > 200) gameOverRecords.splice(0, gameOverRecords.length - 200);
    emitGameOverRanking();
  }

  function spawnFood(kind, near = null) {
    const x = near ? clamp(near.x + rand(-120, 120), 40, WORLD.w - 40) : rand(40, WORLD.w - 40);
    const y = near ? clamp(near.y + rand(-120, 120), 40, WORLD.h - 40) : rand(40, WORLD.h - 40);
    const questionKey = pickFoodQuestionKey({ kind, questionData });
    const f = makeFood({ kind, x, y, questionKey });
    foods.set(f.id, f);
    io.emit("food_spawn", f);
  }

  function ensureFoods() {
    const desired = 90;
    if (foods.size >= desired) return;
    const deficit = desired - foods.size;
    for (let i = 0; i < deficit; i += 1) {
      const roll = Math.random();
      // 심화 먹이(advanced)는 비활성화
      const kind = roll < 0.18 ? "remedial" : "normal";
      spawnFood(kind);
    }
  }

  function startTurtleEvent() {
    const q = questionData.generators.word_rescue();
    turtleEvent = { id: makeId("turtle"), question: q, startedAt: nowMs(), answeredBy: null };
    io.emit("turtle_start", { id: turtleEvent.id, prompt: q.prompt, timeLimitMs: q.timeLimitMs });
  }

  function endTurtleEvent() {
    if (!turtleEvent) return;
    io.emit("turtle_end", { id: turtleEvent.id, answeredBy: turtleEvent.answeredBy });
    turtleEvent = null;
    nextTurtleAt = nowMs() + 5 * 60 * 1000;
  }

  function tick() {
    const t = nowMs();
    ensureFoods();
    ensureBots();

    if (!turtleEvent && t >= nextTurtleAt) startTurtleEvent();
    if (turtleEvent && t - turtleEvent.startedAt > turtleEvent.question.timeLimitMs + 3000) endTurtleEvent();

    for (const p of players.values()) {
      const sp = speedForSize(p.size, p.baseSpeed);
      p.speed = sp;
      if (p.bot) botThinkAndAct(p, t);
      if (p.pendingQuestion || t < (p.frozenUntil ?? 0)) {
        p.vx = 0;
        p.vy = 0;
      }
      p.x = clamp(p.x + p.vx * sp * 8 * MOVE_SCALE, 20, WORLD.w - 20);
      p.y = clamp(p.y + p.vy * sp * 8 * MOVE_SCALE, 20, WORLD.h - 20);
    }

    // PvP collisions
    const arr = Array.from(players.values());
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const a = arr[i];
        const b = arr[j];
        if (a.size === b.size) continue;
        const bigger = a.size > b.size ? a : b;
        const smaller = a.size > b.size ? b : a;
        // 최초 스폰/리스폰 직후: 잡아먹지도/먹히지도 않도록 양방향 PvP 잠금
        if (t < (bigger.pvpUntil ?? 0) || t < (smaller.pvpUntil ?? 0)) continue;
        if (t < smaller.shieldUntil) continue;
        // 최대한 좁은 포식 반경: 작은 물고기가 큰 물고기 안에 거의 "들어가야" 포식
        // (내접 접촉 기준) 거리 <= (Rb - Rs)
        const rb = radiusForSize(bigger.size);
        const rs = radiusForSize(smaller.size);
        const eatR = Math.max(2, rb - rs);
        if (dist2(bigger, smaller) <= eatR * eatR) {
          const ranked = arr
            .slice()
            .sort((x, y) => y.size - x.size)
            .map((p) => ({ id: p.id, name: p.name, size: p.size }));
          const victimRank = Math.max(
            1,
            ranked.findIndex((pp) => pp.id === smaller.id) + 1
          );
          const top = ranked.slice(0, 10);

          const gain = Math.max(1, Math.floor(smaller.size / 2));
          if (!bigger.bot) {
            bigger.size += gain;
          }
          bigger.combo += 1;
          io.emit("player_eaten", {
            eaterId: bigger.id,
            victimId: smaller.id,
            eater: { x: bigger.x, y: bigger.y },
            victim: { x: smaller.x, y: smaller.y },
            victimRank,
            victimSize: smaller.size,
            top
          });
          // 게임 오버 기록은 리스폰으로 size가 리셋되기 전에 저장
          recordGameOver({ victim: smaller, eater: bigger });
          io.emit("toast", { to: bigger.id, msg: `${smaller.name}를 잡아먹었다!` });
          respawn(smaller);
        }
      }
    }

    broadcastSnapshot();
  }

  function respawn(p) {
    if (p.bot) {
      const newSize = pickBotSize();
      p.size = newSize;
      p.bot.fixedSize = newSize;
      p.baseSpeed = 1.3;
    } else {
      p.size = 1;
      p.baseSpeed = 1.6;
    }
    p.combo = 0;
    p.vx = 0;
    p.vy = 0;
    p.shieldUntil = nowMs() + 5000;
    p.pvpUntil = nowMs() + 5000;
    p.x = rand(60, WORLD.w - 60);
    p.y = rand(60, WORLD.h - 60);
    p.pendingQuestion = null;
    io.emit("player_respawn", { id: p.id, x: p.x, y: p.y });
  }

  function ensureBots() {
    let botCount = 0;
    for (const id of botIds) {
      if (players.has(id)) botCount += 1;
    }
    const desired = Math.floor(rand(20, 31));
    while (botCount < desired) {
      makeBot();
      botCount += 1;
    }
  }

  function onConnect(socket) {
    const bornAt = nowMs();
    const p = {
      id: socket.id,
      name: `물고기${socket.id.slice(0, 4)}`,
      x: rand(60, WORLD.w - 60),
      y: rand(60, WORLD.h - 60),
      vx: 0,
      vy: 0,
      size: 1,
      growBank: 0,
      combo: 0,
      baseSpeed: 1.6,
      speed: 1.6,
      // 처음 탄생한 물고기: 3초간 잡아먹지도/먹히지도 않게
      shieldUntil: bornAt + 3000,
      pvpUntil: bornAt + 3000,
      frozenUntil: 0,
      pendingQuestion: null,
      streak: 0,
      mulWrongStreak: 0,
      divWrongStreak: 0,
      mulBasicTier: questionData.mulBasicTier.default,
      divBasicTier: questionData.divBasicTier.default,
      avgSolveMs: 2200,
      bias: { remedialNext: false, remedialNextKey: null }
    };
    players.set(socket.id, p);

    socket.emit("hello", {
      selfId: p.id,
      world: WORLD,
      name: p.name
    });

    emitRanking();
    emitGameOverRanking(socket);

    socket.on("set_name", ({ name }) => {
      const nm = String(name ?? "").trim().slice(0, 10);
      if (nm) p.name = nm;
    });

    socket.on("input", ({ vx, vy }) => {
      if (p.pendingQuestion) return;
      if (nowMs() < (p.frozenUntil ?? 0)) return;
      p.vx = clamp(Number(vx) || 0, -1, 1);
      p.vy = clamp(Number(vy) || 0, -1, 1);
    });

    socket.on("eat_food", ({ foodId }) => {
      const f = foods.get(foodId);
      if (!f) return;
      if (p.pendingQuestion) return;
      if (nowMs() < (p.frozenUntil ?? 0)) return;

      const r = radiusForSize(p.size) + f.r + 4;
      if (dist2(p, f) > r * r) return;

      foods.delete(foodId);
      io.emit("food_despawn", { id: foodId });

      const key = p.bias.remedialNext ? p.bias.remedialNextKey ?? "div_10s" : f.questionKey;
      const q = buildQuestion({ questionKey: key, questionData, player: p });
      p.pendingQuestion = { q, foodKind: f.kind, askedAt: nowMs() };
      if (q.timeLimitMs == null) p.shieldUntil = nowMs() + 24 * 60 * 60 * 1000;
      else p.shieldUntil = nowMs() + (q.timeLimitMs ?? 15000) + 2000;
      // 문제 풀이 중에는 이동/포식/피격 불가(양방향 PvP 잠금)
      p.pvpUntil = p.shieldUntil;
      p.vx = 0;
      p.vy = 0;
      p.bias.remedialNext = false;
      p.bias.remedialNextKey = null;

      socket.emit("question", {
        q: {
          id: q.id,
          domain: q.domain,
          level: q.level,
          prompt: q.prompt,
          timeLimitMs: q.timeLimitMs,
          ui: q.ui ?? { type: "number" },
          meta: q.meta ?? null
        }
      });
    });

    socket.on("answer", ({ questionId, answer }) => {
      const pq = p.pendingQuestion;
      if (!pq) return;
      if (pq.q.id !== questionId) return;

      const n = typeof answer === "number" ? answer : Number(answer);
      const userAnswer = Number.isFinite(n) ? n : null;
      resolveAnswer({ p, pq, userAnswer, socket });
      emitRanking();
    });

    socket.on("turtle_answer", ({ answer }) => {
      if (!turtleEvent) return;
      if (turtleEvent.answeredBy) return;
      const userAnswer = typeof answer === "number" ? answer : Number(answer);
      const ok = userAnswer === turtleEvent.question.answer;
      if (!ok) {
        const meta = turtleEvent.question.meta;
        const highlight =
          meta?.kind === "ceil_division" && meta.remainder !== 0 ? "나머지가 있으면 올림이 필요해!" : "핵심 어휘를 다시 확인해봐!";
        socket.emit("hint", { code: "WORD", tooltip: highlight });
        return;
      }

      turtleEvent.answeredBy = p.id;
      p.size += 4;
      p.baseSpeed = clamp(p.baseSpeed + 0.08, 1.2, 2.2);
      io.emit("toast", { msg: `${p.name}가 거북이를 구출했다! (+자석 효과)` });
      emitRanking();
      endTurtleEvent();
    });

    socket.on("disconnect", () => {
      if (p.size > 1) {
        recordGameOver({ victim: p, eater: null });
      }
      players.delete(socket.id);
      emitRanking();
    });
  }

  const timer = setInterval(tick, tickMs);
  timer.unref?.();

  return { onConnect };
}

