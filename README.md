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
- 일부만 설치: `node install.mjs --only envs-guard`
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

## 테스트

```bash
npm test
```

테스트는 임시 폴더만 씁니다(실제 환경 파일·설정 파일을 건드리지 않음).

## 새 항목 추가

- 훅: `hooks/<이름>/<이름>.mjs`와 테스트를 두고, `install.mjs`의 `HOOKS`에 한 줄을 추가합니다.
- 스킬·mod: `skills/`, `mods/` 폴더를 만들어 같은 방식으로 추가합니다(설치 스크립트 확장 필요).
