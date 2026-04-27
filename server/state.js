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

function fontPxForPlayerSize(size) {
  return Math.round(18 + Math.max(1, Number(size) || 1) * 2);
}

function foodFontPx(kind) {
  if (kind === "advanced") return 26;
  if (kind === "remedial") return 22;
  return 20;
}

function rectsTouchOrOverlap(a, b) {
  // Axis-aligned bounding boxes. "Touch" counts as collision (<= / >=).
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function expandRect(r, pad) {
  const p = Math.max(0, Number(pad) || 0);
  return { left: r.left - p, right: r.right + p, top: r.top - p, bottom: r.bottom + p };
}

function insetRect(r, inset) {
  const ins = Math.max(0, Number(inset) || 0);
  const left = r.left + ins;
  const right = r.right - ins;
  const top = r.top + ins;
  const bottom = r.bottom - ins;
  if (right <= left || bottom <= top) return r;
  return { left, right, top, bottom };
}

function tightServerBounds(r) {
  // 서버는 실제 glyph bounds를 알 수 없으니, 폰트 크기 기반 사각형을 "타이트"하게 줄여서
  // 클라이언트에서 보이는 이모지 실체에 더 가깝게 맞춘다.
  const w = Math.max(1, r.right - r.left);
  const h = Math.max(1, r.bottom - r.top);
  const base = Math.min(w, h);
  const inset = base * 0.18;
  const eps = Math.max(1, base * 0.02);
  return expandRect(insetRect(r, inset), eps);
}

function foodBoundsAtServer(f) {
  const fp = foodFontPx(f?.kind);
  const half = fp / 2;
  return tightServerBounds({ left: f.x - half, right: f.x + half, top: f.y - half, bottom: f.y + half });
}

function playerBoundsAtServer(p) {
  const fp = fontPxForPlayerSize(p?.size);
  const half = fp / 2;
  return tightServerBounds({ left: p.x - half, right: p.x + half, top: p.y - half, bottom: p.y + half });
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

function spawnPointFarFrom({ world, from, minDist = 600, tries = 24 }) {
  const fx = Number(from?.x);
  const fy = Number(from?.y);
  const d2min = (Number(minDist) || 0) ** 2;
  // from이 없거나 이상하면 그냥 랜덤
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || d2min <= 0) {
    return { x: rand(40, world.w - 40), y: rand(40, world.h - 40) };
  }

  let best = null;
  let bestD2 = -1;
  for (let i = 0; i < tries; i += 1) {
    const x = rand(40, world.w - 40);
    const y = rand(40, world.h - 40);
    const d2 = dist2({ x, y }, { x: fx, y: fy });
    if (d2 >= d2min) return { x, y };
    if (d2 > bestD2) {
      bestD2 = d2;
      best = { x, y };
    }
  }
  return best ?? { x: rand(40, world.w - 40), y: rand(40, world.h - 40) };
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
  const userGroups = new Map(); // ownerId -> { ownerId, level, xp, count }

  const MAX_USER_FISH = 32;
  /** 플레이어 그룹 대장의 성장 한도. 이보다 높아지면 성장하지 않고 새끼를 낳거나 새끼 레벨을 올린다. */
  const MAX_GROUP_LEVEL = 50;
  const TRAIL_MAX = 220; // 20Hz 기준 약 11초

  function getOrCreateGroup(ownerId, initialLevel = 1) {
    const oid = String(ownerId ?? "");
    if (!oid) return null;
    const g0 = userGroups.get(oid);
    if (g0) return g0;
    const g = {
      ownerId: oid,
      level: Math.min(MAX_GROUP_LEVEL, Math.max(1, Number(initialLevel) || 1)),
      xp: 0,
      count: 1
    };
    userGroups.set(oid, g);
    return g;
  }

  function groupMembers(ownerId) {
    const oid = String(ownerId ?? "");
    const arr = [];
    for (const p of players.values()) {
      if (p.bot) continue;
      if ((p.ownerId ?? p.id) === oid) arr.push(p);
    }
    return arr;
  }

  /** 리더는 g.level. 대장 LV 50 미만이면 새끼도 대장과 동일 크기로 맞춤. 50 도달 후에만 새끼별 offspringLevel 적용 */
  function syncGroupSizes(ownerId) {
    const g = userGroups.get(ownerId);
    if (!g) return;
    const atCap = g.level >= MAX_GROUP_LEVEL;
    for (const m of groupMembers(ownerId)) {
      if (m.follow) {
        if (!atCap) {
          m.offspringLevel = g.level;
          m.size = Math.min(MAX_GROUP_LEVEL, g.level);
        } else {
          const ol = Number.isFinite(m.offspringLevel) ? m.offspringLevel : g.level;
          m.size = Math.min(MAX_GROUP_LEVEL, Math.max(1, ol));
        }
      } else {
        m.size = Math.min(MAX_GROUP_LEVEL, g.level);
      }
    }
  }

  function setGroupLevel(ownerId, level) {
    const g = getOrCreateGroup(ownerId, level);
    if (!g) return;
    const lv = Math.min(MAX_GROUP_LEVEL, Math.max(1, Number(level) || 1));
    g.level = lv;
    for (const m of groupMembers(ownerId)) {
      if (m.follow) {
        m.offspringLevel = lv;
        m.size = lv;
      } else {
        m.size = lv;
      }
    }
  }

  function spawnOffspringFish(ownerId) {
    const leader = players.get(ownerId);
    if (!leader || leader.bot) return false;
    const members = groupMembers(ownerId);
    if (members.length >= MAX_USER_FISH) return false;

    const g = userGroups.get(ownerId);
    const followerIdx = members.length;
    const lagSteps = 10 * followerIdx;
    const id = makeId("fish");
    const fp = {
      id,
      ownerId,
      name: leader.name,
      x: leader.x,
      y: leader.y,
      vx: 0,
      vy: 0,
      size: 1,
      offspringLevel: 1,
      combo: 0,
      baseSpeed: 1.6,
      speed: 1.6,
      shieldUntil: nowMs() + 800,
      pvpUntil: nowMs() + 800,
      frozenUntil: 0,
      pendingQuestion: null,
      streak: 0,
      mulWrongStreak: 0,
      divWrongStreak: 0,
      mulBasicTier: leader.mulBasicTier,
      divBasicTier: leader.divBasicTier,
      avgSolveMs: leader.avgSolveMs,
      bias: { remedialNext: false, remedialNextKey: null },
      follow: { leaderId: ownerId, lagSteps }
    };
    players.set(id, fp);
    if (g) g.count = groupMembers(ownerId).length;
    return true;
  }

  /** 대장 레벨이 MAX에 도달한 뒤 '레벨업 한 번'에 해당하는 성장을 새끼에게 적용. 진행 불가면 false */
  function progressOffspringAtCap(ownerId) {
    const leader = players.get(ownerId);
    if (!leader || leader.bot) return false;

    const members = groupMembers(ownerId);
    const followers = members.filter((m) => m.follow);
    if (members.length < MAX_USER_FISH) {
      if (spawnOffspringFish(ownerId)) {
        io.emit("toast", { to: ownerId, msg: "새끼가 태어났다! (LV 1)" });
        emitRanking();
        return true;
      }
    }
    if (!followers.length) return false;

    const target = followers
      .slice()
      .sort(
        (a, b) =>
          (Number(a.offspringLevel) || a.size || 1) - (Number(b.offspringLevel) || b.size || 1)
      )[0];
    const cur = Math.max(1, Number(target.offspringLevel) || target.size || 1);
    if (cur >= MAX_GROUP_LEVEL) return false;
    const next = Math.min(MAX_GROUP_LEVEL, cur + 1);
    target.offspringLevel = next;
    target.size = next;
    io.emit("toast", { to: ownerId, msg: `새끼 성장! (LV ${next})` });
    emitRanking();
    return true;
  }

  function addGroupXp(ownerId, amount) {
    const g = getOrCreateGroup(ownerId, 1);
    if (!g) return;
    const add = Number(amount) || 0;
    if (!Number.isFinite(add) || add <= 0) return;
    g.xp += add;
    while (true) {
      const need = Math.max(1, groupMembers(ownerId).length);
      if (g.xp < need) break;
      if (g.level < MAX_GROUP_LEVEL) {
        g.xp -= need;
        g.level += 1;
      } else {
        const progressed = progressOffspringAtCap(ownerId);
        if (!progressed) break;
        g.xp -= need;
      }
    }
    syncGroupSizes(ownerId);
  }

  function applyGroupPenalty(ownerId, { untilMs }) {
    for (const m of groupMembers(ownerId)) {
      m.frozenUntil = Math.max(m.frozenUntil ?? 0, untilMs);
      m.shieldUntil = Math.max(m.shieldUntil ?? 0, untilMs);
      m.pvpUntil = Math.max(m.pvpUntil ?? 0, untilMs);
      m.vx = 0;
      m.vy = 0;
    }
  }

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
      if (!p.bot) addGroupXp(p.ownerId ?? p.id, 1);
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
      // 오답 보충 먹이는 "근처에 생겨서 바로 먹히는" 체감이 강하니, 맵의 다른 곳에 생성한다.
      // 최소 거리 보장(가능하면) + 실패 시에도 가장 멀리 뽑힌 후보를 사용.
      const pt = spawnPointFarFrom({ world: WORLD, from: p, minDist: 700, tries: 28 });
      spawnFood("remedial", pt);
      // 오답/기권 시 5초간 이동 불가 + 무적 패널티
      const penaltyMs = 5000;
      const penaltyEnd = nowMs() + penaltyMs;
      applyGroupPenalty(p.ownerId ?? p.id, { untilMs: penaltyEnd });
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
    const desired = 30;
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
      // follower는 리더 trail을 따라가며, penalty/pending 중에는 정지
      if (p.follow) {
        const leader = players.get(p.follow.leaderId);
        const lag = Math.max(1, Number(p.follow.lagSteps) || 1);
        if (leader?.trail?.length) {
          const idx = Math.max(0, leader.trail.length - 1 - lag);
          const target = leader.trail[idx];
          const dx = (target?.x ?? leader.x) - p.x;
          const dy = (target?.y ?? leader.y) - p.y;
          const mag = Math.hypot(dx, dy) || 1;
          p.vx = clamp(dx / mag, -1, 1);
          p.vy = clamp(dy / mag, -1, 1);
        }
      }
      if (p.pendingQuestion || t < (p.frozenUntil ?? 0)) {
        p.vx = 0;
        p.vy = 0;
      }
      p.x = clamp(p.x + p.vx * sp * 8 * MOVE_SCALE, 20, WORLD.w - 20);
      p.y = clamp(p.y + p.vy * sp * 8 * MOVE_SCALE, 20, WORLD.h - 20);
      if (p.trail) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > TRAIL_MAX) p.trail.splice(0, p.trail.length - TRAIL_MAX);
      }
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
        // 먹이와 동일한 기준으로: "이모지(텍스트) 실체가 닿을 때만" 포식 판정.
        // 반경 기반은 size가 커질수록 마진이 과대해져 "근처만 가도 먹힘" 체감이 발생한다.
        const bb = playerBoundsAtServer(bigger);
        const sb = playerBoundsAtServer(smaller);
        if (rectsTouchOrOverlap(bb, sb)) {
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
          if (!bigger.bot) addGroupXp(bigger.ownerId ?? bigger.id, gain);
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
      // 유저 물고기는 "죽으면 분열 상태가 풀리는" 대신,
      // 현재 그룹 레벨을 유지하고 리스폰(게임성). 단, follower는 완전 제거.
      if (p.follow) {
        players.delete(p.id);
        return;
      }
      const g = getOrCreateGroup(p.ownerId ?? p.id, p.size);
      p.size = Math.min(MAX_GROUP_LEVEL, g?.level ?? 1);
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
    const ownerId = socket.id;
    const g = getOrCreateGroup(ownerId, 1);
    const p = {
      id: socket.id,
      ownerId,
      name: `물고기${socket.id.slice(0, 4)}`,
      x: rand(60, WORLD.w - 60),
      y: rand(60, WORLD.h - 60),
      vx: 0,
      vy: 0,
      size: Math.min(MAX_GROUP_LEVEL, g?.level ?? 1),
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
    p.trail = [];
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
      // follower는 문제를 풀 수 없게(UI/동기화 단순화)
      if (p.follow) return;
      const f = foods.get(foodId);
      if (!f) return;
      if (p.pendingQuestion) return;
      if (nowMs() < (p.frozenUntil ?? 0)) return;

      // "이모지끼리 닿을 때만" 먹기 판정: bounds 기반(반경/마진 없음)
      const pb = playerBoundsAtServer(p);
      const fb = foodBoundsAtServer(f);
      if (!rectsTouchOrOverlap(pb, fb)) return;

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
      addGroupXp(p.ownerId ?? p.id, 4);
      p.baseSpeed = clamp(p.baseSpeed + 0.08, 1.2, 2.2);
      io.emit("toast", { msg: `${p.name}가 거북이를 구출했다! (+자석 효과)` });
      emitRanking();
      endTurtleEvent();
    });

    socket.on("split", () => {
      const g2 = getOrCreateGroup(ownerId, p.size);
      if (!g2) return;
      const curCount = Math.max(1, Number(g2.count) || 1);
      const nextCount = Math.min(MAX_USER_FISH, curCount * 2);
      if (nextCount === curCount) return;

      const nextLevel = Math.max(1, Math.floor((Number(g2.level) || p.size || 1) / 2));
      g2.count = nextCount;
      g2.xp = 0;
      setGroupLevel(ownerId, nextLevel);

      const existing = groupMembers(ownerId);
      const needAdd = nextCount - existing.length;
      // leader는 socket.id. follower는 leader trail을 lag로 따라감.
      let k = 0;
      while (k < needAdd) {
        const id = makeId("fish");
        const followerIdx = existing.length + k; // 0=leader, 1..N-1=follower
        const lagSteps = 10 * followerIdx;
        const fp = {
          id,
          ownerId,
          name: p.name,
          x: p.x,
          y: p.y,
          vx: 0,
          vy: 0,
          size: Math.min(MAX_GROUP_LEVEL, nextLevel),
          offspringLevel: Math.min(MAX_GROUP_LEVEL, nextLevel),
          combo: 0,
          baseSpeed: 1.6,
          speed: 1.6,
          shieldUntil: nowMs() + 800,
          pvpUntil: nowMs() + 800,
          frozenUntil: 0,
          pendingQuestion: null,
          streak: 0,
          mulWrongStreak: 0,
          divWrongStreak: 0,
          mulBasicTier: p.mulBasicTier,
          divBasicTier: p.divBasicTier,
          avgSolveMs: p.avgSolveMs,
          bias: { remedialNext: false, remedialNextKey: null },
          follow: { leaderId: ownerId, lagSteps }
        };
        players.set(id, fp);
        k += 1;
      }
      emitRanking();
      safeEmit(socket, "toast", { msg: `분열! (${nextCount}마리, LV ${nextLevel})`, to: ownerId });
    });

    socket.on("disconnect", () => {
      if (p.size > 1) {
        recordGameOver({ victim: p, eater: null });
      }
      // 그룹 물고기 전부 제거
      for (const m of groupMembers(ownerId)) players.delete(m.id);
      userGroups.delete(ownerId);
      emitRanking();
    });
  }

  const timer = setInterval(tick, tickMs);
  timer.unref?.();

  return { onConnect };
}

