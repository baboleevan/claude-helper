// 실행: node --test ~/.claude/hooks/korean-reply-guard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { handle, judgeKorean } from "./korean-reply-guard.mjs";

test("코드·경로·식별자가 많아도 한국어 답변은 통과하고, 영어 답변은 막는다", () => {
  const korean = [
    "PR #372를 머지했고 `verify`가 통과했습니다. `apps/web/src/ui/QueryPlanBlock.tsx:8`을 고쳤습니다.",
    "배포 결과\n```bash\ngit push -u origin baboleevan/envs-guard-hook\nnpm run test:env\n```\n위 명령으로 확인했습니다.",
    "CLOUDFLARE_API_TOKEN 권한을 확인했습니다. Account Resources는 우리 계정, Zone Resources는 All zones from an account입니다.",
    "OK",
  ];
  for (const text of korean) assert.equal(judgeKorean(text).korean, true, text);

  const english = [
    "I merged all 7 PRs and the full check on the main merge commit passed. Deploy starts as soon as it arrives.",
    "Now the styles, appended after the query debug total in the content stylesheet.",
  ];
  for (const text of english) assert.equal(judgeKorean(text).korean, false, text);
});

test("Stop은 영어 답변이면 다시 쓰게 하고, 다시 쓰는 중에는 막지 않으며, 질문마다 알림을 넣는다", () => {
  const english = "I merged all 7 PRs and the full check on the main merge commit passed. Deploy starts soon.";
  const blocked = handle({ hook_event_name: "Stop", last_assistant_message: english });
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /한국어로 다시 작성/);
  assert.equal(handle({ hook_event_name: "Stop", last_assistant_message: english, stop_hook_active: true }), null);
  assert.equal(handle({ hook_event_name: "Stop", last_assistant_message: "배포를 마쳤습니다." }), null);
  const reminder = handle({ hook_event_name: "UserPromptSubmit", prompt: "배포해" });
  assert.equal(reminder.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(reminder.hookSpecificOutput.additionalContext, /한국어/);
});
