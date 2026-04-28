function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
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
  return { left: r.left - p, right: r.right + p, top: r.top - p, bottom: r.bottom + p, width: r.width, height: r.height };
}

function insetRect(r, inset) {
  const ins = Math.max(0, Number(inset) || 0);
  const left = r.left + ins;
  const right = r.right - ins;
  const top = r.top + ins;
  const bottom = r.bottom - ins;
  // 너무 줄이면 역전될 수 있으니 최소 면적 유지
  if (right <= left || bottom <= top) return r;
  return { left, right, top, bottom };
}

function tightEmojiBounds(textObj) {
  // Phaser Text bounds는 폰트의 line-height/여백을 포함해서 실제 이모지 실체보다 크게 잡히는 경우가 많다.
  // 특히 크기가 커질수록 "닿기 전 먹힘"이 심해져서, bounds를 크기에 비례해 안쪽으로 줄여 타이트 히트박스로 사용한다.
  const b = textObj.getBounds();
  const w = Math.max(1, b.width);
  const h = Math.max(1, b.height);
  const base = Math.min(w, h);
  const inset = base * 0.18;
  // 완전 접촉 판정이 너무 빡빡해지는 걸 방지하기 위한 아주 작은 오차 허용
  const eps = Math.max(1, base * 0.02);
  return expandRect(insetRect(b, inset), eps);
}

function hashToIndex(str, mod) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

const PLAYER_EMOJIS_SMALL = [
  "🐟",
  "🐠",
  "🐡",
  "🦐",
  "🦑",
  "🦀",
  "🐙",
  "🪼",
  "🦞",
  "🦪",
  "🦭",
  "🪸"
];

const PLAYER_EMOJIS_FISHY = [
  "🐟",
  "🐠",
  "🐡",
  "🦐",
  "🦑",
  "🦀",
  "🐙",
  "🪼",
  "🦞",
  "🦪",
  "🦭",
  "🪸",
  "🐬",
  "🐳",
  "🐋",
  "🦈",
  "🐊",
  "🦦"
];

const PLAYER_EMOJIS_BIG = ["🐬", "🐳", "🐋", "🦈", "🐊"];

function emojiForPlayer(playerId, size, isMe) {
  // "최대한 많이": 플레이어별로 고정된(일관된) 다양한 이모지를 부여
  const id = String(playerId ?? "");
  if (id.startsWith("hunter_")) return "👻";
  if (size >= 12) return PLAYER_EMOJIS_BIG[hashToIndex(id + ":big", PLAYER_EMOJIS_BIG.length)];
  if (size >= 6) return PLAYER_EMOJIS_FISHY[hashToIndex(id + ":mid", PLAYER_EMOJIS_FISHY.length)];
  const base = isMe ? PLAYER_EMOJIS_FISHY : PLAYER_EMOJIS_SMALL;
  return base[hashToIndex(id + ":sm", base.length)];
}

function emojiForFood(kind) {
  if (kind === "advanced") return "🦪"; // 진주 느낌
  if (kind === "remedial") return "🫧"; // 치유의 물방울
  return "🦠"; // 플랑크톤 느낌
}

