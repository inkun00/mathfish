import fs from "node:fs/promises";
import path from "node:path";

function randInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 기본 곱셈 난이도: 자리수·범위가 커질수록 어려움 (인덱스 0=가장 쉬움) */
const MUL_BASIC_SPECS = [
  { label: "1×1", a: [2, 9], b: [2, 9] },
  { label: "1×2(작음)", a: [2, 9], b: [10, 19] },
  { label: "2×1(작음)", a: [12, 29], b: [2, 5] },
  { label: "2×1", a: [12, 49], b: [2, 9] },
  { label: "2×1(넓음)", a: [10, 99], b: [2, 9] },
  { label: "2×2(b작음)", a: [11, 49], b: [11, 19] },
  { label: "2×2", a: [12, 99], b: [11, 49] },
  { label: "2×2(풀)", a: [10, 99], b: [10, 99] },
  { label: "3×2(표준)", a: [120, 299], b: [12, 79] },
  { label: "3×2(어려움)", a: [150, 699], b: [15, 99] }
];

const MUL_BASIC_TIER_DEFAULT = 5;

function clampMulBasicTier(tier) {
  return Math.max(0, Math.min(MUL_BASIC_SPECS.length - 1, tier));
}

/** 기본 나눗셈 난이도: 나누는 수(한 자리→두 자리), 나누어지는 수(두/세 자리), 나머지 유무로 복잡도 조절 */
const DIV_BASIC_SPECS = [
  { label: "2~9로 나누기(딱 떨어짐)", divisor: [2, 9], quotient: [2, 9], remainder: "zero" },
  { label: "2~9로 나누기(나머지 있음)", divisor: [2, 9], quotient: [2, 9], remainder: "any" },
  { label: "한 자리÷세 자리(나머지 있음)", divisor: [2, 9], quotient: [10, 99], remainder: "any" },
  { label: "두 자리 나눗셈(몫 한 자리)", divisor: [11, 29], quotient: [2, 9], remainder: "any" },
  { label: "두 자리 나눗셈(몫 한 자리, 딱)", divisor: [11, 29], quotient: [2, 9], remainder: "zero" },
  { label: "두 자리 나눗셈(몫 두 자리)", divisor: [11, 29], quotient: [10, 49], remainder: "any" }
];

const DIV_BASIC_TIER_DEFAULT = 2;

function clampDivBasicTier(tier) {
  return Math.max(0, Math.min(DIV_BASIC_SPECS.length - 1, tier));
}

function detectErrorPattern({ domain, meta, correctAnswer, userAnswer }) {
  if (domain === "mul" && meta?.kind === "mul_with_zeros") {
    const correctZeros = String(correctAnswer).match(/0+$/)?.[0]?.length ?? 0;
    const userZeros = String(userAnswer).match(/0+$/)?.[0]?.length ?? 0;
    if (correctZeros !== userZeros) {
      return {
        code: "ZERO_COUNT",
        tooltip: "0의 개수를 확인해봐!",
        remedialKey: "mul_zero_magic"
      };
    }
  }

  if (domain === "div" && meta?.kind === "div_by_multiple_of_10") {
    return {
      code: "TIMES_TABLE_LINK",
      tooltip: "구구단으로 바꿔서 생각해봐!",
      remedialKey: "div_times_table_link"
    };
  }

  return null;
}

function buildMulNormal(mulBasicTier = MUL_BASIC_TIER_DEFAULT) {
  const tier = clampMulBasicTier(mulBasicTier);
  const spec = MUL_BASIC_SPECS[tier];
  const a = randInt(spec.a[0], spec.a[1]);
  const b = randInt(spec.b[0], spec.b[1]);
  const prompt = `${a} × ${b} = ?`;
  return {
    id: `mul_normal:t${tier}:${a}x${b}`,
    domain: "mul",
    level: "basic",
    prompt,
    answer: a * b,
    timeLimitMs: null,
    ui: { type: "vertical_mul" },
    meta: { kind: "vertical_mul", a, b, tier, tierLabel: spec.label }
  };
}

function buildMulZeros(mulBasicTier = MUL_BASIC_TIER_DEFAULT) {
  // 티어가 낮을수록 숫자 크기/0 개수를 줄여 "더 쉬운 보충"이 나오게 한다.
  const tier = clampMulBasicTier(mulBasicTier);
  const easy = tier <= 1;
  const mid = tier <= 4;

  const baseA = easy ? randInt(2, 9) : mid ? randInt(10, 49) : randInt(12, 99);
  const baseB = easy ? randInt(2, 9) : randInt(2, 9);

  // 최소 1개의 0은 포함 (보충 포인트 유지)
  const totalZeros = easy ? 1 : mid ? choice([1, 2]) : choice([2, 3]);
  const zA = totalZeros === 1 ? 1 : choice([1, 2]);
  const zB = Math.max(0, totalZeros - zA);
  const a = baseA * 10 ** zA;
  const b = baseB * 10 ** zB;
  return {
    id: `mul_zeros:${a}x${b}`,
    domain: "mul",
    level: "remedial",
    prompt: `${a} × ${b} = ?`,
    answer: a * b,
    timeLimitMs: null,
    ui: { type: "vertical_mul" },
    meta: { kind: "mul_with_zeros", a, b, base: `${baseA}×${baseB}`, zeros: zA + zB, tier }
  };
}

