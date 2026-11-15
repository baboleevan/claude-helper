#!/usr/bin/env node
/**
 * .env 원본 보호 훅 — 모든 프로젝트 공통 (Claude Code PreToolUse: Bash·Write·Edit·MultiEdit·NotebookEdit)
 * 위치: ~/.claude/hooks/envs-guard.mjs, 연결: 사용자 설정(settings.json)의 hooks.PreToolUse
 *
 * 막는 사고: 복사본이나 링크를 지운다고 생각한 명령이 링크를 따라가 원본 환경 파일까지 지우는 일
 * (예: worktree의 `.envs` 링크에 `rm -rf .envs/`, 원본을 품은 상위 폴더 삭제, `git clean -x`).
 *
 * 보호 대상(프로젝트 = git 주 폴더, worktree에서 실행해도 주 폴더 기준)
 * - 주 폴더 안의 `.env`·`.env.*` 파일(견본 `.env.example` 등, node_modules, linked worktree 안은 제외)
 * - 주 폴더의 `.envs/` 폴더(있으면)
 * - 프로젝트 설정의 `protect` 경로(폴더·파일)
 * - 백업 폴더(기본 `~/.env-backups/<주 폴더 이름>/`)와 `~/.env-backups/` 전체
 *
 * 프로젝트 설정(둘 다 선택, 사용자 쪽이 우선)
 * - 저장소: `<주 폴더>/.claude/envs-guard.json`
 * - 사용자: `~/.claude/hooks/envs-guard.config.json` 의 `projects["<주 폴더 절대 경로>"]`
 *   형식: { "protect": ["secrets/", "config/credentials.json"], "backupDir": "~/.my-backups" }
 *   (경로는 주 폴더 기준 상대 경로, 절대 경로, ~/ 모두 가능)
 * - 환경변수 ENVS_GUARD_BACKUP_DIR 이 있으면 백업 폴더로 가장 먼저 씁니다(테스트용).
 *
 * 판단 원칙
 * - 명령 문자열이 아니라 **실제 경로(realpath)** 로 판단합니다. 복사본·링크 자체를 지우는 일은 통과,
 *   지우거나 덮어쓰는 대상이 실제로 보호 대상이면 거부합니다.
 * - 읽기·복사(`cp .envs/x 백업`)·제자리 수정(`sed -i`, Edit, `>>`)은 통과시키고, 수정 직전에 원본을 자동 백업합니다.
 * - 해석할 수 없는 삭제(`$변수`·명령 치환·`xargs`·인라인 스크립트)는 명령에 "env"가 보이면 거부합니다.
 *
 * 외부 패키지 없이 Node 내장 모듈만 씁니다(worktree에 node_modules가 없어도 동작).
 * 허용할 때는 아무것도 출력하지 않습니다("allow"를 출력하면 권한 확인을 건너뛰게 되므로).
 * 테스트: node --test ~/.claude/hooks/envs-guard.test.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_NAME = /^\.env(\..+)?$/;
/** 지워도 되는 견본 파일 이름입니다. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;
const DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "trash", "srm", "shred"]);
const COPY_COMMANDS = new Set(["cp", "install", "ditto", "rsync", "ln", "gcp"]);
const WRAPPERS = new Set([
  "sudo",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "caffeinate",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INLINE_INTERPRETERS = new Map([
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["python", ["-c"]],
  ["python3", ["-c"]],
  ["ruby", ["-e"]],
  ["perl", ["-e", "-E"]],
]);
const DESTRUCTIVE_CODE =
  /\b(unlink|unlinkSync|rmSync|rmdirSync|rm\s*\(|rmtree|remove\s*\(|os\.remove|rename|renameSync|writeFile|writeFileSync|write_text|write_bytes|truncate|copyFile|copyFileSync|shutil)|\bopen\s*\([^)]*,\s*['"][wx]/;

// ───────────────────────── 셸 명령 나누기 ─────────────────────────

/**
 * 셸 명령을 단순 명령 단위로 나눕니다. 따옴표·이스케이프·연산자(&&, ||, ;, |, &, 괄호)·리다이렉트·heredoc을 다룹니다.
 * 각 단어는 { text, quoted, unresolved } 이고, unresolved는 $변수·명령 치환처럼 값을 알 수 없는 경우입니다.
 */
