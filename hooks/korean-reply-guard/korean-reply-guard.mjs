#!/usr/bin/env node
/**
 * 한국어 답변 강제 훅 (Claude Code, 모든 프로젝트 공통)
 *
 * 두 단계로 동작합니다.
 * 1. UserPromptSubmit(사전): 질문을 보낼 때마다 "한국어로 답하라"는 알림을 모델 문맥에 넣습니다.
 * 2. Stop(사후): 마지막 답변(last_assistant_message)의 산문이 한국어가 아니면 종료를 막고
 *    같은 내용을 한국어로 다시 쓰게 합니다.
 *
 * 한계: Claude Code 훅은 답변이 화면에 표시되기 "전"에 막을 수 없습니다(MessageDisplay 훅도 막지 못함).
 * 그래서 1로 미리 줄이고, 2로 영어 답변이 그대로 끝나지 않게 합니다. 도구 호출 사이의 짧은 진행 안내는
 * Stop 입력에 없어 2가 보지 못하고, 1의 알림만 적용됩니다.
 *
 * 판정은 코드 블록·인라인 코드·URL·경로·식별자를 뺀 산문의 한글 비율로 합니다.
 * 사용법: node korean-reply-guard.mjs  (stdin으로 훅 JSON을 받음)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REMINDER =
  "[한국어 응답 규칙] 이번 답변과 도구 호출 사이의 진행 안내까지 모두 한국어로 쓰세요. " +
  "코드·명령어·식별자·파일 경로·고유명사만 원문을 유지합니다.";

/** 판정에서 뺄 부분(코드·URL·경로·식별자)을 지운 산문을 돌려줍니다. */
export function proseOf(text) {
  return (
    String(text ?? "")
      // 코드 블록(``` 또는 ~~~)과 인라인 코드
      .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      // 마크다운 링크는 보이는 글만 남기고 주소는 뺍니다.
      .replace(/\]\([^)]*\)/g, "]")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
      .replace(/\S+@\S+\.\S+/g, " ")
      // 경로·파일 이름·식별자(snake_case, camelCase, kebab-case, 점 포함 이름, 대문자 약어)
      .replace(/(?:~|\.{0,2})?\/[\w.@~/-]+/g, " ")
      .replace(/\b[\w-]+\.[a-z0-9]{1,6}\b/gi, " ")
      .replace(/\b\w*[_]\w*\b/g, " ")
      .replace(/\b[a-z]+[A-Z]\w*\b/g, " ")
      .replace(/\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g, " ")
      .replace(/\b[A-Z0-9]{2,}\b/g, " ")
      // 표 구분선·기호
      .replace(/[|#>*_=~-]+/g, " ")
  );
}

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const FOREIGN = /[A-Za-zÀ-ɏЀ-ӿ぀-ヿ一-鿿]/;

/**
 * 한국어 답변인지 판정합니다. 글자가 아니라 **단어** 단위로 셉니다(한글 한 글자가 영어 여러 글자 몫이라
 * 글자 수로 재면 영어 화면 이름을 인용한 한국어 문장이 영어로 보입니다).
 * - 한글이 섞인 단어(`Resources는`처럼 조사가 붙은 것 포함) = 한국어 단어, 한글 없이 외국 문자만 있는 단어 = 외국어 단어.
 * - 한국어 단어 비율이 기준보다 낮고 외국어 단어가 충분히 많을 때만 "한국어 아님".
 * - 짧은 답(외국어 단어 8개 미만)은 판정하지 않습니다(예: "OK", 명령만 있는 답).
 */
export function judgeKorean(text, { minForeignWords = 8, minRatio = 0.3 } = {}) {
  const words = proseOf(text).split(/\s+/).filter(Boolean);
  let hangul = 0;
  let foreign = 0;
  for (const word of words) {
    if (HANGUL.test(word)) hangul += 1;
    else if (FOREIGN.test(word)) foreign += 1;
  }
  const total = hangul + foreign;
  const ratio = total === 0 ? 1 : hangul / total;
  const korean = foreign < minForeignWords || ratio >= minRatio;
  return { korean, ratio, hangul, foreign };
}

/** 훅 입력 하나를 처리해 표준 출력에 낼 객체를 돌려줍니다(없으면 null). */
export function handle(input) {
  const event = input.hook_event_name;
  if (event === "UserPromptSubmit") {
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMINDER } };
  }
  if (event === "Stop") {
    // 이미 이 훅 때문에 다시 쓰는 중이면 또 막지 않습니다(무한 반복 방지).
    if (input.stop_hook_active) return null;
    const verdict = judgeKorean(input.last_assistant_message);
    if (verdict.korean) return null;
    const percent = Math.round(verdict.ratio * 100);
    return {
      decision: "block",
      reason:
        `[한국어 응답 규칙] 방금 답변의 본문이 한국어가 아닙니다(한글 비율 ${percent}%). ` +
        "같은 내용을 한국어로 다시 작성하세요. 코드·명령어·식별자·경로는 원문을 유지하고, 사과나 설명 없이 답변만 다시 쓰세요.",
    };
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  const out = handle(input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
