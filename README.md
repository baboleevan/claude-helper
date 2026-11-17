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

### ask-only — 질문엔 답변만 (`UserPromptSubmit`·`PreToolUse`, `/ask` 명령)

`/ask <질문>`으로 묻거나 의문형으로 프롬프트를 쓰면 코드를 고치지 않고 답변만 하게 합니다.

- **판정**: `/ask`로 시작하거나, 물음표로 끝나거나, "뭐야·어때·왜·~까·~나요·~지" 같은 의문 어미로 끝나면 질문입니다. "고쳐줄래?"처럼 고쳐·추가해·바꿔·배포해·해줘 같은 요청 동사가 들어 있으면 작업 요청으로 봅니다(`/ask`는 항상 답변만).
- **질문일 때**: 모델 문맥에 "답변만 하라"는 안내를 넣고, 다음 프롬프트까지 이 세션에서 아래를 막습니다.
  - Edit·Write·MultiEdit·NotebookEdit
  - 상태를 바꾸는 Bash 명령: 파일로 리다이렉트, `rm`·`mv`·`cp`·`tee`, `sed -i`, git 커밋·푸시·브랜치 전환, `gh pr create/merge`, 설치, 배포 스크립트, `docker up/down`, 쓰기 SQL 등
- **허용**: Read·Grep·Glob과 `cat`·`grep`·`ls`·`git status/diff/log`·`gh pr view` 같은 읽기 명령
- **Bash 판정 방식**: 따옴표 안 문자열은 빼고(검색어에 "install"이 있어도 설치로 보지 않음), 명령을 `;` `&&` `||` `|`로 나눠 각 명령의 실행 파일과 하위 명령으로 판단합니다. `bash -c "…"`는 안의 명령을 다시 봅니다.
- **`/ask` 명령**: 설치할 때 각 설정 파일 옆의 `commands/ask.md`로 복사됩니다.
- **상태 파일**: `~/.claude/hooks/state/ask-only-<세션 ID>`(환경변수 `ASK_ONLY_STATE_DIR`로 변경 가능). 작업 프롬프트가 오면 지워집니다.
- **한계**: 규칙 기반이라 애매한 문장은 틀릴 수 있습니다(예: "문제가 있어요" 같은 평서문). 파일로 저장한 스크립트 안이나 `node -e`·`python -c` 안의 쓰기는 보지 못하고, 그 경우에는 문맥 안내만 적용됩니다.

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

# 이 저장소를 고치는 PC: 클론한 폴더를 marketplace로 등록하면 폴더를 바로 읽습니다
claude plugin marketplace add ~/github/claude-helper
claude plugin install changed-files@claude-helper
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
  - **변경 없음(되돌림)**: 둘 다 아닌 파일. **저장소 밖**: git 저장소가 아닌 곳의 파일
  - 편집·Bash 직후와 30초마다(세션 밖 터미널에서 커밋한 것), 새로고침 버튼을 누를 때 다시 읽습니다.
- 찾는 방법: Edit·Write·NotebookEdit 도구 호출, Bash 명령 앞뒤 `git status` 비교, 불러올 때 대화 기록.
- 패널이 안 보이면 `/changed-files`로 엽니다. 닫기는 패널의 닫기 표시나 `ctrl+x x`.
- 한계: Bash 변경은 원래 수정돼 있던 파일을 다시 고치면 잡지 못합니다. 대화를 압축했으면 압축 전 기록은 다시 채우지 못할 수 있습니다. Bash 호출마다 `git status`가 앞뒤로 돕니다.

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
