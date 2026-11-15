#!/usr/bin/env node
/**
 * claude-helper 설치 스크립트: 훅 파일을 복사하고 Claude Code 설정(settings.json)에 등록합니다.
 * 훅에 딸린 슬래시 명령(예: /ask)은 각 설정 파일 옆의 `commands/` 폴더에 복사합니다.
 *
 * 사용법
 *   node install.mjs                         # 모든 훅 설치(기본 설정 파일)
 *   node install.mjs --only envs-guard       # 일부만(쉼표로 여러 개)
 *   node install.mjs --settings <파일> ...   # 설정 파일 지정(여러 번 가능, 예: Orca 프로필마다)
 *   node install.mjs --dir <폴더>            # 훅 파일을 둘 폴더(기본 ~/.claude/hooks)
 *   node install.mjs --uninstall             # 설정에서 등록만 지움(복사한 파일은 남김)
 *   node install.mjs --dry-run               # 바꿀 내용만 출력
 *   node install.mjs --list                  # 설치할 수 있는 훅 목록
 *
 * 기본 설정 파일: 환경변수 CLAUDE_CONFIG_DIR 이 있으면 그 안의 settings.json, 없으면 ~/.claude/settings.json.
 * 설정을 바꾸기 전에 같은 폴더에 `settings.json.bak-<시각>-claude-helper` 백업을 남깁니다.
 * 같은 훅이 이미 등록돼 있으면(스크립트 파일 이름으로 판단) 새 명령으로 교체하므로 여러 번 실행해도 중복되지 않습니다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 설치할 수 있는 훅 목록입니다. 새 훅은 hooks/<이름>/ 폴더와 여기 한 줄을 추가합니다. */
