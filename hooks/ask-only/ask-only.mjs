#!/usr/bin/env node
/**
 * 질문에는 답변만 하게 하는 훅 (Claude Code, 모든 프로젝트 공통)
 *
 * 1. UserPromptSubmit: 프롬프트가 `/ask`로 시작하거나 의문형이면 이 세션에 "답변만" 표시를 남기고,
 *    모델 문맥에 "파일을 고치지 말고 답변만 하라"는 안내를 넣습니다. 의문형이 아니면 표시를 지웁니다.
 * 2. PreToolUse: 표시가 있는 동안 파일을 고치는 도구(Edit·Write·MultiEdit·NotebookEdit)와
 *    상태를 바꾸는 Bash 명령(파일 쓰기·삭제·이동, git 커밋·푸시·브랜치 전환, 설치, 배포 등)을 막습니다.
 *    읽기·검색(Read·Grep·Glob, cat·grep·ls·git status 등)은 그대로 둡니다.
 *
 * 의문형 판단: 끝이 물음표(? ？)이거나 한국어 의문 어미(…까·…나요·…니·…냐·…는지·어때·뭐야·왜 등)로 끝나면 질문입니다.
 * 단, "고쳐줄래?"처럼 수정·추가·배포 같은 요청 동사가 들어 있으면 작업 요청으로 봅니다(`/ask`는 항상 답변만).
 *
 * Bash 판정: 따옴표 안의 문자열은 빼고(검색어에 "install" 같은 낱말이 있어도 오판하지 않게), 명령을
 * `;` `&&` `||` `|` 줄바꿈으로 나눠 각 명령의 실행 파일(맨 앞 낱말)과 하위 명령으로 판단합니다.
 * `bash -c "…"`·`sh -c "…"`는 안의 명령을 다시 판단합니다.
 *
 * 표시는 다음 프롬프트까지 유지됩니다. 상태 파일: <이 스크립트 폴더>/state/ask-only-<session_id>
 * (환경변수 ASK_ONLY_STATE_DIR로 바꿀 수 있음)
 *
 * 사용법: node ask-only.mjs  (stdin으로 훅 JSON을 받음)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STATE_DIR =
  process.env.ASK_ONLY_STATE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "state");

export const CONTEXT =
  "[답변만 모드] 이번 프롬프트는 질문입니다. 코드·파일을 수정·생성·삭제하지 말고, 커밋·푸시·배포·설치처럼 " +
  "상태를 바꾸는 명령도 실행하지 말고 답변만 하세요. 읽기·검색으로 확인하는 것은 괜찮습니다. " +
  "고칠 내용이 있으면 무엇을 어떻게 바꿀지 설명만 하세요.";

/** `/ask` 명령 파일이 펼쳐진 본문에 넣는 표시입니다(훅이 펼친 뒤 프롬프트를 받는 경우 대비). */
const ASK_MARKER = "[답변만 모드]";

/** 작업을 시키는 말입니다. 의문형이어도 이것이 있으면 질문이 아니라 요청으로 봅니다. */
const ACTION_WORDS =
  /(고쳐|수정해|수정\s*해|만들어|추가해|추가\s*해|바꿔|변경해|변경\s*해|삭제해|지워|구현해|적용해|반영해|올려|배포해|머지해|커밋해|푸시해|처리해|진행해|작성해|설치해|실행해|돌려|해줘|해\s*줘|해주세요|해\s*주세요|해줄래|해\s*줄래|해줄\s*수|해\s*줄\s*수|해봐|해\s*봐)/;

/** 한국어 의문 어미(프롬프트 끝)입니다. */
const QUESTION_ENDINGS =
  /(까|나요|나|니|냐|는지|은지|인지|던가|건가|인가|가요|죠|지요|어때|어떄|어떤가|뭐야|뭔데|뭐지|뭘까|뭐가|왜|어떻게|언제|어디|누구|맞아|맞나|맞지|되나|돼요|돼|거야|거예요|건데|있나|없나|있어요|없어요|할래|볼래)$/;