function buildMulEstimateDigits() {
  const a = randInt(120, 299);
  const b = randInt(12, 99);
  const exact = a * b;
  const digits = String(Math.abs(exact)).length;
  const options = Array.from(new Set([digits - 1, digits, digits + 1].filter((d) => d >= 2 && d <= 6))).sort(
    (x, y) => x - y
  );
  const label = (d) => `${d}자리`;
  return {
    id: `mul_digits:${a}x${b}`,
    domain: "mul",
    level: "advanced",
    prompt: `${a} × ${b} 의 답은 몇 자리일까?`,
    answer: digits,
    timeLimitMs: null,
    ui: { type: "choice", options: options.map((d) => ({ value: d, label: label(d) })) },
    meta: { kind: "digit_estimate", a, b }
  };
}

function buildDivNormal(divBasicTier = DIV_BASIC_TIER_DEFAULT) {
  const tier = clampDivBasicTier(divBasicTier);
  const spec = DIV_BASIC_SPECS[tier];
  const divisor = randInt(spec.divisor[0], spec.divisor[1]);
  const quotient = randInt(spec.quotient[0], spec.quotient[1]);
  const remainder =
    spec.remainder === "zero" ? 0 : randInt(0, Math.max(0, divisor - 1));
  const dividend = divisor * quotient + remainder;
  return {
    id: `div_normal:t${tier}:${dividend}/${divisor}`,
    domain: "div",
    level: "basic",
    prompt: `${dividend} ÷ ${divisor} = ?`,
    answer: quotient,
    timeLimitMs: null,
    ui: { type: "vertical_div" },
    meta: { kind: "long_division", dividend, divisor, remainder, tier, tierLabel: spec.label }
  };
}

function buildDivByMultipleOf10() {
  const divisor = choice([20, 30, 40, 50, 60, 70, 80, 90]);
  const quotient = randInt(2, 9);
  const dividend = divisor * quotient;
  return {
    id: `div_10s:${dividend}/${divisor}`,
    domain: "div",
    level: "remedial",
    prompt: `${dividend} ÷ ${divisor} = ?`,
    answer: quotient,
    timeLimitMs: null,
    ui: { type: "vertical_div" },
    meta: { kind: "div_by_multiple_of_10", dividend, divisor }
  };
}

function buildWordProblemRescue() {
  const total = randInt(110, 190);
  const per = choice([20, 25, 30, 35]);
  const q = Math.floor(total / per);
  const r = total % per;
  const needed = r === 0 ? q : q + 1;
  const prompt = `물고기 ${total}마리가 산호초 1개당 ${per}마리씩 숨으려 한다. 산호초는 최소 몇 개 필요한가?`;
  return {
    id: `word_rescue:${total}/${per}`,
    domain: "word",
    level: "event",
    prompt,
    answer: needed,
    timeLimitMs: 25000,
    meta: { kind: "ceil_division", total, per, quotient: q, remainder: r }
  };
}

export async function loadQuestionData(dataDir) {
  const [patternsRaw, _questionsRaw] = await Promise.all([
    fs.readFile(path.join(dataDir, "patterns.json"), "utf8"),
    fs.readFile(path.join(dataDir, "questions.json"), "utf8")
  ]);
  const patterns = JSON.parse(patternsRaw);
  const questions = JSON.parse(_questionsRaw);

  return {
    patterns,
    questions,
    mulBasicTier: {
      min: 0,
      max: MUL_BASIC_SPECS.length - 1,
      default: MUL_BASIC_TIER_DEFAULT,
      specs: MUL_BASIC_SPECS.map((s, i) => ({ tier: i, label: s.label }))
    },
    divBasicTier: {
      min: 0,
      max: DIV_BASIC_SPECS.length - 1,
      default: DIV_BASIC_TIER_DEFAULT,
      specs: DIV_BASIC_SPECS.map((s, i) => ({ tier: i, label: s.label }))
    },
    generators: {
      mul_normal: buildMulNormal,
      mul_zeros: buildMulZeros,
      mul_digits: buildMulEstimateDigits,
      div_normal: buildDivNormal,
      div_10s: buildDivByMultipleOf10,
      word_rescue: buildWordProblemRescue
    },
    detectErrorPattern
  };
}