export const HOOKS = {
  "envs-guard": {
    description: ".env 원본 보호: 복사본·링크 삭제가 원본 환경 파일을 지우지 못하게 사전 차단",
    files: ["envs-guard.mjs", "envs-guard.config.example.json"],
    entry: "envs-guard.mjs",
    events: [
      {
        event: "PreToolUse",
        matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
        timeout: 10,
        statusMessage: ".env 원본 보호 확인",
      },
    ],
  },
  "ask-only": {
    description: "질문엔 답변만: /ask 또는 의문형 프롬프트면 파일 수정·상태 변경 도구를 막고 답변만 하게 함",
    files: ["ask-only.mjs"],
    entry: "ask-only.mjs",
    commands: ["ask.md"],
    events: [
      { event: "UserPromptSubmit", timeout: 10 },
      { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", timeout: 10 },
    ],
  },
  "korean-reply-guard": {
    description: "한국어 답변 강제: 질문마다 한국어 알림, 영어로 끝나면 한국어로 다시 쓰게 함",
    files: ["korean-reply-guard.mjs"],
    entry: "korean-reply-guard.mjs",
    events: [
      { event: "UserPromptSubmit", timeout: 10 },
      { event: "Stop", timeout: 10 },
    ],
  },
};

function defaultSettingsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

/** 셸에서 안전하게 실행되도록 경로를 따옴표로 감쌉니다. */
function shellQuote(p) {
  return /^[\w./~-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function commandFor(hookDir, entry) {
  return `node ${shellQuote(path.join(hookDir, entry))}`;
}

/** 이 훅이 등록한 항목인지(명령에 스크립트 파일 이름이 들어 있는지) 봅니다. */
function isOurs(hook, entry) {
  return typeof hook?.command === "string" && hook.command.includes(`/${entry}`);
}

/**
 * 설정 객체에 훅을 등록(또는 제거)한 새 객체와 바뀐 내용을 돌려줍니다. 다른 훅은 건드리지 않습니다.
 */
export function applyHooks(settings, names, { hookDir, uninstall = false } = {}) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  const changes = [];
  for (const name of names) {
    const spec = HOOKS[name];
    for (const ev of spec.events) {
      const list = (next.hooks[ev.event] ??= []);
      // 이미 있는 우리 항목을 모두 뺍니다(경로가 바뀌었거나 중복된 것 포함).
      let removed = 0;
      for (const group of list) {
        const before = group.hooks?.length ?? 0;
        group.hooks = (group.hooks ?? []).filter((h) => !isOurs(h, spec.entry));
        removed += before - group.hooks.length;
      }
      next.hooks[ev.event] = list.filter((g) => g.hooks.length > 0);
      if (uninstall) {
        if (removed) changes.push(`${ev.event}: ${name} 제거`);
        continue;
      }
      const hook = { type: "command", command: commandFor(hookDir, spec.entry), timeout: ev.timeout };
      if (ev.statusMessage) hook.statusMessage = ev.statusMessage;
      next.hooks[ev.event].push({ ...(ev.matcher ? { matcher: ev.matcher } : {}), hooks: [hook] });
      changes.push(`${ev.event}: ${name} ${removed ? "교체" : "추가"}`);
    }
  }
  for (const [event, list] of Object.entries(next.hooks)) if (!list.length) delete next.hooks[event];
  return { settings: next, changes };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const opts = { settings: [], only: null, dir: path.join(os.homedir(), ".claude", "hooks") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--settings") opts.settings.push(argv[++i]);
    else if (a === "--only") opts.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--list") opts.list = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (!opts.settings.length) opts.settings.push(defaultSettingsFile());
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return;
  }
  if (opts.list) {
    for (const [name, spec] of Object.entries(HOOKS)) console.log(`${name}\t${spec.description}`);
    return;
  }
  const names = opts.only ?? Object.keys(HOOKS);
  const unknown = names.filter((n) => !HOOKS[n]);
  if (unknown.length) throw new Error(`없는 훅: ${unknown.join(", ")} (--list 로 확인)`);
  const hookDir = path.resolve(opts.dir.replace(/^~(?=\/|$)/, os.homedir()));

  if (!opts.uninstall) {
    for (const name of names) {
      for (const file of HOOKS[name].files) {
        const dest = path.join(hookDir, file);
        console.log(`${opts.dryRun ? "[미리보기] " : ""}복사: hooks/${name}/${file} → ${dest}`);
        if (!opts.dryRun) {
          fs.mkdirSync(hookDir, { recursive: true });
          fs.copyFileSync(path.join(ROOT, "hooks", name, file), dest);
        }
      }
    }
  }

  for (const file of opts.settings) {
    if (!opts.uninstall) {
      // 슬래시 명령은 설정 파일과 같은 폴더의 commands/에 둡니다(Claude Code가 읽는 사용자 명령 위치).
      const commandDir = path.join(path.dirname(file), "commands");
      for (const name of names) {
        for (const command of HOOKS[name].commands ?? []) {
          const dest = path.join(commandDir, command);
          console.log(`${opts.dryRun ? "[미리보기] " : ""}명령 복사: hooks/${name}/${command} → ${dest}`);
          if (!opts.dryRun) {
            fs.mkdirSync(commandDir, { recursive: true });
            fs.copyFileSync(path.join(ROOT, "hooks", name, command), dest);
          }
        }
      }
    }
    const exists = fs.existsSync(file);
    const current = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const { settings, changes } = applyHooks(current, names, { hookDir, uninstall: opts.uninstall });
    console.log(`\n설정: ${file}`);
    for (const c of changes) console.log(`  - ${c}`);
    if (!changes.length) console.log("  - 바꿀 내용 없음");
    if (opts.dryRun || !changes.length) continue;
    if (exists) fs.copyFileSync(file, `${file}.bak-${stamp()}-claude-helper`);
    else fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  if (!opts.dryRun) {
    console.log("\n완료. 실행 중인 Claude Code 세션에는 /hooks 를 한 번 열거나 다시 시작하면 반영됩니다.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`설치 실패: ${error.message}`);
    process.exit(1);
  }
}
