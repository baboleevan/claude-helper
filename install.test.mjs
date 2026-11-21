// 실행: npm test  (임시 폴더의 가짜 설정 파일만 씀)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyHooks, commandFor } from "./install.mjs";

const INSTALL = fileURLToPath(new URL("./install.mjs", import.meta.url));
const OTHER = { hooks: [{ type: "command", command: "emma hook claude-stop" }] };

test("등록은 다른 훅을 지키고, 예전 경로의 같은 훅은 교체하며, 여러 번 해도 중복되지 않는다", () => {
  const settings = {
    model: "opus",
    hooks: {
      Stop: [OTHER, { hooks: [{ type: "command", command: "node /old/place/korean-reply-guard.mjs" }] }],
    },
  };
  const hookDir = "/Users/me/Library/Application Support/claude/hooks";
  const once = applyHooks(settings, ["envs-guard", "korean-reply-guard"], { hookDir });
  const twice = applyHooks(once.settings, ["envs-guard", "korean-reply-guard"], { hookDir });
  assert.deepEqual(twice.settings, once.settings);
  assert.ok(once.changes.includes("Stop: korean-reply-guard 교체"));
  assert.equal(once.settings.model, "opus");

  const stop = once.settings.hooks.Stop;
  assert.deepEqual(stop[0], OTHER);
  assert.equal(stop.length, 2);
  // 공백이 있는 경로도 따옴표로 감싸 셸에서 그대로 실행됩니다.
  assert.equal(stop[1].hooks[0].command, `node "${hookDir}/korean-reply-guard.mjs"`);
  assert.equal(once.settings.hooks.PreToolUse[0].matcher, "Bash|Write|Edit|MultiEdit|NotebookEdit");
  assert.equal(once.settings.hooks.UserPromptSubmit.length, 1);

  const removed = applyHooks(once.settings, ["envs-guard", "korean-reply-guard"], {
    hookDir,
    uninstall: true,
  });
  assert.deepEqual(removed.settings, { model: "opus", hooks: { Stop: [OTHER] } });
});

test("설치 명령은 훅 파일을 복사하고 설정을 백업한 뒤 고친다", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-helper-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const settingsFile = path.join(tmp, "settings.json");
  const hookDir = path.join(tmp, "hooks");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [OTHER] } }));

  const run = (...args) =>
    spawnSync(process.execPath, [INSTALL, "--settings", settingsFile, "--dir", hookDir, ...args], {
      encoding: "utf8",
    });
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(hookDir), false);

  const res = run("--only", "envs-guard");
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(hookDir, "envs-guard.mjs")));
  const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(saved.hooks.PreToolUse[0].hooks[0].command, commandFor(hookDir, "envs-guard.mjs"));
  assert.deepEqual(saved.hooks.Stop, [OTHER]);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.includes(".bak-")).length, 1);

  assert.notEqual(run("--only", "no-such-hook").status, 0);
});
