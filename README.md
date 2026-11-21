# claude-helper

Claude Code에서 쓰는 훅·스킬·mod를 모아 두고, 다른 프로젝트·다른 컴퓨터에서 한 번에 설치하는 저장소입니다.

## 설치

Node.js 22 이상이 필요합니다(외부 패키지 없음).

```bash
git clone https://github.com/baboleevan/claude-helper.git
cd claude-helper
node install.mjs --list          # 설치할 수 있는 훅 목록
node install.mjs --dry-run       # 바뀔 내용만 미리 보기
node install.mjs                 # 모든 훅 설치
```

- 훅 파일은 `~/.claude/hooks/`에 복사되고, Claude Code 사용자 설정(`settings.json`)의 `hooks`에 등록됩니다.
- 기본 설정 파일은 `CLAUDE_CONFIG_DIR`가 있으면 그 안의 `settings.json`, 없으면 `~/.claude/settings.json`입니다.
- 설정 파일이 여러 개면(예: Orca 프로필마다 다른 설정) `--settings`를 여러 번 줍니다.
  ```bash
  node install.mjs --settings ~/.claude/settings.json \
    --settings "$HOME/Library/Application Support/orca/claude-profiles/<프로필 ID>/home/settings.json"
  ```
- 일부만 설치: `node install.mjs --only envs-guard` (훅에 딸린 슬래시 명령은 각 설정 파일 옆 `commands/`에 복사)
- 등록 해제: `node install.mjs --uninstall` (복사한 파일은 남김)
- 설정을 고치기 전에 `settings.json.bak-<시각>-claude-helper` 백업을 남깁니다. 다른 훅은 건드리지 않고, 같은 훅을 다시 설치하면 교체만 합니다.
- 실행 중인 세션에는 `/hooks`를 한 번 열거나 Claude Code를 다시 시작하면 반영됩니다.
- 업데이트: `git pull && node install.mjs`

## 훅

### envs-guard — `.env` 원본 보호 (`PreToolUse`)

복사본이나 링크를 지운다고 생각한 명령이 링크를 따라가 원본 환경 파일까지 지우는 사고를 실행 전에 막습니다.

- 명령 문자열이 아니라 대상의 **실제 경로(realpath)** 로 판단합니다.
- 보호 대상(프로젝트 = git 주 폴더, worktree에서 실행해도 주 폴더 기준)
  - 주 폴더 안 `.env`, `.env.*` (견본 `.env.example`·`.sample`·`.template`·`.dist`, `node_modules`, linked worktree 안은 제외)
  - 주 폴더의 `.envs/` 폴더(있으면)
  - 설정의 `protect` 경로
  - 백업 폴더(기본 `~/.env-backups/<주 폴더 이름>/`)와 `~/.env-backups/` 전체
- **거부**: 링크 뒤 `/` 삭제(`rm -rf wt/.envs/`), 원본을 품은 상위 폴더 삭제, `mv`로 빼내기, `>`·`cp`·`tee`·`dd`·`truncate` 덮어쓰기, `ln -sfn` 바꿔치기, 하드 링크, `git clean -x/-X`, `git stash --all`, `find -delete`, `rsync --delete`, `bash -c`·`eval` 안의 같은 명령, 해석할 수 없는 `$변수`·`xargs` + "env", 같은 줄에 `.env` 경로와 쓰기·삭제가 있는 인라인·heredoc 스크립트, Write 도구로 환경 파일 통째로 덮어쓰기
- **통과**: 링크 자체 삭제(`rm wt/.envs`), 복사본 삭제, 읽기, 백업 복사(`cp x 백업/$(date …)`), 새 파일 만들기
- **통과 + 자동 백업**: 제자리 수정(Edit·`sed -i`·`perl -i`·`>>`·`tee -a`) 직전에 `<백업 폴더>/<이름>.<시각>.auto`(권한 600)로 백업. 판단할 수 없는 스크립트는 원본 전체를 백업한 뒤 통과.
- 못 보는 것: 파일로 저장한 스크립트 안, 컨테이너 안, 사람이 직접 친 명령, Claude 밖 도구의 셸 명령.

프로젝트별 설정(선택, 사용자 쪽이 우선이고 `protect`는 합침):

- 저장소: `<주 폴더>/.claude/envs-guard.json`
- 사용자: `~/.claude/hooks/envs-guard.config.json`의 `projects["<주 폴더 절대 경로>"]` ([예시](hooks/envs-guard/envs-guard.config.example.json))

```json
{ "protect": ["secrets/", "config/credentials.json"], "backupDir": "~/.my-app-env-backup" }
```

### korean-reply-guard — 한국어 답변 강제 (`UserPromptSubmit`·`Stop`)

