// 입력창 위 줄에서 모델·effort·advisor를 눌러 바꾸고, /model-switch 명령으로 지금 값을 보거나 한 번에 바꾼다.
//
// 바꾸는 일은 Claude Code 내장 명령(/model, /effort, /advisor)에 맡긴다. 이 mod는 그 명령을 대신 실행하고,
// 지금 값을 기억해 줄에 표시한다.
//
// 지금 값을 아는 길
//   - 모델: $.session.model(), /model 실행 뒤(모델 선택기 포함), 주 대화의 요청마다(turn.step)
//     classic.PostModelSwitch 훅은 쓰지 않는다. 조직 보안 플러그인이 먼저 받아 넘겨 버리면 이 mod의 훅이 건너뛰어지기 때문이다.
//   - effort: 주 대화의 요청마다(turn.step), 설정에 저장된 값(modelSettings.<모델>.effortLevel, effortLevel), /effort 인자
//   - advisor: 설정 advisorModel. 요청마다 알려 주는 곳은 없다.
//     /advisor는 고른 값을 설정에 저장하지만, 실행 직후 설정을 읽으면 아직 이전 값이고(실제 세션에서 확인),
//     패널 명령이라 $.command.run 결과에 성공·거절 글도 없다. 그래서 고른 값을 바로 표시하고, 1초·3초 뒤 설정을
//     다시 읽어 바로잡는다. 거절됐으면 설정이 그대로라 원래 값으로 돌아온다.
//
// mod가 $.command.run으로 부른 명령은 이 mod 자신의 command.run 훅을 지나지 않는다. 그래서 바꾼 뒤의 값은
// 직접 다시 읽어 표시한다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AdvisorChoice, EffortLevel, ModelChoice } from '../types'

const MODELS: readonly ModelChoice[] = [
  { alias: 'haiku', label: 'Haiku' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'fable', label: 'Fable' },
]
const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
// /advisor가 받는 모델은 계정마다 다르다. 쓸 수 없는 모델을 고르면 /advisor가 거절하고 그 이유를 대화에 남긴다.
const ADVISORS: readonly AdvisorChoice[] = ['fable', 'opus', 'sonnet', 'off']

const model = atom({ plugin: 'model-switch', key: 'model' } as const, '')
const effort = atom({ plugin: 'model-switch', key: 'effort' } as const, '')
const advisor = atom({ plugin: 'model-switch', key: 'advisor' } as const, '')
const pending = atom({ plugin: 'model-switch', key: 'pending' } as const, '')

const COMMAND = 'model-switch'
// /advisor 뒤 설정을 다시 읽는 때(ms). 실행 직후에는 설정이 아직 이전 값이다.
const ADVISOR_RECHECK_MS = [1_000, 3_000] as const
const USAGE =
  '/model-switch [model <haiku|sonnet|opus|fable>] [effort <low|medium|high|xhigh|max>] [advisor <fable|opus|sonnet|off>]'

/** 바꿀 항목 하나: 어느 내장 명령에 어떤 값을 넘길지 */
type Change = { kind: 'model' | 'effort' | 'advisor'; value: string }

/** 항목 이름을 화면 글자로 바꾼다 */
function kindLabel(kind: Change['kind']): string {
  return kind === 'model' ? '모델' : kind
}

/** 모델 이름(`claude-opus-5-5`, `opus[1m]`)이 어느 모델 버튼에 해당하는지 찾는다. 없으면 undefined */
function aliasOf(name: string): ModelChoice['alias'] | undefined {
  const lower = name.toLowerCase()
  return MODELS.find(choice => lower.includes(choice.alias))?.alias
}

/** /effort가 받는 수준이면 그 값을, 아니면 undefined를 돌려준다 */
function asEffort(word: unknown): EffortLevel | undefined {
  if (typeof word !== 'string') return undefined
  const lower = word.trim().toLowerCase()
  return EFFORTS.find(level => level === lower)
}

/** advisor 값(`opus`, `claude-opus-5-5`, `off`)을 줄에 쓰는 이름으로 바꾼다. 알 수 없으면 undefined */
function asAdvisor(word: unknown): AdvisorChoice | undefined {
  if (typeof word !== 'string') return undefined
  const lower = word.trim().toLowerCase()
  if (lower === 'off') return 'off'
  const alias = aliasOf(lower)
  return ADVISORS.find(choice => choice === alias)
}

/** 설정의 advisorModel 값을 줄에 쓰는 이름으로 바꾼다. 비어 있으면 advisor가 꺼진 것이다 */
function advisorFromSetting(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'off'
  return asAdvisor(value) ?? value.trim()
}

/** 세션의 주 모델을 다시 읽어 기억한다 */
async function refreshModel($: EngineInterface): Promise<string> {
  const name = await $.session.model()
  await update($, model, () => name)
  return name
}