export function splitCommands(input, env = process.env) {
  const commands = [];
  let words = [];
  let redirects = [];
  let word = null;
  let pendingRedirect = null;
  let pendingHeredocs = [];
  let i = 0;

  const startWord = () => {
    if (!word) word = { text: "", quoted: false, unresolved: false, glob: false };
  };
  const endWord = () => {
    if (!word) return;
    if (pendingRedirect) {
      // 본문은 이 명령(곧 commands에 들어갈 자리)에 붙여, 인터프리터에 넘기는 코드도 검사합니다.
      if (pendingRedirect.op.startsWith("<<"))
        pendingHeredocs.push({ delim: word.text, owner: commands.length });
      else redirects.push({ op: pendingRedirect.op, target: word });
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = null;
  };
  /** 같은 명령 안에서 앞서 대입한 셸 변수(R=/경로; cp x $R/)입니다. 값을 알 수 있을 때만 기록합니다. */
  const localVars = new Map();
  const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
  const endCommand = () => {
    endWord();
    // 대입만 있는 명령(R=…, export R=…)은 뒤 명령에서 $R 을 풀 수 있게 기억합니다.
    const assigns = words[0]?.text === "export" ? words.slice(1) : words;
    if (assigns.length && !redirects.length && assigns.every((w) => ASSIGN.test(w.text))) {
      for (const w of assigns) {
        const [, name, value] = ASSIGN.exec(w.text);
        if (w.unresolved) localVars.delete(name);
        else localVars.set(name, value);
      }
    }
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  const expandVar = (name) => {
    if (localVars.has(name)) return localVars.get(name);
    if (name === "HOME") return os.homedir();
    if (Object.hasOwn(env, name) && /^(HOME|PWD|TMPDIR|USER|CLAUDE_PROJECT_DIR)$/.test(name)) {
      return env[name];
    }
    return null;
  };
  /** $NAME, ${NAME}, $(...) 를 읽습니다. 알 수 없으면 word.unresolved를 켭니다. */
  const readDollar = () => {
    const next = input[i + 1];
    if (next === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < input.length; j += 1) {
        if (input[j] === "(") depth += 1;
        else if (input[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      word.text += input.slice(i, j + 1);
      word.unresolved = true;
      i = j + 1;
      return;
    }
    const braced = next === "{";
    const m = braced
      ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/.exec(input.slice(i))
      : /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(input.slice(i));
    if (!m) {
      word.text += "$";
      i += 1;
      return;
    }
    const value = expandVar(m[1]);
    if (value == null) {
      word.text += m[0];
      word.unresolved = true;
    } else {
      word.text += value;
    }
    i += m[0].length;
  };

  while (i < input.length) {
    const c = input[i];
    if (c === "\n") {
      endCommand();
      i += 1;
      // heredoc 본문은 명령이 아니므로 구분자 줄까지 건너뜁니다.
      while (pendingHeredocs.length) {
        const { delim, owner } = pendingHeredocs.shift();
        const body = [];
        while (i < input.length) {
          const end = input.indexOf("\n", i);
          const line = input.slice(i, end === -1 ? input.length : end);
          i = end === -1 ? input.length : end + 1;
          if (line.replace(/^\t+/, "") === delim) break;
          body.push(line);
        }
        if (commands[owner])
          commands[owner].heredoc = `${commands[owner].heredoc ?? ""}${body.join("\n")}\n`;
      }
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (c === "#" && !word) {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "\\") {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      startWord();
      word.text += input[i + 1] ?? "";
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      const end = input.indexOf("'", i + 1);
      word.text += input.slice(i + 1, end === -1 ? input.length : end);
      word.quoted = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          word.text += input[i + 1];
          i += 2;
        } else if (input[i] === "$") {
          readDollar();
        } else if (input[i] === "`") {
          const end = input.indexOf("`", i + 1);
          word.text += input.slice(i, end === -1 ? input.length : end + 1);
          word.unresolved = true;
          i = end === -1 ? input.length : end + 1;
        } else {
          word.text += input[i];
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (c === "`") {
      startWord();
      const end = input.indexOf("`", i + 1);
      word.text += input.slice(i, end === -1 ? input.length : end + 1);
      word.unresolved = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (c === "$") {
      startWord();
      readDollar();
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      // &> 와 &>> 는 리다이렉트입니다.
      if (c === "&" && input[i + 1] === ">") {
        endWord();
        const op = input[i + 2] === ">" ? "&>>" : "&>";
        pendingRedirect = { op };
        i += op.length;
        continue;
      }
      endCommand();
      i += input[i + 1] === c && c !== "(" && c !== ")" ? 2 : 1;
      continue;
    }
    if (c === ">" || c === "<") {
      // 2>, 1>> 처럼 앞의 숫자는 파일 기술자입니다.
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null;
      else endWord();
      let op = c;
      let j = i + 1;
      if (c === "<" && input[j] === "<") {
        op = "<<";
        j += 1;
        if (input[j] === "-") {
          op = "<<-";
          j += 1;
        } else if (input[j] === "<") {
          op = "<<<";
          j += 1;
        }
      } else if (c === ">" && (input[j] === ">" || input[j] === "|")) {
        op += input[j];
        j += 1;
      }
      if (input[j] === "&") {
        // 2>&1 같은 기술자 복제는 파일이 아닙니다.
        j += 1;
        while (j < input.length && /[0-9-]/.test(input[j])) j += 1;
        i = j;
        continue;
      }
      pendingRedirect = op === "<<<" ? null : { op };
      if (op === "<<<") pendingRedirect = { op: "<" };
      i = j;
      continue;
    }
    startWord();
    if (c === "*" || c === "?" || c === "[") word.glob = true;
    if (
      c === "~" &&
      word.text === "" &&
      (input[i + 1] === "/" || i + 1 >= input.length || /\s/.test(input[i + 1]))
    ) {
      word.text += os.homedir();
    } else {
      word.text += c;
    }
    i += 1;
  }
  endCommand();
  return commands;
}

// ───────────────────────── 경로 판단 ─────────────────────────

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** 가장 가까운 존재하는 상위 폴더까지 실제 경로로 풀어, 아직 없는 경로도 비교할 수 있게 합니다. */
function resolveLoosely(p) {
  const real = realpathOrNull(p);
  if (real) return real;
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(resolveLoosely(parent), path.basename(p));
}

/**
 * 보호 대상 정보입니다.
 * - roots: 통째로 지키는 경로의 실제 경로. kind "source"는 원본(`.envs`·protect), "backup"은 백업 폴더
 * - mainRoot: 주 폴더(이 안의 `.env*` 파일도 지킴), worktrees: 그 안에서 제외할 linked worktree 경로
 * - inodes: 하드 링크로 원본을 덮어쓰는 일을 잡기 위한 원본 파일 inode
 */
export function buildContext({ mainRoot, backupDir, worktrees = [], protect = [], backupRoots = [] }) {
  const roots = [];
  const inodes = new Set();
  /** 원본 파일 목록입니다(판단이 애매한 스크립트 실행 전에 통째로 백업할 때 씁니다). */
  const envsFiles = [];
  const sources = [
    ...(mainRoot ? [{ dir: path.join(mainRoot, ".envs"), label: "원본 .envs" }] : []),
    ...protect.map((p) => ({ dir: p, label: "보호 경로" })),
  ];
  const addSourceFile = (file) => {
    const st = lstatOrNull(file);
    if (!st?.isFile()) return;
    inodes.add(`${st.dev}:${st.ino}`);
    envsFiles.push(file);
  };
  for (const { dir, label } of sources) {
    const real = realpathOrNull(dir);
    if (!real) continue;
    roots.push({ path: real, label, kind: "source" });
    if (fs.statSync(real).isDirectory()) {
      for (const name of safeReaddir(real)) addSourceFile(path.join(real, name));
    } else {
      addSourceFile(real);
    }
  }
  for (const dir of [backupDir, ...backupRoots]) {
    if (!dir) continue;
    const real = realpathOrNull(dir);
    if (real && !roots.some((r) => r.path === real)) {
      roots.push({ path: real, label: "환경 파일 백업 폴더", kind: "backup" });
    }
  }
  return {
    roots,
    mainRoot: mainRoot ? realpathOrNull(mainRoot) : null,
    worktrees: worktrees.map((w) => realpathOrNull(w)).filter(Boolean),
    inodes,
    envsFiles,
    backupDir,
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 실제 경로가 보호 대상인지 봅니다. 보호 대상이면 사유 문자열, 아니면 null. */
function protectedReason(real, ctx) {
  for (const root of ctx.roots) {
    if (isInside(real, root.path)) return `${root.label}(${root.path}) 안의 파일입니다`;
  }
  const base = path.basename(real);
  if (
    ctx.mainRoot &&
    ENV_NAME.test(base) &&
    !ENV_TEMPLATE.test(base) &&
    isInside(real, ctx.mainRoot) &&
    !real.split(path.sep).includes("node_modules") &&
    !ctx.worktrees.some((w) => w !== ctx.mainRoot && isInside(real, w))
  ) {
    return `주 폴더의 환경 파일(${real})입니다`;
  }
  return null;
}

/** 지우는 대상(rm·mv 원본 등)을 검사합니다. */
function checkRemoval(target, ctx) {
  const st = lstatOrNull(target);
  if (!st) return null;
  // 끝에 / 가 없으면 링크 자체만 지워지고 링크가 가리키는 원본은 그대로입니다.
  const followsLink = /\/\.?$/.test(target);
  if (st.isSymbolicLink() && !followsLink) return null;
  const real = realpathOrNull(target);
  if (!real) return null;
  const reason = protectedReason(real, ctx);
  if (reason) {
    return st.isSymbolicLink() || real !== path.resolve(target)
      ? `${target} 는 링크를 따라가면 ${reason}`
      : `${target} 는 ${reason}`;
  }
  for (const root of ctx.roots) {
    if (isInside(root.path, real))
      return `${target}(${real}) 를 지우면 그 안의 ${root.label}(${root.path})까지 지워집니다`;
  }
  return null;
}

/** 덮어쓰는 대상(> 리다이렉트, cp·mv 목적지, tee, dd of= 등)을 검사합니다. 새 파일 만들기는 통과입니다. */
function checkOverwrite(target, ctx) {
  const st = lstatOrNull(target);
  if (!st) return null;
  const real = realpathOrNull(target) ?? path.resolve(target);
  if (st.isDirectory() || fs.statSync(real, { throwIfNoEntry: false })?.isDirectory()) {
    // 폴더 자체를 덮어쓰지는 않습니다(목적지가 폴더면 호출한 쪽이 폴더/이름으로 다시 묻습니다).
    return null;
  }
  const reason = protectedReason(real, ctx);
  if (reason) return `${target} 를 덮어쓰면 ${reason}`;
  const full = fs.statSync(real, { throwIfNoEntry: false });
  if (full && full.nlink > 1 && ctx.inodes.has(`${full.dev}:${full.ino}`)) {
    return `${target} 는 보호 중인 원본 파일과 하드 링크로 이어져 있어 덮어쓰면 원본이 바뀝니다`;
  }
  return null;
}

/** 제자리 수정(sed -i, >>, Edit) 대상이면 백업할 실제 경로를 돌려줍니다. */
function editTarget(target, ctx) {
  const st = lstatOrNull(target);
  if (!st) return null;
  const real = realpathOrNull(target);
  if (!real || !fs.statSync(real).isFile()) return null;
  if (protectedReason(real, ctx)) return real;
  const full = fs.statSync(real);
  if (full.nlink > 1 && ctx.inodes.has(`${full.dev}:${full.ino}`)) return real;
  return null;
}

// ───────────────────────── 명령별 규칙 ─────────────────────────

function expandWord(w, cwd) {
  if (w.unresolved) return null;
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  if (w.glob && !w.quoted && typeof fs.globSync === "function") {
    try {
      const matches = fs.globSync(w.text, { cwd });
      if (matches.length) return matches.map(abs);
    } catch {
      // 잘못된 패턴은 글자 그대로 둡니다(bash와 같음).
    }
  }
  // 끝의 / 는 링크를 따라갈지 판단하는 데 쓰므로 그대로 둡니다.
  const text = w.text;
  const out = abs(text);
  return [text.endsWith("/") && !out.endsWith("/") ? `${out}/` : out];
}

function operands(words) {
  const out = [];
  let ended = false;
  for (const w of words) {
    if (!ended && w.text === "--" && !w.quoted) {
      ended = true;
      continue;
    }
    if (!ended && w.text.startsWith("-") && w.text !== "-" && !w.quoted) continue;
    out.push(w);
  }
  return out;
}

/** 값을 알 수 없는 부분이 마지막 / 뒤(파일 이름)에만 있으면 그 앞 폴더의 절대 경로를, 아니면 null을 돌려줍니다. */
function unresolvedNameOnlyDir(w, cwd) {
  if (cwd == null) return null;
  const marker = w.text.search(/\$|`/);
  const slash = w.text.lastIndexOf("/");
  if (marker === -1 || slash === -1 || marker < slash) return null;
  const dir = w.text.slice(0, slash) || "/";
  return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
}

function mentionsEnv(text) {
  return /env/i.test(text);
}

/**
 * 단순 명령 하나를 검사합니다.
 * 반환: { deny?: string, backups: string[], cwd?: string(cd로 바뀐 폴더, 알 수 없으면 null) }
 */
function checkSimpleCommand(cmd, state, ctx, depth) {
  const backups = [];
  let words = [...cmd.words];
  // VAR=값 대입과 sudo·env 같은 감싸기 명령을 벗깁니다.
  while (words.length) {
    const head = words[0].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) && !words[0].quoted) {
      words.shift();
      continue;
    }
    if (WRAPPERS.has(head)) {
      words.shift();
      while (words.length && words[0].text.startsWith("-")) words.shift();
      continue;
    }
    if (head === "env") {
      words.shift();
      while (
        words.length &&
        (words[0].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text))
      ) {
        words.shift();
      }
      continue;
    }
    if (head === "timeout") {
      words.shift();
      while (words.length && words[0].text.startsWith("-")) words.shift();
      words.shift();
      continue;
    }
    break;
  }

  const raw = cmd.words.map((w) => w.text).join(" ");
  const cwd = state.cwd;

  // 리다이렉트: > 는 덮어쓰기, >> 는 덧붙이기(백업 후 통과)
  for (const r of cmd.redirects) {
    if (r.op === "<") continue;
    if (r.target.unresolved || cwd == null) {
      if (mentionsEnv(r.target.text))
        return { deny: `리다이렉트 대상(${r.target.text})을 해석할 수 없습니다` };
      continue;
    }
    for (const t of expandWord(r.target, cwd) ?? []) {
      if (r.op === ">>" || r.op === "&>>") {
        const b = editTarget(t, ctx);
        if (b) backups.push(b);
      } else {
        const why = checkOverwrite(t, ctx);
        if (why) return { deny: why };
      }
    }
  }

  if (!words.length) return { backups };
  const name = path.basename(words[0].text);
  const args = words.slice(1);

  if (name === "cd") {
    const dest = args.find((w) => !w.text.startsWith("-"));
    if (!dest) return { backups, cwd: os.homedir() };
    if (dest.unresolved || cwd == null) return { backups, cwd: null };
    const next = expandWord(dest, cwd)?.[0];
    return { backups, cwd: next && fs.existsSync(next) ? realpathOrNull(next) : null };
  }

  if (
    name === "eval" ||
    (SHELLS.has(name) && args.some((w) => w.text === "-c" || /^-[a-z]*c$/.test(w.text)))
  ) {
    const idx =
      name === "eval" ? 0 : args.findIndex((w) => w.text === "-c" || /^-[a-z]*c$/.test(w.text)) + 1;
    const script = name === "eval" ? args.map((w) => w.text).join(" ") : args[idx]?.text;
    const anyUnresolved = name === "eval" ? args.some((w) => w.unresolved) : args[idx]?.unresolved;
    if (script == null) return { backups };
    if (anyUnresolved && mentionsEnv(script))
      return { deny: `${name} 안의 명령을 해석할 수 없습니다` };
    if (depth > 3)
      return mentionsEnv(script) ? { deny: "중첩된 셸 명령이 너무 깊습니다" } : { backups };
    const inner = analyzeBash(script, { cwd }, ctx, depth + 1);
    return inner.deny ? { deny: inner.deny } : { backups: [...backups, ...inner.backups] };
  }

  if (INLINE_INTERPRETERS.has(name)) {
    const flags = INLINE_INTERPRETERS.get(name);
    const i = args.findIndex((w) => flags.includes(w.text));
    // -e/-c 로 넘긴 코드와 heredoc(python3 - <<EOF)으로 넘긴 코드를 함께 봅니다.
    const code = `${i !== -1 ? (args[i + 1]?.text ?? "") : ""}\n${cmd.heredoc ?? ""}`;
    // 같은 줄에 .env 경로와 지우기·덮어쓰기가 함께 있으면 막습니다.
    if (code.split("\n").some((line) => /\.env/.test(line) && DESTRUCTIVE_CODE.test(line))) {
      return {
        deny: `${name} 로 실행하는 코드가 .env 파일을 지우거나 덮어씁니다. 환경 파일 수정은 Edit 도구로 하세요(고치기 전에 자동 백업합니다)`,
      };
    }
    // 변수로 건너가는 경우(p='.envs/x' … open(p,'w'))는 코드만으로 판단할 수 없어, 실행 전에 원본 전체를 백업하고 통과시킵니다.
    if (/\.env/.test(code) && DESTRUCTIVE_CODE.test(code)) backups.push(...ctx.envsFiles);
    if (name === "perl" && args.some((w) => /^-[a-zA-Z]*i/.test(w.text))) {
      for (const w of operands(args)) {
        for (const t of expandWord(w, cwd ?? "/") ?? []) {
          const b = editTarget(t, ctx);
          if (b) backups.push(b);
        }
      }
    }
    return { backups };
  }

  if (name === "xargs") {
    const sub = args.find((w) => !w.text.startsWith("-"));
    const subName = sub ? path.basename(sub.text) : "";
    if (
      (DELETE_COMMANDS.has(subName) || subName === "mv" || subName === "truncate") &&
      mentionsEnv(raw)
    ) {
      return { deny: `xargs ${subName} 는 지울 대상을 미리 알 수 없습니다` };
    }
    return { backups };
  }

  const needCwd = (w) => w.unresolved || cwd == null;
  const targetsOf = (list) => {
    const out = [];
    for (const w of list) {
      if (needCwd(w)) {
        if (mentionsEnv(w.text)) return { unresolved: w.text };
        continue;
      }
      out.push(...(expandWord(w, cwd) ?? []));
    }
    return { out };
  };

  if (DELETE_COMMANDS.has(name)) {
    const { out, unresolved } = targetsOf(operands(args));
    if (unresolved) return { deny: `${name} 대상(${unresolved})을 해석할 수 없습니다` };
    for (const t of out) {
      const why = checkRemoval(t, ctx);
      if (why) return { deny: why };
    }
    return { backups };
  }

  if (name === "truncate") {
    const ops = operands(args).filter((w, i, all) => !(i > 0 && /^-s$/.test(all[i - 1]?.text)));
    const { out, unresolved } = targetsOf(ops);
    if (unresolved) return { deny: `truncate 대상(${unresolved})을 해석할 수 없습니다` };
    for (const t of out) {
      const why = checkOverwrite(t, ctx);
      if (why) return { deny: why };
    }
    return { backups };
  }

  if (name === "mv" || COPY_COMMANDS.has(name)) {
    const ops = operands(args);
    const tFlag = args.findIndex((w) => w.text === "-t" || w.text === "--target-directory");
    let destWord = tFlag !== -1 ? args[tFlag + 1] : ops[ops.length - 1];
    let sources = tFlag !== -1 ? ops.filter((w) => w !== destWord) : ops.slice(0, -1);
    if (name === "ln" && ops.length === 1) {
      sources = ops;
      destWord = { text: ".", quoted: false, unresolved: false, glob: false };
    }
    if (!destWord) return { backups };
    const srcRes = targetsOf(sources);
    if (srcRes.unresolved)
      return { deny: `${name} 대상(${srcRes.unresolved})을 해석할 수 없습니다` };
    const destRes = targetsOf([destWord]);
    if (destRes.unresolved) {
      // 백업(cp x 백업폴더/이름.$(date …))처럼 파일 이름만 정해지지 않은 복사는, 폴더가 원본 보호 경로가 아니면 통과합니다.
      const literalDir = unresolvedNameOnlyDir(destWord, cwd);
      const intoSource =
        literalDir &&
        ctx.roots.some((r) => r.kind === "source" && isInside(resolveLoosely(literalDir), r.path));
      if (name !== "mv" && name !== "ln" && literalDir && !intoSource) {
        return { backups };
      }
      return { deny: `${name} 목적지(${destRes.unresolved})를 해석할 수 없습니다` };
    }
    const dest = destRes.out[0];
    if (name === "mv") {
      for (const s of srcRes.out) {
        const why = checkRemoval(s.replace(/\/+$/, "") + (s.endsWith("/") ? "/" : ""), ctx);
        if (why) return { deny: `mv 로 옮기면 원래 자리에서 사라집니다: ${why}` };
      }
    }
    if (name === "rsync" && args.some((w) => /^--(delete|remove-source-files)/.test(w.text))) {
      if (dest) {
        const real = resolveLoosely(dest.replace(/\/+$/, ""));
        for (const root of ctx.roots) {
          if (isInside(real, root.path) || isInside(root.path, real)) {
            return {
              deny: `rsync --delete 목적지(${dest})가 ${root.label}(${root.path})에 닿습니다`,
            };
          }
        }
      }
      if (args.some((w) => w.text === "--remove-source-files")) {
        for (const s of srcRes.out) {
          const why = checkRemoval(s, ctx);
          if (why) return { deny: `rsync --remove-source-files: ${why}` };
        }
      }
    }
    if (dest) {
      const destIsDir = fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory();
      const finals =
        destIsDir && !(name === "ln" && args.some((w) => /^-[a-zA-Z]*[nh]/.test(w.text)))
          ? srcRes.out.map((s) => path.join(dest, path.basename(s.replace(/\/+$/, ""))))
          : [dest];
      for (const f of finals) {
        const why = checkOverwrite(f, ctx);
        if (why) return { deny: why };
        // ln -sfn 링크 .envs 처럼 원본 폴더를 링크로 바꿔치기하는 경우
        if (name === "ln" || name === "mv") {
          const st = lstatOrNull(f);
          const real = st ? realpathOrNull(f) : null;
          if (st && !st.isSymbolicLink() && real && ctx.roots.some((r) => r.path === real)) {
            return {
              deny: `${f} 는 ${ctx.roots.find((r) => r.path === real).label}입니다. 링크·다른 폴더로 바꿔치기할 수 없습니다`,
            };
          }
        }
      }
    }
    return { backups };
  }

  if (name === "find") {
    const firstExpr = args.findIndex((w) => /^[-(!]/.test(w.text));
    const roots = firstExpr === -1 ? args : args.slice(0, firstExpr);
    const expr = firstExpr === -1 ? [] : args.slice(firstExpr).map((w) => w.text);
    const destructive =
      expr.includes("-delete") ||
      expr.some(
        (t, i) =>
          /^-(exec|execdir|ok|okdir)$/.test(t) &&
          /^(rm|unlink|mv|shred|truncate)$/.test(path.basename(expr[i + 1] ?? "")),
      );
    if (!destructive) return { backups };
    const { out, unresolved } = targetsOf(
      roots.length ? roots : [{ text: ".", quoted: false, unresolved: false, glob: false }],
    );
    if (unresolved) return { deny: `find 시작 경로(${unresolved})를 해석할 수 없습니다` };
    for (const t of out) {
      const real = realpathOrNull(t);
      if (!real) continue;
      for (const root of ctx.roots) {
        if (isInside(real, root.path) || isInside(root.path, real)) {
          return { deny: `find ${t} 의 삭제가 ${root.label}(${root.path})에 닿습니다` };
        }
      }
      if (ctx.mainRoot && isInside(ctx.mainRoot, real) && expr.some((e) => /\.env/.test(e))) {
        return { deny: `find ${t} 가 주 폴더의 .env 파일을 지울 수 있습니다` };
      }
    }
    return { backups };
  }

  if (name === "git") {
    const sub = args.find(
      (w, i) => !w.text.startsWith("-") && !(i > 0 && /^-(C|c)$/.test(args[i - 1].text)),
    );
    const subArgs = sub ? args.slice(args.indexOf(sub) + 1).map((w) => w.text) : [];
    if (sub?.text === "clean") {
      const dry = subArgs.some((a) => a === "-n" || a === "--dry-run" || /^-[a-zA-Z]*n/.test(a));
      const ignored = subArgs.some((a) => /^-[a-zA-Z]*[xX]/.test(a));
      if (ignored && !dry) {
        return {
          deny: "git clean -x/-X 는 Git이 무시하는 파일(.envs 등)까지 지웁니다. -x 없이 쓰거나 -n으로 먼저 확인하세요",
        };
      }
    }
    if (
      sub?.text === "stash" &&
      subArgs.some((a) => a === "-a" || a === "--all" || /^-[a-zA-Z]*a/.test(a))
    ) {
      return {
        deny: "git stash --all 은 무시된 파일(.envs 등)까지 작업 폴더에서 치웁니다. -u 를 쓰세요",
      };
    }
    return { backups };
  }

  if (name === "sed" || name === "gsed") {
    const inPlace = args.some((w) => /^(-[a-zA-Z]*i|--in-place)/.test(w.text));
    if (inPlace) {
      for (const w of operands(args).slice(1)) {
        for (const t of expandWord(w, cwd ?? "/") ?? []) {
          const b = editTarget(t, ctx);
          if (b) backups.push(b);
        }
      }
    }
    return { backups };
  }

  if (name === "tee") {
    const append = args.some((w) => w.text === "-a" || w.text === "--append");
    const { out, unresolved } = targetsOf(operands(args));
    if (unresolved) return { deny: `tee 대상(${unresolved})을 해석할 수 없습니다` };
    for (const t of out) {
      if (append) {
        const b = editTarget(t, ctx);
        if (b) backups.push(b);
      } else {
        const why = checkOverwrite(t, ctx);
        if (why) return { deny: why };
      }
    }
    return { backups };
  }

  if (name === "dd") {
    const of = args.find((w) => w.text.startsWith("of="));
    if (of) {
      const w = { ...of, text: of.text.slice(3) };
      const { out, unresolved } = targetsOf([w]);
      if (unresolved) return { deny: `dd 출력(${unresolved})을 해석할 수 없습니다` };
      for (const t of out) {
        const why = checkOverwrite(t, ctx);
        if (why) return { deny: why };
      }
    }
    return { backups };
  }

  return { backups };
}

/** Bash 명령 전체를 검사합니다. */
export function analyzeBash(command, { cwd }, ctx, depth = 0) {
  const state = { cwd: cwd ? (realpathOrNull(cwd) ?? cwd) : null };
  const backups = [];
  for (const cmd of splitCommands(command)) {
    const result = checkSimpleCommand(cmd, state, ctx, depth);
    if (result.deny) return { deny: result.deny, backups: [] };
    backups.push(...(result.backups ?? []));
    if (Object.hasOwn(result, "cwd")) state.cwd = result.cwd;
  }
  return { backups };
}

/** 파일 도구(Write·Edit·MultiEdit·NotebookEdit)를 검사합니다. */
export function analyzeFileTool(toolName, filePath, ctx) {
  if (!filePath) return { backups: [] };
  const st = lstatOrNull(filePath);
  if (!st) return { backups: [] };
  const target = editTarget(filePath, ctx);
  if (!target) return { backups: [] };
  if (toolName === "Write") {
    return {
      deny: `${filePath} 는 보호 중인 환경 파일입니다. 통째로 덮어쓰지 말고 Edit로 필요한 줄만 고치세요(고치기 전에 자동 백업합니다)`,
      backups: [],
    };
  }
  return { backups: [target] };
}

/** 훅 입력 하나를 판단합니다. */
export function analyze(input, ctx) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  if (tool === "Bash") return analyzeBash(String(ti.command ?? ""), { cwd: input.cwd }, ctx);
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return analyzeFileTool(tool, ti.file_path ?? ti.notebook_path, ctx);
  }
  return { backups: [] };
}

// ───────────────────────── 백업·실행 ─────────────────────────

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 수정 직전 원본을 백업 폴더에 복사합니다. 가장 최근 자동 백업과 내용이 같으면 건너뜁니다. */
export function backupFiles(files, backupDir) {
  const written = [];
  if (!files.length || !backupDir) return written;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const file of new Set(files)) {
    const base = path.basename(file);
    const content = fs.readFileSync(file);
    const latest = safeReaddir(backupDir)
      .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".auto"))
      .sort()
      .at(-1);
    if (latest && fs.readFileSync(path.join(backupDir, latest)).equals(content)) continue;
    const dest = path.join(backupDir, `${base}.${stamp()}.auto`);
    fs.writeFileSync(dest, content, { mode: 0o600 });
    written.push(dest);
  }
  return written;
}

function gitLines(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 실행 위치에서 주 폴더(첫 worktree)와 linked worktree 목록을 찾습니다. */
export function discoverRepo(cwd) {
  const dirs = [cwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    // 첫 번째 worktree가 주 폴더입니다(git 호출을 한 번으로 줄여 모든 Bash 호출의 지연을 줄입니다).
    const worktrees = gitLines(dir, ["worktree", "list", "--porcelain"])
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
    if (!worktrees.length) continue;
    return { mainRoot: worktrees[0], worktrees };
  }
  // git 저장소가 아니면 세션을 시작한 프로젝트 폴더를 주 폴더로 봅니다(홈 폴더 자체는 제외: 너무 넓음).
  const project = process.env.CLAUDE_PROJECT_DIR;
  if (project && fs.existsSync(project) && realpathOrNull(project) !== realpathOrNull(os.homedir())) {
    return { mainRoot: project, worktrees: [] };
  }
  return { mainRoot: null, worktrees: [] };
}

function expandHome(p, base) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) || !base ? p : path.join(base, p);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 프로젝트별 설정을 읽습니다. 저장소 쪽(`.claude/envs-guard.json`) 위에 사용자 쪽
 * (`~/.claude/hooks/envs-guard.config.json`의 projects[주 폴더])을 덮습니다. protect는 합칩니다.
 */
export function loadConfig(mainRoot, { userConfigFile } = {}) {
  const userFile =
    userConfigFile ?? path.join(os.homedir(), ".claude", "hooks", "envs-guard.config.json");
  const repo = mainRoot ? readJson(path.join(mainRoot, ".claude", "envs-guard.json")) : null;
  const projects = readJson(userFile)?.projects ?? {};
  const realMain = mainRoot ? realpathOrNull(mainRoot) : null;
  const user =
    Object.entries(projects).find(
      ([key]) => key === mainRoot || (realMain && realpathOrNull(expandHome(key)) === realMain),
    )?.[1] ?? null;
  const protect = [...(repo?.protect ?? []), ...(user?.protect ?? [])].map((p) =>
    expandHome(String(p), mainRoot),
  );
  const backupDir = user?.backupDir ?? repo?.backupDir ?? null;
  return { protect, backupDir: backupDir ? expandHome(String(backupDir), mainRoot) : null };
}

/** 백업 폴더 기본값: ~/.env-backups/<주 폴더 이름>/ (git 저장소가 아니면 _no-project). */
export function defaultBackupDir(mainRoot) {
  return path.join(os.homedir(), ".env-backups", mainRoot ? path.basename(mainRoot) : "_no-project");
}

function emitDeny(reason) {
  const message = `[.env 보호 훅] ${reason}. 원본 환경 파일은 Git에 없는 유일한 원본이라 지우거나 덮어쓰지 않습니다. 필요하면 사용자에게 직접 실행을 요청하세요(~/.claude/hooks/envs-guard.mjs).`;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    })}\n`,
  );
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
  const text = JSON.stringify(input.tool_input ?? {});
  try {
    const repo = discoverRepo(input.cwd ?? process.cwd());
    const config = loadConfig(repo.mainRoot);
    const backupDir =
      process.env.ENVS_GUARD_BACKUP_DIR || config.backupDir || defaultBackupDir(repo.mainRoot);
    const ctx = buildContext({
      ...repo,
      backupDir,
      protect: config.protect,
      // 다른 프로젝트의 백업도 함께 지킵니다.
      backupRoots: [path.join(os.homedir(), ".env-backups")],
    });
    const result = analyze(input, ctx);
    if (result.deny) {
      emitDeny(result.deny);
      return;
    }
    backupFiles(result.backups ?? [], backupDir);
  } catch (error) {
    // 판단 중 오류: env를 건드리는 명령이면 막고, 아니면 통과시킵니다(모든 Bash가 멈추지 않도록).
    if (/\.env/.test(text))
      emitDeny(`검사 중 오류가 나서 안전하게 막았습니다(${error?.message ?? error})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
