import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// 실행: node --test ~/.claude/hooks/envs-guard.test.mjs  (실제 프로젝트 파일은 쓰지 않고 임시 폴더만 씀)
import {
  analyze,
  backupFiles,
  buildContext,
  defaultBackupDir,
  loadConfig,
} from "./envs-guard.mjs";

const SCRIPT = fileURLToPath(new URL("./envs-guard.mjs", import.meta.url));

/**
 * 임시 폴더에 주 폴더(.envs 원본)·worktree(.envs 링크)·실제 복사본·하드 링크를 만듭니다.
 * 실제 저장소의 .envs는 절대 쓰지 않습니다.
 */
function fixture(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envs-guard-")));
  // rm -r 은 링크를 따라가지 않으므로 링크가 가리키는 임시 원본만 함께 지워집니다.
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, "main");
  const wt = path.join(tmp, "wt");
  const copy = path.join(tmp, "copy");
  const backup = path.join(tmp, "backup");
  fs.mkdirSync(path.join(main, ".envs"), { recursive: true });
  fs.writeFileSync(path.join(main, ".envs", ".env"), "A=1\n");
  fs.writeFileSync(path.join(main, ".envs", ".env.api"), "B=2\n");
  fs.mkdirSync(wt);
  fs.symlinkSync(path.join(main, ".envs"), path.join(wt, ".envs"));
  fs.mkdirSync(path.join(copy, ".envs"), { recursive: true });
  fs.writeFileSync(path.join(copy, ".envs", ".env"), "A=1\n");
  fs.linkSync(path.join(main, ".envs", ".env.api"), path.join(tmp, "hardlink"));
  fs.mkdirSync(backup);
  const ctx = buildContext({ mainRoot: main, backupDir: backup, worktrees: [main, wt] });
  const bash = (command, cwd = tmp) =>
    analyze({ tool_name: "Bash", tool_input: { command }, cwd }, ctx);
  return { tmp, main, wt, copy, backup, ctx, bash };
}

test("원본에 닿는 삭제·덮어쓰기는 실제 경로로 풀어서 막는다", (t) => {
  const { main, wt, ctx, bash } = fixture(t);
  const denied = [
    ["rm -rf wt/.envs/", "링크 뒤 / 는 링크를 따라가 원본 안을 지운다"],
    ["rm -f wt/.envs/.env.api", "링크 폴더를 거친 파일 경로"],
    ["cd wt && rm -rf .envs/", "cd 뒤 상대 경로"],
    ["D=wt; rm -rf $D/.envs/", "같은 명령에서 대입한 변수"],
    ["rm -rf main", "원본을 품은 상위 폴더"],
    ["mv main/.envs /tmp/elsewhere", "mv 로 빼내기"],
    ["echo X=1 > wt/.envs/.env", "> 로 원본 덮어쓰기"],
    ["echo X=1 > hardlink", "하드 링크로 원본 덮어쓰기"],
    ["cp /etc/hosts main/.envs/.env.api", "cp 로 원본 덮어쓰기"],
    ["cp /etc/hosts main/.envs/.env.$(date +%s)", "원본 .envs 안으로 이름을 알 수 없는 복사"],
    ["ln -sfn /tmp main/.envs", "원본 폴더를 링크로 바꿔치기"],
    ["git clean -fdx", "git clean -x"],
    ["git -C main stash --all", "git stash --all"],
    ["find main -name '.env*' -delete", "find -delete"],
    ["bash -c 'rm -rf wt/.envs/'", "bash -c 안의 명령"],
    ['rm -rf "$ENVS_DIR/.envs"', "해석할 수 없는 변수 + env"],
    [`node -e "require('fs').rmSync('.envs', {recursive: true})"`, "인라인 코드"],
    ["ls >/dev/null; rm -rf main/.envs 2>/dev/null", "여러 명령 중 하나"],
    [
      "python3 - <<'EOF'\nopen('main/.envs/.env','w').write('')\nEOF",
      "heredoc으로 넘긴 파이썬 코드",
    ],
  ];
  for (const [command, why] of denied) {
    const result = bash(command);
    assert.ok(result.deny, `막혀야 함(${why}): ${command}`);
  }
  // 막은 뒤에도 원본은 그대로입니다(훅은 판단만 합니다).
  assert.equal(fs.readFileSync(path.join(main, ".envs", ".env"), "utf8"), "A=1\n");

  const write = analyze(
    { tool_name: "Write", tool_input: { file_path: path.join(wt, ".envs", ".env") } },
    ctx,
  );
  assert.match(write.deny ?? "", /Edit로/);
});