/**
 * 모델에 저장된 effort를 읽는다(`modelSettings.<모델>.effortLevel`, 없으면 `effortLevel`).
 * /model로 모델을 바꾸면 세션이 그 모델에 저장된 수준으로 옮겨 가므로, 다음 요청 전에 표시할 값으로 쓴다.
 */
async function savedEffort($: EngineInterface, name: string): Promise<EffortLevel | undefined> {
  const settings = await $.settings.read()
  const perModel = (settings.modelSettings ?? {}) as Record<string, { effortLevel?: unknown } | undefined>
  const bare = name.replace(/\[.*\]$/, '').trim()
  return asEffort(perModel[bare]?.effortLevel) ?? asEffort(settings.effortLevel)
}

/** /advisor를 실행한 뒤: 고른 값을 바로 표시하고, 설정에 반영될 시간을 두고 다시 읽어 바로잡는다 */
async function markAdvisor($: EngineInterface, picked: string): Promise<void> {
  const choice = asAdvisor(picked)
  if (choice !== undefined) {
    await update($, advisor, () => choice)
  }
  for (const ms of ADVISOR_RECHECK_MS) {
    $.clock.after(ms, () => {
      refreshAdvisor($).catch(() => undefined)
    })
  }
}

/** 설정의 advisorModel을 다시 읽어 기억한다 */
async function refreshAdvisor($: EngineInterface): Promise<void> {
  const value = await $.settings.read({ key: 'advisorModel' })
  await update($, advisor, () => advisorFromSetting(value))
}

// 버튼과 명령으로 들어온 변경은 하나씩 차례로 실행한다. 모델을 바꾸고 바로 effort를 누르면 /model 다음에 /effort가 돌아야
// 새 모델에 effort가 걸린다. 다시 불러오기(reload)하면 모듈이 처음부터 돌아 이 줄도 새로 시작한다.
let queue: Promise<void> = Promise.resolve()

/** 앞의 변경이 끝난 뒤에 task를 실행한다. 앞의 변경이 실패해도 다음 변경은 실행한다 */
function inOrder(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  return run
}

/** 내장 명령 하나를 실행하고, 실행한 뒤의 값을 다시 읽어 기억한다 */
async function apply($: EngineInterface, change: Change): Promise<void> {
  await update($, pending, () => `${kindLabel(change.kind)} ${change.value}`)
  try {
    await $.command.run({ command: change.kind, args: change.value })
    if (change.kind === 'model') {
      const name = await refreshModel($)
      const level = await savedEffort($, name)
      await update($, effort, () => level ?? '')
    } else if (change.kind === 'effort') {
      await update($, effort, () => change.value)
    } else {
      await markAdvisor($, change.value)
    }
  } catch (error) {
    $.ui.toast(`${kindLabel(change.kind)} 변경 실패: ${String(error)}`)
  } finally {
    await update($, pending, () => '')
  }
}

/** 변경 목록을 차례로 실행한다 */
function applyAll($: EngineInterface, changes: readonly Change[]): Promise<void> {
  return inOrder(async () => {
    for (const change of changes) {
      await apply($, change)
    }
  })
}

/**
 * /model-switch 인자를 변경 목록으로 바꾼다. `model opus effort high advisor off`처럼 항목 이름 뒤에 값을 쓰고,
 * `model=opus`처럼 붙여 써도 된다. sonnet·opus·fable은 모델과 advisor 둘 다에 쓰이므로 항목 이름을 꼭 쓴다.
 */
function parseArgs(args: string): { changes: Change[] } | { error: string } {
  const words = args
    .trim()
    .split(/\s+/)
    .flatMap(word => word.split('='))
    .filter(word => word !== '')
  const found = new Map<Change['kind'], string>()

  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? ''
    const key = word.toLowerCase()
    const value = words[i + 1]?.toLowerCase()
    const kind = key === 'model' || key === 'm' ? 'model' : key === 'effort' || key === 'e' ? 'effort' : key === 'advisor' || key === 'a' ? 'advisor' : undefined

    if (kind === undefined) {
      return { error: `알 수 없는 항목: ${word}` }
    }
    if (value === undefined) {
      return { error: `${kindLabel(kind)} 값이 없습니다` }
    }
    const isValid =
      kind === 'model' ? MODELS.some(choice => choice.alias === value) : kind === 'effort' ? asEffort(value) !== undefined : ADVISORS.some(choice => choice === value)
    if (!isValid) {
      return { error: `${kindLabel(kind)}에 쓸 수 없는 값: ${value}` }
    }
    found.set(kind, value)
  }

  // 모델을 먼저 바꿔야 effort와 advisor가 새 모델에 맞춰 걸린다.
  const order: Change['kind'][] = ['model', 'effort', 'advisor']
  return { changes: order.flatMap(kind => (found.has(kind) ? [{ kind, value: found.get(kind) ?? '' }] : [])) }
}

