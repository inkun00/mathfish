function el(tag, className) {
  const d = document.createElement(tag);
  if (className) d.className = className;
  return d;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function digitsOf(n) {
  return String(Math.abs(Number(n) || 0))
    .split("")
    .map((c) => Number(c));
}

function makeDigitInput({ kind = "digit", readonly = false } = {}) {
  const input = document.createElement("input");
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 1;
  if (kind === "carry") input.className = "vmulCarry";
  else if (kind === "divCarry") input.className = "vdivCarry";
  else input.className = "vmulDigit";
  if (readonly) {
    input.readOnly = true;
    input.tabIndex = -1;
    input.classList.add("readonly");
  } else {
    input.addEventListener("input", () => {
      const v = String(input.value ?? "");
      const d = v.replace(/[^0-9]/g, "").slice(-1);
      input.value = d;
    });
  }
  return input;
}

export function createUI({ socket, els }) {
  let selfId = null;
  let selfName = null;
  let openQuestion = null;
  let questionDeadline = 0;
  let questionTimer = null;
  let turtleOpen = null;

  function setMe({ selfId: id, name }) {
    selfId = id;
    selfName = name;
    els.me.textContent = `나: ${name}`;
  }

  function getSelfId() {
    return selfId;
  }

  function setLevel(size) {
    if (!els.levelHud) return;
    const lv = Math.max(1, Number(size) || 1);
    els.levelHud.textContent = `LV ${lv}`;
  }

  function onState(snap) {
    if (!selfId) return;
    const me = snap?.players?.find?.((p) => p.id === selfId);
    if (!me) return;
    setLevel(me.size);
  }

  function setRanking(top) {
    els.rankingList.innerHTML = "";
    for (const p of top) {
      const li = document.createElement("li");
      li.textContent = `${p.name} (크기 ${p.size})`;
      els.rankingList.appendChild(li);
    }
  }

  function setGameOverRanking(top) {
    if (!els.recordList) return;
    els.recordList.innerHTML = "";
    for (const r of top ?? []) {
      const li = document.createElement("li");
      const by = r.byName ? ` ← ${r.byName}` : "";
      li.textContent = `${r.name} (크기 ${r.size})${by}`;
      els.recordList.appendChild(li);
    }
  }

  function toast(msg) {
    if (!msg) return;
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => els.toast.classList.remove("show"), 1700);
  }

  function promptName({ title = "이름 설정", cta = "시작" } = {}) {
    if (!els.nameModal || !els.nameInput || !els.nameSubmit || !els.nameTitle) return Promise.resolve();
    els.nameTitle.textContent = title;
    els.nameSubmit.textContent = cta;
    const saved = window.localStorage?.getItem?.("mathfish_name") ?? "";
    els.nameInput.value = saved;

    els.nameModal.classList.remove("hidden");
    els.nameModal.setAttribute("aria-hidden", "false");
    els.nameInput.focus();
    els.nameInput.select?.();

    return new Promise((resolve) => {
      const cleanup = () => {
        els.nameModal.classList.add("hidden");
        els.nameModal.setAttribute("aria-hidden", "true");
        els.nameSubmit.removeEventListener("click", onSubmit);
        els.nameInput.removeEventListener("keydown", onKey);
      };

      const onSubmit = () => {
        const name = String(els.nameInput.value ?? "").trim().slice(0, 10);
        if (!name) {
          toast("이름을 입력해줘!");
          els.nameInput.focus();
          return;
        }
        window.localStorage?.setItem?.("mathfish_name", name);
        socket.emit("set_name", { name });
        cleanup();
        resolve();
      };

      const onKey = (e) => {
        if (e.key === "Enter") onSubmit();
      };

      els.nameSubmit.addEventListener("click", onSubmit);
      els.nameInput.addEventListener("keydown", onKey);
    });
  }

  function startCountdown(seconds = 5) {
    if (!els.startOverlay) return;
    const total = Math.max(1, Number(seconds) || 5);
    els.startOverlay.classList.remove("hidden");
    els.startOverlay.setAttribute("aria-hidden", "false");

    const startedAt = Date.now();
    const tick = () => {
      const leftMs = total * 1000 - (Date.now() - startedAt);
      const left = Math.ceil(leftMs / 1000);
      if (left <= 0) {
        els.startOverlay.textContent = "시작!";
        window.setTimeout(() => {
          els.startOverlay.classList.add("hidden");
          els.startOverlay.setAttribute("aria-hidden", "true");
        }, 350);
        return;
      }
      els.startOverlay.textContent = `준비… ${left}`;
      window.setTimeout(tick, 150);
    };
    tick();
  }

  function closeQuestion() {
    openQuestion = null;
    questionDeadline = 0;
    if (questionTimer) window.clearInterval(questionTimer);
    questionTimer = null;
    els.questionModal.classList.add("hidden");
    els.questionModal.setAttribute("aria-hidden", "true");
    els.qInputArea.innerHTML = "";
  }

  function renderNumberPad({ placeholder = "정답" } = {}) {
    const wrap = el("div");
    const row = el("div", "answerRow");
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = "";

    const pill = el("div", "pill");
    pill.textContent = "입력 중엔 보호막!";

    row.appendChild(input);
    row.appendChild(pill);

    const keypad = el("div", "keypad");
    const buttons = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "C"];
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = b;
      btn.addEventListener("click", () => {
        if (b === "C") input.value = "";
        else if (b === "⌫") input.value = input.value.slice(0, -1);
        else input.value += b;
        input.focus();
      });
      keypad.appendChild(btn);
    }

    wrap.appendChild(row);
    wrap.appendChild(keypad);
    els.qInputArea.appendChild(wrap);
    input.focus();
    return { input };
  }

  function renderChoice({ options }) {
    const wrap = el("div");
    const row = el("div", "answerRow");
    const pill = el("div", "pill");
    pill.textContent = "타임어택!";
    const selected = { value: null };

    const box = el("div");
    box.style.display = "grid";
    box.style.gridTemplateColumns = "repeat(3, 1fr)";
    box.style.gap = "8px";

    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = opt.label;
      btn.addEventListener("click", () => {
        selected.value = opt.value;
        for (const b of box.querySelectorAll("button")) b.style.outline = "none";
        btn.style.outline = "2px solid rgba(56,189,248,.8)";
      });
      box.appendChild(btn);
    }

    row.appendChild(el("div"));
    row.appendChild(pill);
    wrap.appendChild(row);
    wrap.appendChild(box);
    els.qInputArea.appendChild(wrap);
    return { selected };
  }

  function renderVerticalMul({ a, b }) {
    const wrap = el("div", "vmul");

    const top = el("div", "vmulHint");
    const help = el("div", "pill");
    help.textContent = "일의 자리부터 곱해봐!";
    top.appendChild(el("div"));
    top.appendChild(help);
    wrap.appendChild(top);

    const aDigits = digitsOf(a);
    const bDigits = digitsOf(b);
    const lenA = aDigits.length;
    const lenB = bDigits.length;
    const totalLen = lenA + lenB;

    const grid = el("div", "vmulGrid");

    const rowCarry1 = el("div", "vmulRow vmulRow--carry");
    const rowA = el("div", "vmulRow");
    const rowB = el("div", "vmulRow");
    const line1 = el("div", "vmulLine");
    const rowP1 = el("div", "vmulRow");
    const rowCarry2 = el("div", "vmulRow vmulRow--carry");
    const rowP2 = el("div", "vmulRow");
    const line2 = el("div", "vmulLine");
    const rowSum = el("div", "vmulRow");

    // columns are right-aligned, totalLen digits
    const carry1 = [];
    const p1 = [];
    const carry2 = [];
    const p2 = [];
    const sum = [];

    for (let i = 0; i < totalLen; i += 1) {
      const c1 = makeDigitInput({ kind: "carry" });
      carry1.push(c1);
      rowCarry1.appendChild(c1);

      const ad = makeDigitInput({ readonly: true });
      const aIdx = lenA - totalLen + i;
      ad.value = aIdx >= 0 ? String(aDigits[aIdx]) : "";
      rowA.appendChild(ad);

      const bd = makeDigitInput({ readonly: true });
      const bIdx = lenB - totalLen + i;
      bd.value = bIdx >= 0 ? String(bDigits[bIdx]) : "";
      rowB.appendChild(bd);

      const d1 = makeDigitInput();
      p1.push(d1);
      rowP1.appendChild(d1);

      const c2 = makeDigitInput({ kind: "carry" });
      carry2.push(c2);
      rowCarry2.appendChild(c2);

      const d2 = makeDigitInput();
      p2.push(d2);
      rowP2.appendChild(d2);

      const s = makeDigitInput();
      sum.push(s);
      rowSum.appendChild(s);
    }

    // Shift helpers: represent the classic algorithm for 3-digit × 2-digit
    // - p1 aligns with multiplying by ones digit (no shift)
    // - p2 aligns with multiplying by tens digit (shift left by 1)
    // We visually enforce this by disabling the last (ones) cell of p2.
    if (totalLen >= 2) {
      const last = p2[totalLen - 1];
      last.readOnly = true;
      last.tabIndex = -1;
      last.classList.add("readonly");
      last.value = "";
    }

    // Make divider lines match width
    line1.style.width = `${totalLen * 34 + (totalLen - 1) * 6}px`;
    line2.style.width = line1.style.width;

    grid.appendChild(rowCarry1);
    grid.appendChild(rowA);
    grid.appendChild(rowB);
    grid.appendChild(line1);
    grid.appendChild(rowP1);
    grid.appendChild(rowCarry2);
    grid.appendChild(rowP2);
    grid.appendChild(line2);
    grid.appendChild(rowSum);

    wrap.appendChild(grid);
    els.qInputArea.appendChild(wrap);

    function readRowNumberLoose(inputs) {
      const chars = inputs.map((i) => String(i.value ?? "").trim());
      // 아무 것도 안 썼으면 null
      if (chars.every((c) => c === "")) return null;
      // 숫자 이외가 섞이면 null
      if (chars.some((c) => c !== "" && /^\d$/.test(c) === false)) return null;
      const numStr = chars.join("").replace(/^0+(?=\d)/, "").replace(/^$/, "0");
      return Number(numStr);
    }

    function computeAnswer() {
      // 중간 과정 칸이 비어 있어도 "정답 줄"만으로 제출 가능
      return readRowNumberLoose(sum);
    }

    // Focus first sum cell from right
    sum[totalLen - 1].focus();

    return {
      computeAnswer,
      isComplete: () => computeAnswer() !== null
    };
  }

  function renderVerticalDiv({ dividend, divisor }) {
    const wrap = el("div", "vdiv");

    const top = el("div", "vdivHint");
    // 안내 문구는 제거 (요청사항)
    top.appendChild(el("div"));
    wrap.appendChild(top);

    const dividendStr = String(Math.abs(Number(dividend) || 0));
    const divisorStr = String(Math.abs(Number(divisor) || 0));
    const dividendDigits = dividendStr.split("").map((c) => Number(c));
    const lenD = dividendDigits.length;

    function computeSteps() {
      const steps = [];
      const digits = dividendDigits;
      let idx = 0;
      let current = 0;
      let endPos = -1;

      while (idx < digits.length) {
        // 최소한 divisor 이상이 될 때까지 내려쓰기
        if (current < divisor) {
          current = current * 10 + digits[idx];
          endPos = idx;
          idx += 1;
          // 아직 divisor보다 작으면 계속 내려쓴다(단, 마지막이면 종료)
          if (current < divisor && idx < digits.length) continue;
        }

        const qDigit = Math.floor(current / divisor);
        const product = qDigit * divisor;
        const remainder = current - product;
        steps.push({ qDigit, product, remainder, current, endPos });
        current = remainder;
      }

      // 특별 케이스: dividend < divisor
      if (steps.length === 0) steps.push({ qDigit: 0, product: 0, remainder: dividend, current: dividend, endPos: lenD - 1 });
      return steps;
    }

    const steps = computeSteps();

    function makeRowInputs(cols, className = "vdivRow") {
      const row = el("div", className);
      const inputs = [];
      for (let i = 0; i < cols; i += 1) {
        const di = makeDigitInput();
        inputs.push(di);
        row.appendChild(di);
      }
      return { row, inputs };
    }

    function markExpectedDigits(inputs, num, endPos) {
      for (const i of inputs) delete i.dataset.expected;
      const s = String(Math.abs(Number(num) || 0));
      const start = endPos - s.length + 1;
      if (start < 0) return { start: 0, end: -1, s: "" };
      for (let k = 0; k < s.length; k += 1) inputs[start + k].dataset.expected = s[k];
      return { start, end: endPos, s };
    }

    function validateExpectedRow(inputs, expectedLabel) {
      // expected가 걸린 칸은 반드시 채워야 하고, 값이 일치해야 한다.
      for (const i of inputs) {
        const exp = i.dataset.expected;
        if (exp == null) continue;
        const v = String(i.value ?? "").trim();
        if (v === "") return { ok: false, msg: `${expectedLabel} 빈칸을 채워줘!` };
        if (v !== exp) return { ok: false, msg: `${expectedLabel}이(가) 맞는지 확인해봐!` };
      }
      return { ok: true, msg: null };
    }

    function readQuotientFromCells(inputs, steps, len) {
      const qDigits = new Array(len).fill(null);
      for (const step of steps) {
        const cell = inputs[step.endPos];
        const v = String(cell.value ?? "").trim();
        if (v === "") return null;
        if (/^\d$/.test(v) === false) return null;
        qDigits[step.endPos] = v;
      }
      const qStr = qDigits.filter((d) => d != null).join("").replace(/^0+(?=\d)/, "");
      return qStr === "" ? 0 : Number(qStr);
    }

    // Layout: 업로드 이미지처럼  [나누는 수] ) [나누어지는 수]  + (나누어지는 수 위 오버라인) + (오버라인 위 몫)
    const main = el("div", "vdivLayout");
    const expr = el("div", "vdivExpr");

    const divisorRow = el("div", "vdivRow vdivDivisor");
    for (const c of divisorStr.split("")) {
      const i = makeDigitInput({ readonly: true });
      i.value = c;
      divisorRow.appendChild(i);
    }

    const paren = el("div", "vdivParen");
    paren.textContent = ")";

    const rowQuot = makeRowInputs(lenD);
    rowQuot.row.classList.add("vdivRow", "vdivQuot");
    const overline = el("div", "vdivOverline");
    const rowDividend = el("div", "vdivRow vdivDividend");
    for (let i = 0; i < lenD; i += 1) {
      const di = makeDigitInput({ readonly: true });
      di.value = String(dividendDigits[i]);
      rowDividend.appendChild(di);
    }

    const rowWidthPx = `${lenD * 34 + (lenD - 1) * 6}px`;
    overline.style.width = rowWidthPx;

    expr.appendChild(divisorRow);
    expr.appendChild(paren);
    expr.appendChild(rowQuot.row);
    expr.appendChild(overline);
    expr.appendChild(rowDividend);
    main.appendChild(expr);

    // 계산 과정은 피제수(오른쪽) 아래로만 쌓는다
    const calcBox = el("div", "vdivCalcBox");
    calcBox.style.width = rowWidthPx;
    main.appendChild(calcBox);

    const stepUI = [];
    for (let si = 0; si < steps.length; si += 1) {
      const step = steps[si];
      const carryRow = { row: el("div", "vdivRow vdivRow--carry"), inputs: [] };
      for (let i = 0; i < lenD; i += 1) {
        const ci = makeDigitInput({ kind: "divCarry" });
        carryRow.inputs.push(ci);
        carryRow.row.appendChild(ci);
      }
      const prodRow = makeRowInputs(lenD);
      const remRow = makeRowInputs(lenD);
      const line = el("div", "vdivLine");
      line.style.width = overline.style.width;

      // 몫은 해당 endPos 위치(위에) 한 칸에 쓴다
      rowQuot.inputs[step.endPos].dataset.step = String(si);

      calcBox.appendChild(carryRow.row);
      prodRow.row.classList.add("vdivMinus");
      calcBox.appendChild(prodRow.row);
      calcBox.appendChild(line);
      calcBox.appendChild(remRow.row);

      // 기대값 마킹(곱/나머지). 자리 맞추기: endPos 기준 오른쪽 정렬
      markExpectedDigits(prodRow.inputs, step.product, step.endPos);
      markExpectedDigits(remRow.inputs, step.remainder, step.endPos);

      // 사용자가 헷갈리지 않게: 기대값이 없는 칸은 비활성(선택사항)
      for (const i of prodRow.inputs) {
        if (i.dataset.expected == null) {
          i.readOnly = true;
          i.tabIndex = -1;
          i.classList.add("readonly");
          i.value = "";
        }
      }
      // 나머지 줄은 "내려쓰기"를 적어둘 수 있어야 해서 비활성화하지 않는다.
      // 예: 520 - 480 = 40 다음, 1을 내려서 41처럼 중간값을 적어가며 풀이.

      stepUI.push({ step, carryRow, prodRow, remRow });
    }

    wrap.appendChild(main);
    els.qInputArea.appendChild(wrap);

    function computeAnswer() {
      // 중간 과정 칸이 비어 있어도 "몫"만으로 제출 가능
      const digits = rowQuot.inputs.map((i) => String(i.value ?? "").trim());
      if (digits.every((d) => d === "")) return null;
      if (digits.some((d) => d !== "" && /^\d$/.test(d) === false)) return null;
      const numStr = digits.join("").replace(/^0+(?=\d)/, "").replace(/^$/, "0");
      return Number(numStr);
    }

    // 기본 포커스: 첫 step의 몫 위치
    rowQuot.inputs[steps[0].endPos].focus();

    return { computeAnswer };
  }

  function openQuestionModal(q) {
    openQuestion = { q, uiState: null };
    els.qTitle.textContent = q.level === "advanced" ? "빛나는 황금 진주" : q.level === "remedial" ? "치유의 공간" : "일반 플랑크톤";
    els.qPrompt.textContent = q.prompt;

    els.questionModal.classList.remove("hidden");
    els.questionModal.setAttribute("aria-hidden", "false");
    els.qInputArea.innerHTML = "";

    if (q.ui?.type === "choice") openQuestion.uiState = renderChoice({ options: q.ui.options });
    else if (q.ui?.type === "vertical_mul" && q.meta?.a != null && q.meta?.b != null) {
      openQuestion.uiState = renderVerticalMul({ a: q.meta.a, b: q.meta.b });
    } else if (q.ui?.type === "vertical_div" && q.meta?.dividend != null && q.meta?.divisor != null) {
      openQuestion.uiState = renderVerticalDiv({ dividend: q.meta.dividend, divisor: q.meta.divisor });
    } else openQuestion.uiState = renderNumberPad();

    const t = Date.now();
    if (q.timeLimitMs == null) {
      questionDeadline = 0;
      if (q.meta?.tierLabel != null && q.meta?.tier != null) {
        els.qTimer.textContent = `곱셈 단계 ${q.meta.tier + 1}: ${q.meta.tierLabel}`;
      } else els.qTimer.textContent = "";
      if (questionTimer) window.clearInterval(questionTimer);
      questionTimer = null;
    } else {
      questionDeadline = t + clamp(q.timeLimitMs ?? 15000, 4000, 60000);
      if (questionTimer) window.clearInterval(questionTimer);
      questionTimer = window.setInterval(() => {
        const left = Math.max(0, questionDeadline - Date.now());
        els.qTimer.textContent = `남은 시간: ${(left / 1000).toFixed(1)}s`;
        if (left <= 0) {
          toast("시간 초과! (오답 처리)");
          submitQuestion();
        }
      }, 100);
    }
  }

  function submitQuestion() {
    if (!openQuestion) return;
    const { q, uiState } = openQuestion;
    let answer = null;

    if (q.ui?.type === "choice") answer = uiState.selected.value;
    else if (typeof uiState.computeAnswer === "function") {
      answer = uiState.computeAnswer();
      if (answer === null) {
        toast("정답 칸에 답을 써줘!");
        return;
      }
    } else answer = Number(uiState.input.value);

    socket.emit("answer", { questionId: q.id, answer });
    closeQuestion();
  }

  function abandonQuestion() {
    if (!openQuestion) return;
    const { q } = openQuestion;
    // "닫기"는 기권(오답 처리)로 서버에 알려서 다음 문제로 진행 가능하게 한다.
    socket.emit("answer", { questionId: q.id, answer: undefined });
    closeQuestion();
  }

  function submitQuestionIfOpen() {
    if (!openQuestion) return;
    submitQuestion();
  }

  function onAnswerResult({ ok, correctAnswer }) {
    if (ok) toast("정답! 몸집이 커졌다!");
    else toast(`오답! 정답은 ${correctAnswer} 야.`);
  }

  function openTurtle({ id, prompt }) {
    turtleOpen = { id };
    els.turtlePrompt.textContent = prompt;
    els.turtleBar.classList.remove("hidden");
    els.turtleBar.setAttribute("aria-hidden", "false");
    els.turtleAnswer.value = "";
    els.turtleAnswer.focus();
  }

  function closeTurtle({ answeredBy }) {
    if (!turtleOpen) return;
    turtleOpen = null;
    els.turtleBar.classList.add("hidden");
    els.turtleBar.setAttribute("aria-hidden", "true");
    if (answeredBy && answeredBy === selfId) toast("거북이를 구출했다!");
    else if (answeredBy) toast("다른 플레이어가 먼저 구출했다!");
  }

  els.qCancel.addEventListener("click", () => abandonQuestion());
  els.qSubmit.addEventListener("click", () => submitQuestion());

  els.turtleSubmit.addEventListener("click", () => {
    if (!turtleOpen) return;
    const answer = Number(els.turtleAnswer.value);
    socket.emit("turtle_answer", { answer });
  });

  return {
    setMe,
    getSelfId,
    onState,
    setRanking,
    setGameOverRanking,
    toast,
    promptName,
    startCountdown,
    openQuestion: openQuestionModal,
    submitQuestionIfOpen,
    onAnswerResult,
    openTurtle,
    closeTurtle
  };
}