export function createGameClient({ mountId, socket, ui }) {
  let world = { w: 2400, h: 1600 };
  let selfId = null;
  let lastState = null;
  let controlsEnabled = true;
  const frozen = new Map(); // playerId -> { untilMs, x, y }
  const eatCooldown = new Map(); // foodId -> lastEmitAtMs

  const entities = {
    players: new Map(), // id -> { emojiText, nameText, lvText, lastX }
    foods: new Map() // id -> { emojiText }
  };

  class MainScene extends Phaser.Scene {
    constructor() {
      super("main");
      this.cursors = null;
      this.keys = null;
      this.space = null;
      this.ocean = null;
      this.surface = null;
      this.seabed = null;
      this.depthOverlay = null;
      this.seabedDecor = [];
      this.lastInputSentAt = 0;
      this.lastSplitAt = 0;
      this.bgScrollX = 0;
      this.surfaceScrollX = 0;
      this.seabedScrollX = 0;
    }

    create() {
      selfId = ui.getSelfId();
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keys = this.input.keyboard.addKeys("W,A,S,D");
      this.space = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

      this.ensureOceanLayers();

      this.cameras.main.setBounds(0, 0, world.w, world.h);

      // 리사이즈 시(브라우저 줌/창 크기 변경) 화면 레이어 크기 동기화
      this.scale.on("resize", (gameSize) => {
        const w = gameSize.width;
        const h = gameSize.height;
        if (this.depthOverlay) this.depthOverlay.setSize(w, h);
        if (this.surface) this.surface.setSize(world.w, 120);
      });

      socket.on("hello", ({ selfId: sid, world: w }) => {
        selfId = sid;
        world = w;
        this.cameras.main.setBounds(0, 0, world.w, world.h);
        this.ensureOceanLayers(true);
      });
    }

    ensureOceanLayers(forceRebuild = false) {
      const oceanKey = "oceanTile";
      const surfaceKey = "surfaceWavesTile";
      const seabedKey = "seabedTile";

      if (forceRebuild) {
        for (const k of [oceanKey, surfaceKey, seabedKey]) {
          if (this.textures.exists(k)) this.textures.remove(k);
        }
      }

      if (!this.textures.exists(oceanKey)) {
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0x052033, 1);
        g.fillRect(0, 0, 256, 256);
        g.fillStyle(0x0b3a5a, 0.35);
        for (let i = 0; i < 14; i += 1) {
          const x = (i * 19) % 256;
          const y = (i * 37) % 256;
          g.fillCircle(x, y, 18);
        }
        g.lineStyle(2, 0x38bdf8, 0.08);
        for (let y = 18; y <= 256; y += 46) g.lineBetween(0, y, 256, y - 8);
        g.generateTexture(oceanKey, 256, 256);
        g.destroy();
      }

      if (!this.textures.exists(surfaceKey)) {
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.clear();
        g.fillStyle(0x0ea5e9, 0.0);
        g.fillRect(0, 0, 512, 96);
        // Phaser Graphics는 베지어 API가 빌드/버전에 따라 없을 수 있어
        // 안정적으로 lineTo + 사인파로 파도 라인을 만든다.
        const drawWave = ({ y, amp, period, step, color, alpha, thickness, phase }) => {
          g.lineStyle(thickness, color, alpha);
          g.beginPath();
          g.moveTo(0, y);
          for (let x = 0; x <= 512; x += step) {
            const yy = y + Math.sin((x / period) * Math.PI * 2 + phase) * amp;
            g.lineTo(x, yy);
          }
          g.strokePath();
        };

        drawWave({ y: 50, amp: 8, period: 160, step: 8, color: 0xa5f3fc, alpha: 0.22, thickness: 3, phase: 0.2 });
        drawWave({ y: 64, amp: 5, period: 128, step: 8, color: 0xffffff, alpha: 0.10, thickness: 2, phase: 1.1 });
        drawWave({ y: 42, amp: 4, period: 96, step: 8, color: 0x38bdf8, alpha: 0.08, thickness: 2, phase: 2.4 });

        g.generateTexture(surfaceKey, 512, 96);
        g.destroy();
      }

      if (!this.textures.exists(seabedKey)) {
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0x04131f, 1);
        g.fillRect(0, 0, 512, 160);
        g.fillStyle(0x0b2a2a, 0.65);
        for (let x = 0; x < 520; x += 44) g.fillCircle(x + ((x * 7) % 18), 130 + ((x * 3) % 10), 18);
        g.fillStyle(0x134e4a, 0.55);
        for (let x = 0; x < 520; x += 36) {
          g.fillRect(x + 6, 70 + ((x * 5) % 28), 6, 70);
          g.fillRect(x + 16, 84 + ((x * 11) % 22), 5, 56);
        }
        g.lineStyle(2, 0x0b3a5a, 0.25);
        for (let x = 0; x <= 512; x += 64) g.lineBetween(x, 120, x + 24, 140);
        g.generateTexture(seabedKey, 512, 160);
        g.destroy();
      }

      if (this.ocean) this.ocean.destroy();
      this.ocean = this.add.tileSprite(0, 0, world.w, world.h, oceanKey);
      this.ocean.setOrigin(0, 0);
      this.ocean.setScrollFactor(0);
      this.ocean.setDepth(-120);

      if (this.surface) this.surface.destroy();
      this.surface = this.add.tileSprite(0, 0, world.w, 120, surfaceKey);
      this.surface.setOrigin(0, 0);
      this.surface.setScrollFactor(0);
      this.surface.setAlpha(0.55);
      this.surface.setDepth(-110);

      if (this.seabed) this.seabed.destroy();
      this.seabed = this.add.tileSprite(0, world.h - 180, world.w, 200, seabedKey);
      this.seabed.setOrigin(0, 0);
      this.seabed.setScrollFactor(1);
      this.seabed.setDepth(-105);

      for (const t of this.seabedDecor) t.destroy?.();
      this.seabedDecor = [];
      const decorEmojis = ["🪸", "🪨", "🌿", "🪵"];
      for (let x = 80; x < world.w; x += 220) {
        const e = decorEmojis[(x / 220) % decorEmojis.length];
        const t = this.add.text(x, world.h - 185 + ((x * 13) % 26), e, {
          fontFamily: "system-ui, Segoe UI, Apple Color Emoji, Noto Color Emoji, sans-serif",
          fontSize: "28px"
        });
        t.setOrigin(0.5, 0.5);
        t.setAlpha(0.55);
        t.setDepth(-104);
        this.seabedDecor.push(t);
      }

      if (this.depthOverlay) this.depthOverlay.destroy();
      this.depthOverlay = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x00121c, 0.0);
      this.depthOverlay.setOrigin(0, 0);
      this.depthOverlay.setScrollFactor(0);
      this.depthOverlay.setDepth(-109);
      this.depthOverlay.setBlendMode(Phaser.BlendModes.MULTIPLY);
    }

    update() {
      if (!selfId) selfId = ui.getSelfId();
      const t = performance.now();

      if (!controlsEnabled) return;

      // Space: split (쿨다운 800ms)
      if (this.space?.isDown && t - this.lastSplitAt > 800) {
        socket.emit("split");
        this.lastSplitAt = t;
      }

      const up = this.cursors.up.isDown || this.keys.W.isDown;
      const down = this.cursors.down.isDown || this.keys.S.isDown;
      const left = this.cursors.left.isDown || this.keys.A.isDown;
      const right = this.cursors.right.isDown || this.keys.D.isDown;

      const vx = (right ? 1 : 0) + (left ? -1 : 0);
      const vy = (down ? 1 : 0) + (up ? -1 : 0);
      const mag = Math.hypot(vx, vy) || 1;
      const nvx = vx / mag;
      const nvy = vy / mag;

      if (t - this.lastInputSentAt > 50) {
        socket.emit("input", { vx: nvx, vy: nvy });
        this.lastInputSentAt = t;
      }

      if (this.ocean) {
        this.bgScrollX += 0.35;
        this.ocean.tilePositionX = this.bgScrollX;
      }
      if (this.surface) {
        this.surfaceScrollX += 0.7;
        this.surface.tilePositionX = this.surfaceScrollX;
      }
      if (this.seabed) {
        this.seabedScrollX += 0.12;
        this.seabed.tilePositionX = this.seabedScrollX;
      }

      // 수심에 따른 색/암도 조절 (카메라 Y 기반)
      if (this.depthOverlay) {
        const camY = this.cameras.main.scrollY;
        const depth01 = clamp(camY / Math.max(1, world.h - this.scale.height), 0, 1);
        // 얕은 바다: 밝은 청록, 깊은 바다: 어두운 남색
        const alpha = 0.08 + depth01 * 0.32;
        this.depthOverlay.setFillStyle(0x00121c, alpha);
      }

      this.tryEatFoods();
    }

    tryEatFoods() {
      if (!lastState || !selfId) return;
      const me = lastState.players.find((p) => p.id === selfId);
      if (!me) return;

      const scene = phaser.scene.getScene("main");
      if (!scene) return;

      const meEnt = entities.players.get(selfId);
      if (!meEnt?.emojiText) return;
      // 텍스트는 폰트 사이즈가 바뀌므로, bounds 기반이 가장 정확하다.
      const meBounds = tightEmojiBounds(meEnt.emojiText);

      for (const f of lastState.foods) {
        const fEnt = entities.foods.get(f.id);
        if (!fEnt?.emojiText) continue;
        const foodBounds = tightEmojiBounds(fEnt.emojiText);
        if (rectsTouchOrOverlap(meBounds, foodBounds)) {
          const t = Date.now();
          const prev = eatCooldown.get(f.id) ?? 0;
          if (t - prev < 250) continue;
          eatCooldown.set(f.id, t);
          socket.emit("eat_food", { foodId: f.id });
        }
      }
    }
  }

  const config = {
    type: Phaser.AUTO,
    parent: mountId,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#052033",
    scene: [MainScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    }
  };

  const phaser = new Phaser.Game(config);

  function ensurePlayerEnt(scene, p) {
    let ent = entities.players.get(p.id);
    if (ent) return ent;
    const emojiText = scene.add.text(0, 0, "🐟", {
      fontFamily: "system-ui, Segoe UI, Apple Color Emoji, Noto Color Emoji, sans-serif",
      fontSize: "24px"
    });
    emojiText.setOrigin(0.5, 0.5);
    emojiText.setScale(1, 1);

    const nameText = scene.add.text(0, 0, p.name, {
      fontFamily: "system-ui, Segoe UI, sans-serif",
      fontSize: "12px",
      color: "#ffffff"
    });
    // 이름이 너무 떠 보이지 않게, 캐릭터에 더 바짝 붙임
    nameText.setOrigin(0.5, 1.0);

    const lvText = scene.add.text(0, 0, "", {
      fontFamily: "system-ui, Segoe UI, sans-serif",
      fontSize: "11px",
      color: "rgba(255,255,255,0.92)"
    });
    lvText.setOrigin(0.5, 0.0);

    ent = { emojiText, nameText, lvText, lastX: p.x };
    entities.players.set(p.id, ent);
    return ent;
  }

  function ensureFoodEnt(scene, f) {
    let ent = entities.foods.get(f.id);
    if (ent) return ent;
    const emojiText = scene.add.text(0, 0, emojiForFood(f.kind), {
      fontFamily: "system-ui, Segoe UI, Apple Color Emoji, Noto Color Emoji, sans-serif",
      fontSize: "20px"
    });
    emojiText.setOrigin(0.5, 0.5);
    ent = { emojiText };
    entities.foods.set(f.id, ent);
    return ent;
  }

  function renderState(snap) {
    lastState = snap;
    const scene = phaser.scene.getScene("main");
    if (!scene) return;

    // Players
    const seenPlayers = new Set();
    for (const p of snap.players) {
      seenPlayers.add(p.id);
      const isMe = p.id === selfId;
      const ent = ensurePlayerEnt(scene, p);
      const fr = frozen.get(p.id);
      const now = Date.now();
      const dying = fr && now < fr.untilMs;

      if (!dying) {
        ent.emojiText.setText(emojiForPlayer(p.id, p.size, isMe));
        ent.emojiText.setFontSize(`${fontPxForPlayerSize(p.size)}px`);
        const penalized = now < (p.frozenUntil ?? 0);
        const shielded = now < p.shieldUntil;
        const alpha = penalized ? 0.3 + 0.2 * Math.sin(now / 150) : shielded ? 0.55 : 0.9;
        ent.emojiText.setAlpha(alpha);
        ent.emojiText.setPosition(p.x, p.y);
        ent.nameText.setText(p.name);
        // 시각적인 배치만: 히트박스 판정은 bounds 기반으로 처리
        ent.nameText.setPosition(p.x, p.y - Math.max(12, fontPxForPlayerSize(p.size) * 0.65));
      } else {
        ent.emojiText.setPosition(fr.x, fr.y);
        ent.nameText.setPosition(fr.x, fr.y - Math.max(12, fontPxForPlayerSize(p.size) * 0.65));
      }

      if (!dying) {
        if (ent.lvText) {
          const show = isMe;
          ent.lvText.setVisible(show);
          if (show) {
            ent.lvText.setText(`LV ${Math.max(1, Number(p.size) || 1)}`);
            const bb = ent.emojiText.getBounds();
            ent.lvText.setPosition(bb.centerX, bb.bottom + 2);
          }
        }

        const dx = p.x - (ent.lastX ?? p.x);
        if (Math.abs(dx) > 0.5) {
          const dir = dx < 0 ? 1 : -1;
          ent.emojiText.setScale(dir, 1);
        }
        ent.lastX = p.x;
      }
    }
    for (const [id, ent] of entities.players.entries()) {
      if (seenPlayers.has(id)) continue;
      ent.emojiText.destroy();
      ent.nameText.destroy();
      ent.lvText?.destroy?.();
      entities.players.delete(id);
    }

    // Foods
    const seenFoods = new Set();
    for (const f of snap.foods) {
      seenFoods.add(f.id);
      const ent = ensureFoodEnt(scene, f);
      ent.emojiText.setText(emojiForFood(f.kind));
      ent.emojiText.setFontSize(`${foodFontPx(f.kind)}px`);
      ent.emojiText.setPosition(f.x, f.y);
    }
    for (const [id, ent] of entities.foods.entries()) {
      if (seenFoods.has(id)) continue;
      ent.emojiText.destroy();
      entities.foods.delete(id);
    }

    // Camera follow
    const me = snap.players.find((p) => p.id === selfId);
    if (me) {
      scene.cameras.main.scrollX = clamp(me.x - scene.scale.width / 2, 0, world.w - scene.scale.width);
      scene.cameras.main.scrollY = clamp(me.y - scene.scale.height / 2, 0, world.h - scene.scale.height);
    }
  }

  function onFoodSpawn(f) {
    const scene = phaser.scene.getScene("main");
    if (!scene) return;
    ensureFoodEnt(scene, f);
  }

  function onFoodDespawn(id) {
    const ent = entities.foods.get(id);
    if (!ent) return;
    ent.emojiText.destroy();
    entities.foods.delete(id);
    eatCooldown.delete(id);
  }

  function onPlayerRespawn({ id }) {
    if (id === selfId) ui.toast("잡아먹혔다! 즉시 부활!");
  }

  function onPlayerEaten({ eaterId, victimId, eater, victim }) {
    const scene = phaser.scene.getScene("main");
    if (!scene) return;
    const victimEnt = entities.players.get(victimId);
    const eaterEnt = entities.players.get(eaterId);
    if (!victimEnt) return;

    const vText = victimEnt.emojiText;
    const vName = victimEnt.nameText;
    const now = Date.now();
    frozen.set(victimId, { untilMs: now + 3000, x: vText.x, y: vText.y });

    // 이미 애니메이션 중이면 중복 방지
    if (vText._eatenTween) return;

    // 이동을 멈춘 상태에서 3초간 페이드아웃
    vText._eatenTween = scene.tweens.add({
      targets: [vText, vName],
      alpha: 0,
      duration: 3000,
      ease: "Linear",
      onComplete: () => {
        vText._eatenTween = null;
        frozen.delete(victimId);
        vText.setAlpha(1);
        vName.setAlpha(1);
        // 스케일은 다음 state에서 다시 세팅됨
      }
    });

    if (victimId === selfId) {
      controlsEnabled = false;
      window.setTimeout(() => {
        // 리스폰 카운트다운이 다시 잠글 수 있으니, 여기서는 일단 해제만
        controlsEnabled = true;
      }, 3000);
    }
  }

  function setWorld(w) {
    world = w;
  }

  function onState(snap) {
    renderState(snap);
  }

  return {
    setWorld,
    onState,
    onFoodSpawn,
    onFoodDespawn,
    onPlayerRespawn
    ,
    onPlayerEaten,
    setControlsEnabled: (v) => {
      controlsEnabled = Boolean(v);
    }
  };
}