/** 지금 값을 한 줄로 보여 준다 */
async function statusText($: EngineInterface): Promise<string> {
  const [name, level, adv] = await Promise.all([read($, model), read($, effort), read($, advisor)])
  const shown = name === '' ? '?' : `${aliasOf(name) ?? name} (${name})`
  return [`모델 ${shown} · effort ${level || '?'} · advisor ${adv || '?'}`, `사용법: ${USAGE}`].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const name = await refreshModel($).catch(() => '')
    const level = await savedEffort($, name).catch(() => undefined)
    if (level !== undefined) {
      await update($, effort, () => level)
    }
    await refreshAdvisor($).catch(() => undefined)
    await $.command
      .register({
        name: COMMAND,
        description: '모델·effort·advisor의 지금 값을 보거나 한 번에 바꾼다',
        argumentHint: '[model <이름>] [effort <수준>] [advisor <이름|off>]',
      })
      .catch(() => undefined)
    return result
  })

  // 주 대화의 요청이 실제로 쓰는 모델과 effort. 하위 에이전트(agentId 있음)의 요청은 세지 않는다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await update($, model, () => e.model).catch(() => undefined)
      if (typeof e.effort === 'string') {
        const level = e.effort
        await update($, effort, () => level).catch(() => undefined)
      }
    }
    return yield* next(e)
  })

  // 사람이 직접 친 /model·/effort·/advisor도 줄에 반영한다. 이 훅이 실패해도 명령은 훅이 없던 것처럼 그대로 돈다(.catch).
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    const name = await refreshModel($).catch(() => '')
    const level = await savedEffort($, name).catch(() => undefined)
    await update($, effort, () => level ?? '')
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = asEffort(e.args)
    if (level !== undefined) {
      await update($, effort, () => level)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'advisor' }, async ($, e, next) => {
    const result = await next(e)
    await markAdvisor($, e.args ?? '').catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  // /model-switch: 인자가 없으면 지금 값을 보여 주고, 있으면 내장 명령을 차례로 실행하도록 맡긴다.
  // 명령 대기열은 세션이 쉴 때 돈다. 이 훅 안에서 그 실행을 기다리면 서로를 기다릴 수 있어, 맡기기만 하고 바로 답한다.
  on('command.run', { command: COMMAND }, async ($, e) => {
    // 엔진은 인자가 없으면 ''를 넘기지만, 다른 플러그인이 args를 빼고 부를 때도 상태 보기로 다룬다.
    const args = e.args ?? ''
    if (args.trim() === '') {
      return { text: await statusText($), isTextDisplayOnly: true }
    }
    const parsed = parseArgs(args)
    if ('error' in parsed) {
      return { text: `${parsed.error}\n사용법: ${USAGE}`, isTextDisplayOnly: true }
    }
    void applyAll($, parsed.changes).catch(() => undefined)
    const plan = parsed.changes.map(change => `${kindLabel(change.kind)} ${change.value}`).join(' · ')
    return { text: `바꿉니다: ${plan}`, isTextDisplayOnly: true }
  }).catch(() => ({ text: `/model-switch 처리 중 오류가 났습니다.\n사용법: ${USAGE}`, isTextDisplayOnly: true as const }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const [name, level, adv, busy] = await Promise.all([read($, model), read($, effort), read($, advisor), read($, pending)])
    const current = aliasOf(name)
    // 누름은 변경을 맡기고 그 완료를 돌려준다(차례 실행은 applyAll이 지킨다).
    const press = (change: Change) => () => applyAll($, [change]).catch(() => undefined)

    return (
      <Box flexWrap="wrap" columnGap={2}>
        <Box key="model" gap={1}>
          <Text bold>모델</Text>
          {MODELS.map(choice => (
            <Button
              key={`model-${choice.alias}`}
              label={choice.label}
              variant={choice.alias === current ? 'primary' : undefined}
              dimColor={choice.alias !== current}
              onPress={press({ kind: 'model', value: choice.alias })}
            />
          ))}
        </Box>
        <Box key="effort" gap={1}>
          <Text bold>effort</Text>
          {EFFORTS.map(choice => (
            <Button
              key={`effort-${choice}`}
              label={choice}
              variant={choice === level ? 'primary' : undefined}
              dimColor={choice !== level}
              onPress={press({ kind: 'effort', value: choice })}
            />
          ))}
        </Box>
        <Box key="advisor" gap={1}>
          <Text bold>advisor</Text>
          {ADVISORS.map(choice => (
            <Button
              key={`advisor-${choice}`}
              label={choice}
              variant={choice === adv ? 'primary' : undefined}
              dimColor={choice !== adv}
              onPress={press({ kind: 'advisor', value: choice })}
            />
          ))}
        </Box>
        {busy !== '' && <Text dimColor>{busy}(으)로 바꾸는 중…</Text>}
      </Box>
    )
  })
}