test("복사본·링크 자체 삭제와 읽기·백업·제자리 수정은 통과시키고, 수정 전 원본을 백업한다", (t) => {
  const { tmp, main, backup, ctx, bash } = fixture(t);
  const allowed = [
    "rm wt/.envs",
    "rm -rf copy/.envs",
    "rm -rf copy",
    "ls -d main/.envs && grep -c A main/.envs/.env",
    `cp -p main/.envs/.env.api ${backup}/.env.api.20261116`,
    `cp -p main/.envs/.env.api ${backup}/.env.api.$(date +%Y%m%d-%H%M%S)`,
    "git clean -fd",
    "git clean -ndx",
    "git stash -u",
    "cat > notes.txt <<'EOF'\nrm -rf main/.envs/\nEOF",
    "echo X=1 > main/.envs/.env.new",
    "rm -rf /nonexistent/.envs",
    "R=copy; rm -rf $R/.envs && cp main/.envs/.env $R/",
  ];
  for (const command of allowed) {
    const result = bash(command);
    assert.equal(result.deny, undefined, `통과해야 함: ${command} → ${result.deny}`);
  }

  const sed = bash("sed -i '' 's/A=1/A=2/' main/.envs/.env");
  assert.deepEqual(sed.backups, [path.join(main, ".envs", ".env")]);
  const append = bash("echo C=3 >> wt/.envs/.env.api");
  assert.deepEqual(append.backups, [path.join(main, ".envs", ".env.api")]);
  // 변수로 건너가 판단할 수 없는 스크립트는 통과시키되 원본 전체를 미리 백업합니다.
  const script = bash("python3 - <<'EOF'\np = 'main/.envs/.env'\nopen(p, 'w').write('')\nEOF");
  assert.equal(script.deny, undefined);
  assert.deepEqual(new Set(script.backups), new Set(ctx.envsFiles));
  const edit = analyze(
    { tool_name: "Edit", tool_input: { file_path: path.join(main, ".envs", ".env") } },
    ctx,
  );
  assert.equal(edit.deny, undefined);

  // 같은 내용은 한 번만 백업하고, 백업 파일은 본인만 읽을 수 있습니다.
  const first = backupFiles(edit.backups, backup);
  const second = backupFiles(edit.backups, backup);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(fs.statSync(first[0]).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(first[0], "utf8"), "A=1\n");
  assert.ok(fs.existsSync(path.join(tmp, "main", ".envs", ".env")));
});

test("다른 프로젝트: 루트 .env와 설정의 protect 경로를 지키고, 사용자 설정이 저장소 설정 위에 덮인다", (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envs-guard-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // .envs 폴더가 없는 흔한 구조: 루트 .env, secrets/ 폴더, 견본 .env.example
  const repo = path.join(tmp, "other-app");
  fs.mkdirSync(path.join(repo, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".env"), "KEY=1\n");
  fs.writeFileSync(path.join(repo, ".env.example"), "KEY=\n");
  fs.writeFileSync(path.join(repo, "secrets", "service.json"), "{}\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "x\n");
  fs.writeFileSync(
    path.join(repo, ".claude", "envs-guard.json"),
    JSON.stringify({ protect: ["secrets/"], backupDir: "repo-backups" }),
  );
  execFileSync("git", ["init", "-q", repo]);

  const userFile = path.join(tmp, "user-config.json");
  fs.writeFileSync(
    userFile,
    JSON.stringify({ projects: { [repo]: { protect: ["notes-dir"], backupDir: "~/x-backup" } } }),
  );
  const config = loadConfig(repo, { userConfigFile: userFile });
  assert.deepEqual(config.protect, [path.join(repo, "secrets/"), path.join(repo, "notes-dir")]);
  assert.equal(config.backupDir, path.join(os.homedir(), "x-backup"));
  assert.equal(defaultBackupDir(repo), path.join(os.homedir(), ".env-backups", "other-app"));

  const backup = path.join(tmp, "backup");
  const run = (command) =>
    spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
      encoding: "utf8",
      env: { ...process.env, ENVS_GUARD_BACKUP_DIR: backup, CLAUDE_PROJECT_DIR: "" },
    });
  for (const command of ["rm .env", "rm -rf secrets", "echo X > secrets/service.json"]) {
    const out = run(command);
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, "deny", command);
  }
  for (const command of ["rm .env.example", "rm notes.txt", "ls -la", "cat .env"]) {
    assert.equal(run(command).stdout, "", command);
  }
  assert.ok(fs.existsSync(path.join(repo, ".env")));
});