/** 프롬프트에서 붙여 넣은 내용·코드 블록을 빼고 끝 문장을 판정에 씁니다. */
function lastSentence(prompt) {
  const text = String(prompt ?? "")
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .trim();
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** 질문(답변만)인지 판정합니다. */
export function isAskPrompt(prompt) {
  const raw = String(prompt ?? "").trim();
  if (/^\/ask(\s|$)/.test(raw) || raw.includes(ASK_MARKER)) return true;
  if (raw.startsWith("/")) return false; // 다른 슬래시 명령
  const whole = lastSentence(raw);
  if (!whole) return false;
  if (ACTION_WORDS.test(raw)) return false;
  const end = whole.replace(/[\s.!~…ㅋㅎ^)\]]+$/u, "");
  if (/[?？]$/.test(end)) return true;
  return QUESTION_ENDINGS.test(end);
}

/** 따옴표 안의 문자열을 자리표시로 바꿉니다. 안쪽 문자열은 따로 돌려줍니다(`bash -c` 안 명령 판단용). */
function stripQuotes(command) {
  const inner = [];
  const text = command.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, single, double) => {
    inner.push(single ?? double ?? "");
    return ` __Q${inner.length - 1}__ `;
  });
  return { text, inner };
}

/** heredoc 본문(<<EOF … EOF)을 지웁니다. 입력으로 넘기는 글이라 판단에서 뺍니다. */
function stripHeredocs(command) {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, " ");
}

/** 실행 파일 이름만 남깁니다(경로·`./` 제거). */
const base = (word) => word.replace(/^.*\//, "");

const ALWAYS_MUTATING = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "dd",
  "install",
  "tee",
  "kill",
  "pkill",
  "killall",
  "launchctl",
  "unzip",
  "rsync",
  "scp",
]);

const GIT_MUTATING = new Set([
  "add",
  "commit",
  "push",
  "pull",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
  "restore",
  "stash",
  "cherry-pick",
  "revert",
  "tag",
  "worktree",
  "rm",
  "mv",
  "clean",
  "apply",
  "am",
  "init",
  "clone",
]);

/** 명령 하나(낱말 목록)가 상태를 바꾸는지 판단합니다. */
function segmentMutates(words, inner) {
  let i = 0;
  // 앞에 붙는 환경변수 대입·sudo·env·nice 등은 건너뜁니다.
  while (i < words.length && (/^\w+=/.test(words[i]) || ["sudo", "env", "nice", "nohup", "time", "command", "exec", "npx", "bunx", "pnpx"].includes(words[i]))) i += 1;
  const cmd = base(words[i] ?? "");
  const args = words.slice(i + 1);
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  const has = (re) => args.some((a) => re.test(a));
  if (!cmd) return false;
  if (ALWAYS_MUTATING.has(cmd)) return true;
  if (/deploy|docker-up-and-purge/.test(cmd)) return true;
  if ((cmd === "bash" || cmd === "sh" || cmd === "zsh") && args.includes("-c")) {
    const ref = args[args.indexOf("-c") + 1] ?? "";
    const idx = /^__Q(\d+)__$/.exec(ref)?.[1];
    return idx !== undefined ? isMutatingCommand(inner[Number(idx)] ?? "") : false;
  }
  switch (cmd) {
    case "git": {
      if (GIT_MUTATING.has(sub)) return true;
      if (sub === "branch" && has(/^-[dDmMcC]$|^--(delete|move|copy)$/)) return true;
      return false;
    }
    case "gh": {
      const second = args.filter((a) => !a.startsWith("-"))[1] ?? "";
      if (sub === "pr") return ["create", "merge", "edit", "close", "comment", "review", "reopen"].includes(second);
      if (sub === "issue") return ["create", "edit", "close", "comment", "reopen", "delete"].includes(second);
      if (sub === "release") return ["create", "edit", "delete", "upload"].includes(second);
      if (sub === "workflow") return ["run", "enable", "disable"].includes(second);
      if (sub === "run") return ["rerun", "cancel", "delete"].includes(second);
      if (sub === "repo") return ["create", "delete", "edit", "fork", "clone"].includes(second);
      if (sub === "api") return has(/^(POST|PUT|PATCH|DELETE)$/i) || has(/^--method=(POST|PUT|PATCH|DELETE)$/i);
      return false;
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      if (["i", "install", "add", "remove", "rm", "uninstall", "ci", "update", "upgrade", "publish", "version", "link", "unlink"].includes(sub)) return true;
      if (sub === "run") return /^(build|deploy|format|fix|generate|migrate|release|publish)/.test(args.filter((a) => !a.startsWith("-"))[1] ?? "");
      return false;
    }
    case "pip":
    case "pip3":
    case "brew":
    case "apt":
    case "apt-get":
      return ["install", "uninstall", "remove", "upgrade", "update", "link", "unlink"].includes(sub);
    case "docker": {
      const action = sub === "compose" ? (args.filter((a) => !a.startsWith("-"))[1] ?? "") : sub;
      return ["up", "down", "rm", "rmi", "stop", "start", "restart", "build", "run", "exec", "prune", "kill", "create", "volume", "system", "push", "pull", "cp"].includes(action);
    }
    case "sed":
      return has(/^-[a-zA-Z]*i/) || args.includes("--in-place");
    case "perl":
      return has(/^-[a-zA-Z]*i/);
    case "prettier":
      return has(/^--write$|^-w$/);
    case "eslint":
      return args.includes("--fix");
    case "curl":
      return args.some((a, k) => (a === "-X" || a === "--request") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[k + 1] ?? ""));
    case "mysql":
    case "mariadb":
    case "psql":
    case "sqlite3":
      return inner.some((s) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE)\b/i.test(s));
    default:
      return false;
  }
}