- 질문을 보낼 때마다 "한국어로 답하라"는 알림을 모델 문맥에 넣습니다.
- 답변이 끝날 때 마지막 답변 본문(코드·경로·식별자 제외)의 한국어 단어 비율이 30% 미만이고 외국어 단어가 8개 이상이면, 끝내지 못하게 하고 한국어로 다시 쓰게 합니다(다시 쓰는 중에는 또 막지 않음).
- 한계: Claude Code 훅은 답변이 화면에 표시되기 전에 막을 수 없습니다. 도구 호출 사이의 짧은 진행 안내는 `Stop`이 보지 못해 알림만 적용됩니다.

## mod

mod는 Claude Code 화면·동작을 바꾸는 플러그인입니다. 이 저장소가 marketplace(`.claude-plugin/marketplace.json`)라서 플러그인 명령으로 설치합니다.

```bash
# 다른 PC: GitHub에서 설치
claude plugin marketplace add baboleevan/claude-helper
claude plugin install changed-files@claude-helper
claude plugin install decisions@claude-helper
claude plugin install model-switch@claude-helper

# 이 저장소를 고치는 PC: 클론한 폴더를 marketplace로 등록하면 폴더를 바로 읽습니다
claude plugin marketplace add ~/github/claude-helper
claude plugin install changed-files@claude-helper
claude plugin install decisions@claude-helper
claude plugin install model-switch@claude-helper
```

- 설정 폴더가 여러 개면(Orca 프로필마다) `CLAUDE_CONFIG_DIR=<프로필 폴더> claude plugin install ...`처럼 폴더마다 설치합니다.
- 실행 중인 세션에는 `/reload-plugins`로 반영합니다.
- 업데이트
  - GitHub에서 설치한 PC: `claude plugin update changed-files@claude-helper` 뒤 `/reload-plugins`
  - 클론 폴더를 marketplace로 등록한 PC: 파일을 고치고 `/reload-plugins`
- 끄기: `claude plugin disable changed-files@claude-helper`

### changed-files — 수정한 파일 패널

- 오른쪽 패널(fullscreen 화면) 맨 위에 지금 작업 중인 워크트리와 브랜치를 보여 줍니다. 세션 폴더가 아니라 마지막으로 수정한 파일이 속한 작업 트리를 기준으로 합니다.
- 그 아래에 이 세션에서 수정한 파일을 커밋 여부로 나누고, 그 안에서 작업 트리별로 보여 줍니다(`A` 새 파일·`M` 수정·`D` 삭제, 더한 줄·지운 줄, 횟수, `Bash`·`에이전트` 꼬리표). 행을 누르면 워크스페이스 기준 경로를 복사합니다.
  - **미커밋**: 지금 `git status`에 나오는 파일
  - **커밋됨**: 세션이 시작된 뒤 지금 HEAD에 커밋된 파일(`git log --since`). 지운 워크트리의 파일도 여기 둡니다.
  - **커밋 기록 없음**: 둘 다 아닌 파일. 되돌린 파일, git이 무시하는 파일, 지금 HEAD가 아닌 브랜치에 커밋한 파일이 여기 옵니다.
  - **저장소 밖**: git 저장소가 아닌 곳의 파일
  - 편집·Bash 직후와 30초마다(세션 밖 터미널에서 커밋한 것), 새로고침 버튼을 누를 때 다시 읽습니다. git이 실패해도 폴더가 있으면 이전 상태를 그대로 둡니다.
- 찾는 방법: Edit·Write·NotebookEdit 도구 호출, Bash 명령 앞뒤 `git status` 비교, 불러올 때 대화 기록.
- 패널이 안 보이면 `/changed-files`로 엽니다. 닫기는 패널의 닫기 표시나 `ctrl+x x`.
- 한계
  - Bash 변경은 원래 수정돼 있던 파일을 다시 고치면 잡지 못합니다.
  - 대화를 압축했으면 압축 전 기록은 다시 채우지 못할 수 있습니다.
  - Bash 호출마다 `git status`가 앞뒤로 돌고, 편집·Bash 뒤에는 `git status`와 `git log`가 한 번 더 돕니다.
  - "세션 시작"은 이어서 연 세션이면 처음 연 때입니다. 그 뒤 다른 사람이 커밋해 받아 온 파일도 커밋됨으로 보일 수 있습니다.

### decisions — 결정 사항 패널

- 오른쪽 패널(수정한 파일 패널 옆 탭)에 **결정할 것**(사용자가 정해야 할 것)과 **결정된 것**(최근 순)을 보여 줍니다. 탭 이름에 결정할 것 개수가 붙습니다.
- 결정할 것마다 출처·배경, 선택지 버튼(번호·추천 표시)과 직접 입력칸이 있습니다. 고르면 기록하고 Claude에게 "[결정 사항] 제목 / 선택: ..." 메시지를 보냅니다. 세션이 비어 있으면 바로, 작업 중이면 끝난 뒤 이어서 진행합니다.
- 항목이 생기는 길
  - Claude가 도구로 올립니다: `mcp__decisions__add`(결정할 것), `record`(대화로 정한 것), `resolve`(대화로 답한 결정할 것 닫기), `list`(보기). 언제 쓰는지는 도구 설명에 적어 둡니다(시스템 프롬프트 훅은 조직 보안 플러그인이 건너뛰어 쓰지 않습니다).
  - AskUserQuestion으로 받은 답은 자동으로 결정된 것에 기록합니다.
