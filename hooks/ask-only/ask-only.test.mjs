// 실행: npm test  (임시 폴더의 상태 파일만 씀)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handle, isAskPrompt, isMutatingCommand } from "./ask-only.mjs";

test("의문형·/ask는 답변만, 요청 동사가 있으면 작업으로 판정한다", () => {
  const asks = [
    "/ask 이거 왜 느려?",
    "터널을 쓰면 속도가 느리지?",
    "cloudflared 용도가 뭐야?",
    "롤백도 가능하게 구현했다는거지?",
    "자간이 좀 넓어 진 것 같은데 어떄?",
    "현재 터널 실행 옵션에 기본값 뭘로 되어 있어?",
  ];
  for (const prompt of asks) assert.equal(isAskPrompt(prompt), true, prompt);
  const actions = [
    "PR 올려",
    "머지 후 배포",
    "기본 서체 다시 변경",
    "이거 고쳐줄래?",
    "나눔스퀘어를 나눔스퀘어 네오로만 바꿔 다른건 유지",
    "/clear",
  ];
  for (const prompt of actions) assert.equal(isAskPrompt(prompt), false, prompt);
});

test("Bash는 따옴표 안 낱말에 속지 않고, 명령의 실행 파일과 하위 명령으로 쓰기 여부를 판단한다", () => {
  const reads = [
    `git -C "$R" ls-files | grep -iE "hook|install|deploy" | head -20`,
    "git status && git log --oneline -3 2>/dev/null",
    "grep -rn 'rm -rf' src | wc -l",
    "cat <<'EOF'\nrm -rf /\nEOF",
    "gh pr checks 381; gh pr view 381 --json state",
    "npm test 2>&1 | tail -5",
    "docker ps --format '{{.Names}}'",
    `mysql -e "SELECT COUNT(*) FROM t"`,
  ];
  for (const command of reads) assert.equal(isMutatingCommand(command), false, command);
  const writes = [
    "echo hi > a.txt",
    "git commit -m x",
    "cd repo && git push -q",
    "rm -f build.log",
    "sed -i '' 's/a/b/' f.txt",
    "npm i -D left-pad",
    "gh pr merge 1 --merge",
    `bash -c "rm -rf dist"`,
    "./scripts/docker-up-and-purge.sh",
    `mysql -e "DELETE FROM t"`,
    "FOO=1 npx prettier --write src",
  ];
  for (const command of writes) assert.equal(isMutatingCommand(command), true, command);
});

test("질문 뒤에는 파일 수정·쓰기 명령을 막고, 작업 프롬프트가 오면 풀린다", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-only-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const run = (input) => handle({ session_id: "s1", ...input }, { stateDir });

  const asked = run({ hook_event_name: "UserPromptSubmit", prompt: "왜 그래?" });
  assert.match(asked.hookSpecificOutput.additionalContext, /답변만 모드/);
  const deny = (tool_name, tool_input = {}) =>
    run({ hook_event_name: "PreToolUse", tool_name, tool_input }).hookSpecificOutput?.permissionDecision;
  assert.equal(deny("Edit", { file_path: "/tmp/a" }), "deny");
  assert.equal(deny("Bash", { command: "git push" }), "deny");
  assert.equal(deny("Bash", { command: "git diff" }), undefined);
  assert.equal(deny("Read", { file_path: "/tmp/a" }), undefined);

  assert.deepEqual(run({ hook_event_name: "UserPromptSubmit", prompt: "고쳐줘" }), {});
  assert.equal(deny("Edit", { file_path: "/tmp/a" }), undefined);
});
