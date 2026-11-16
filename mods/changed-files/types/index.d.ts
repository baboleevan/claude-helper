/** 이 세션에서 바뀐 파일 하나의 기록 */
export type ChangedFile = {
  /** 파일의 절대 경로. 화면에는 작업 트리 기준 상대 경로(rel)로 보인다 */
  path: string
  /** 파일이 속한 git 작업 트리의 최상위 경로. git 저장소 밖이면 null */
  root: string | null
  /** 작업 트리 기준 상대 경로. 저장소 밖이면 빈 문자열 */
  rel: string
  /** 이 세션에서의 상태: 새로 만듦, 고침, 지움 */
  kind: 'added' | 'modified' | 'deleted'
  /** 마지막으로 바꾼 수단. Bash는 명령 앞뒤 git 상태를 비교해 찾은 것 */
  via: 'Edit' | 'Write' | 'NotebookEdit' | 'Bash'
  /** 바꾼 횟수 */
  count: number
  /** 더한 줄 수 합계 (Edit·Write만 센다) */
  added: number
  /** 지운 줄 수 합계 (Edit·Write만 센다) */
  removed: number
  /** 마지막으로 바꾼 때 ($.clock.now 밀리초) */
  lastAt: number
  /** 서브에이전트가 바꾼 적이 있는지 */
  byAgent: boolean
}

/** 수정한 파일 목록과 이미 센 도구 호출 id. 둘을 한 값에 두어 "센 적 있는지 확인 → 합치기"를 한 번에 쓴다 */
export type FileLog = {
  /** 수정한 파일들 */
  list: ChangedFile[]
  /**
   * 이미 센 Edit·Write·NotebookEdit 호출의 tool_use_id. 세션 전체에서 하나만 둔다.
   * 다시 불러오기·새로고침 때 대화 기록을 다시 읽어도 두 번 세지 않게 한다.
   * 파일마다 최근 몇 개만 두면 많이 고친 파일의 오래된 id가 밀려나 매번 다시 세게 되므로 넉넉히 둔다.
   */
  seen: string[]
}

/** 파일이 속한 git 작업 트리 하나 */
export type WorkTree = {
  /** 작업 트리 최상위 경로 */
  root: string
  /** 지금 브랜치 이름. 분리된 HEAD면 '(분리됨) <짧은 해시>' */
  branch: string
  /** git worktree add로 만든 작업 트리인지. 메인 checkout이면 false */
  isLinked: boolean
  /** 이 작업 트리에서 마지막으로 파일을 바꾼 때. 아직 없으면 0 */
  lastAt: number
}

/** 경로를 짧게 보이는 데 쓰는 기준 */
export type Place = {
  /** 세션 작업 폴더 */
  cwd: string
  /** 세션 작업 폴더가 속한 저장소의 상위 폴더. 작업 트리 이름을 이 기준 상대 경로로 보인다 */
  base: string | null
  /** 홈 폴더. 기준 밖 경로를 ~로 줄인다 */
  home: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'changed-files': {
      files: Shaped<FileLog>
      trees: Shaped<WorkTree[]>
      place: Shaped<Place | null>
    }
  }
}