- 기록은 워크스페이스마다 파일 하나(`~/.claude/decisions/<워크스페이스 이름>.json`)라서 이 PC의 모든 세션·설정 폴더가 같이 봅니다. 다른 세션이 바꾸면 10초 안에 다시 읽습니다.
  - 워크스페이스: 메인 checkout의 상위 폴더에 `.worktrees`나 `CLAUDE.md`가 있으면 그 상위 폴더, 아니면 그 저장소, git 밖이면 세션 폴더입니다.
  - 파일을 직접 고쳐도 됩니다(`{ "items": [...] }`). 모양이 깨진 항목은 건너뜁니다.
- 패널이 안 보이면 `/decisions`로 엽니다.
- 한계: 이름이 같은 워크스페이스는 같은 파일을 씁니다. 두 세션이 거의 같은 순간에 쓰면 늦게 쓴 쪽이 이깁니다(쓰기 직전에 다시 읽어 줄입니다).

### model-switch — 모델·effort·advisor 바꾸기

- 입력창 위 줄에 **모델**(Haiku·Sonnet·Opus·Fable), **effort**(low·medium·high·xhigh·max), **advisor**(fable·opus·sonnet·off) 버튼을 두고, 지금 값을 주 버튼으로 표시합니다. 누르면 내장 명령(`/model`·`/effort`·`/advisor`)을 대신 실행합니다.
  - 마우스로 누르거나, `ctrl+x tab`으로 줄에 초점을 옮긴 뒤 화살표와 Enter로 누릅니다.
  - 여러 번 누르면 누른 순서대로 하나씩 실행합니다. 바꾸는 동안 줄 끝에 "…(으)로 바꾸는 중"이 보입니다.
- `/model-switch`: 지금 값(모델·effort·advisor)과 사용법을 보여 줍니다.
- `/model-switch model <이름> effort <수준> advisor <이름|off>`: 적은 항목만 한 번에 바꿉니다. 순서와 상관없이 모델 → effort → advisor 순으로 실행합니다.
  - `model=opus`처럼 붙여 써도 되고, `m`·`e`·`a`로 줄여 써도 됩니다.
  - sonnet·opus·fable은 모델과 advisor 둘 다의 이름이라 항목 이름을 꼭 씁니다(`/model-switch sonnet`은 거절).
  - 결과는 실행된 내장 명령의 출력(예: `Set model to Sonnet 5.5 ...`)으로 대화에 남습니다.
- 내장 명령이 하는 일은 그대로입니다. `/model`·`/effort`·`/advisor`는 고른 값을 사용자 설정(`settings.json`)에 저장해 새 세션의 기본값이 됩니다.
- 사람이 직접 친 `/model`·`/effort`·`/advisor`(모델 선택기 포함)도 줄에 반영합니다. effort는 요청마다 실제로 보낸 값으로 다시 맞춥니다.
- 한계
  - advisor는 요청마다 알려 주는 곳이 없어 설정의 `advisorModel`로 표시합니다. 설정에 없으면 off로 봅니다.
  - `/advisor`는 결과를 돌려주지 않고, 실행 직후에는 설정도 아직 이전 값입니다. 그래서 고른 값을 바로 표시하고 1초·3초 뒤 설정을 다시 읽어 바로잡습니다.
  - advisor로 쓸 수 있는 모델은 계정·주 모델마다 다릅니다. 쓸 수 없는 값을 고르면 `/advisor`가 거절하고 그 이유를 대화에 남기며, 줄은 몇 초 뒤 원래 값으로 돌아옵니다.
  - 모델을 바꾸면 effort는 새 모델에 저장된 값으로 표시합니다. 저장된 값이 없으면 다음 요청 전까지 비어 있습니다.
  - 조직 라이브러리의 같은 이름 플러그인(`model-switch@claudeai-organization-library`)과 함께 켜지 않습니다. 같은 이름이라 상태가 겹칩니다.

## 테스트

```bash
npm test            # 훅
npm run test:mods   # mod (claude CLI 필요)
```

테스트는 임시 폴더만 씁니다(실제 환경 파일·설정 파일을 건드리지 않음).

## 새 항목 추가

- 훅: `hooks/<이름>/<이름>.mjs`와 테스트를 두고, `install.mjs`의 `HOOKS`에 한 줄을 추가합니다.
- mod: `mods/<이름>/`(`.claude-plugin/plugin.json`, `hooks/`, `types/`, `tests/`)를 두고 `.claude-plugin/marketplace.json`의 `plugins`에 한 줄을 추가합니다. 고칠 때마다 `plugin.json`의 `version`을 올립니다.
- 스킬: `skills/` 폴더를 만들어 같은 방식으로 추가합니다(설치 스크립트 확장 필요).