/** 상태를 바꾸는 Bash 명령인지 판정합니다(읽기·검색 명령은 통과). */
export function isMutatingCommand(command) {
  const { text, inner } = stripQuotes(stripHeredocs(String(command ?? "")));
  // 파일로 리다이렉트(> >>)하면 쓰기입니다. /dev/null, 2>&1 같은 출력 복사는 뺍니다.
  const redirects = text.replace(/\d*>>?\s*\/dev\/null/g, " ").replace(/\d*>&\s*\d+/g, " ");
  if (/(^|[^<>&|0-9-])\d*>>?\s*[^\s&|>]/.test(redirects)) return true;
  return text
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.replace(/[()]/g, " ").trim().split(/\s+/).filter(Boolean))
    .some((words) => segmentMutates(words, inner));
}

function statePath(sessionId, stateDir) {
  const safe = String(sessionId || "unknown").replace(/[^\w.-]/g, "_");
  return path.join(stateDir, `ask-only-${safe}`);
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** 훅 입력 하나를 처리해 출력할 JSON 객체를 돌려줍니다. */
export function handle(input, { stateDir = DEFAULT_STATE_DIR } = {}) {
  const event = input?.hook_event_name;
  const file = statePath(input?.session_id, stateDir);

  if (event === "UserPromptSubmit") {
    if (isAskPrompt(input?.prompt)) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, new Date().toISOString());
      return {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: CONTEXT },
      };
    }
    rmSync(file, { force: true });
    return {};
  }

  if (event === "PreToolUse" && existsSync(file)) {
    const tool = input?.tool_name;
    const blocked =
      FILE_TOOLS.has(tool) || (tool === "Bash" && isMutatingCommand(input?.tool_input?.command));
    if (blocked) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "[답변만 모드] 질문(/ask 또는 의문형)에는 파일 수정·상태 변경을 하지 않습니다. 답변만 하세요. " +
            "작업이 필요하면 사용자에게 요청 문장으로 다시 지시해 달라고 안내하세요.",
        },
      };
    }
  }
  return {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    input = {};
  }
  try {
    process.stdout.write(`${JSON.stringify(handle(input))}\n`);
  } catch {
    // 훅이 실패해도 작업을 막지 않습니다(빈 응답).
    process.stdout.write("{}\n");
  }
}
