/** 줄에서 고를 수 있는 모델. `alias`는 /model·/advisor에 넘기는 이름이고 `label`은 버튼 글자다 */
export type ModelChoice = { alias: 'haiku' | 'sonnet' | 'opus' | 'fable'; label: string }

/** /effort가 받는 수준. 낮은 것부터 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** advisor로 고를 수 있는 값. `off`는 advisor를 끈다 */
export type AdvisorChoice = 'fable' | 'opus' | 'sonnet' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'model-switch': {
      /** 세션의 주 모델 이름(`claude-opus-5-5`, `opus[1m]` 등). 아직 모르면 '' */
      model: string
      /** 주 모델이 쓰는 effort 수준. 아직 모르면 '' */
      effort: string
      /** advisor 모델 별칭(`fable`·`opus`·`sonnet`) 또는 `off`. 아직 모르면 '' */
      advisor: string
      /** 지금 바꾸는 중인 항목 설명(예: `모델 opus`). 없으면 '' */
      pending: string
    }
  }
}
