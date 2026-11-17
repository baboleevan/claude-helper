/** 결정 하나에서 고를 수 있는 선택지 */
export type DecisionOption = {
  /** 버튼에 보이는 짧은 이름 */
  label: string
  /** 고르면 무엇이 되는지 한 줄 설명. 없으면 빈 문자열 */
  description: string
  /** Claude가 추천하는 선택지인지 */
  isRecommended: boolean
}

/** 결정 사항 하나 */
export type Decision = {
  /** 고유 id (d-<시각>-<무작위>) */
  id: string
  /** 무엇을 정하는지 한 줄 */
  title: string
  /** 배경·영향을 짧게. 없으면 빈 문자열 */
  context: string
  /** 출처(Jira 키, PR, 저장소 등). 없으면 빈 문자열 */
  source: string
  /** 고를 수 있는 선택지. 대화로 정한 기록에는 없을 수 있다 */
  options: DecisionOption[]
  /** 결정할 것(pending)인지, 결정된 것(decided)인지 */
  status: 'pending' | 'decided'
  /** 정한 내용. 결정 전이면 빈 문자열 */
  choice: string
  /** 어떻게 정했는지: 패널에서 고름(panel), 대화로 정함(chat), AskUserQuestion 답(question). 결정 전이면 빈 문자열 */
  how: '' | 'panel' | 'chat' | 'question'
  /** 올린 때(ISO) */
  createdAt: string
  /** 정한 때(ISO). 결정 전이면 빈 문자열 */
  decidedAt: string
}

/** 결정 기록 파일의 위치와 내용. 파일이 원본이고 이 값은 패널을 그리려고 둔 사본이다 */
export type DecisionBook = {
  /** 기록 파일 절대 경로 */
  file: string
  /** 화면에 보일 기록 파일 이름(~로 줄인 경로) */
  label: string
  /** 결정 사항들 */
  items: Decision[]
  /** 마지막으로 읽은 파일 수정 시각. 다른 세션이 바꿨는지 볼 때 쓴다 */
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    decisions: {
      book: Shaped<DecisionBook | null>
    }
  }
}
