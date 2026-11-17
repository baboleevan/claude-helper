import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// 입력창 위 줄을 그릴 때 엔진이 넘기는 속성
const BAND = {
  plugin: 'model-switch',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** 테스트 하나의 가짜 세션: 지금 모델과 설정, 실행된 내장 명령 */
type World = {
  model: string
  settings: { modelSettings?: Record<string, { effortLevel?: string }>; effortLevel?: string; advisorModel?: string }
  ran: string[]
  /** /advisor가 거절할 모델 */
  refuse: string[]
}

/** 처음 상태: Opus에 xhigh가 저장돼 있고 advisor는 fable이다 */
function newWorld(): World {
  return {
    model: 'claude-opus-5-5',
    settings: {
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5': { effortLevel: 'medium' } },
      advisorModel: 'fable',
    },
    ran: [],
    refuse: [],
  }
}

/** 엔진 자리에 서는 훅들: 모델 읽기, 설정 읽기, 명령 등록, 내장 명령 실행(/model은 모델을 바꾼다) */
function standIn(on: On, world: World) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: world.model }))
  on('settings.read', () => ({ value: world.settings }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', (_, e) => {
    world.ran.push(`/${e.command} ${e.args}`.trim())
    if (e.command === 'model') {
      world.model = `claude-${e.args}-5-5`
    }
    // /advisor는 고른 값을 설정에 저장하고 off면 지운다. world.refuse에 든 모델은 거절해 설정을 그대로 둔다.
    // 패널 명령이라 결과 글은 없다.
    if (e.command === 'advisor') {
      if (!world.refuse.includes(e.args)) {
        if (e.args === 'off') {
          delete world.settings.advisorModel
        } else {
          world.settings.advisorModel = e.args
        }
      }
      return {}
    }
    return { text: `${e.command} ${e.args}` }
  })
}

/** 사람이 입력창에서 `/command args`를 친 것처럼 명령을 실행한다 */
function typed($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

/** 줄을 그려 버튼마다 주 버튼(지금 값)인지 돌려준다 */
async function marked($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()
  return buttons.filter(button => button.props.variant === 'primary').map(button => button.key ?? '')
}

/** 맡겨 둔 변경이 count개 실행될 때까지 줄을 다시 그리며(엔진 왕복) 기다린다 */
async function settle($: Engine, world: World, count: number) {
  for (let i = 0; i < 100 && world.ran.length < count; i++) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.unmount()
  }
}

// 세션을 열면 줄이 지금 모델·저장된 effort·설정의 advisor를 표시해야 한다. 틀리면 사람이 지금 값을 잘못 알고 누른다.
test('줄이 지금 모델·effort·advisor를 표시한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  expect(await marked($)).toEqual(['model-opus', 'effort-xhigh', 'advisor-fable'])
})

// 버튼을 누르면 내장 명령을 실행하고, 모델을 바꾸면 새 모델에 저장된 effort로 표시가 옮겨 가야 한다.
test('모델 버튼은 /model을 실행하고 새 모델의 effort를 표시한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'model-sonnet' })
  await ui.unmount()
  await settle($, world, 1)

  expect(world.ran).toEqual(['/model sonnet'])
  expect(await marked($)).toEqual(['model-sonnet', 'effort-medium', 'advisor-fable'])
})

// effort·advisor 버튼도 해당 내장 명령으로 바꾸고, 바꾼 값을 바로 표시해야 한다.
test('effort·advisor 버튼은 /effort·/advisor를 실행한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'effort-low' })
  await ui.press({ key: 'advisor-off' })
  await ui.unmount()
  await settle($, world, 2)

  expect(world.ran).toEqual(['/effort low', '/advisor off'])
  expect(await marked($)).toEqual(['model-opus', 'effort-low', 'advisor-off'])
})

// 인자 없는 /model-switch는 아무것도 바꾸지 않고 지금 값과 사용법만 보여 줘야 한다.
test('/model-switch는 지금 값을 보여 준다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const { text } = await typed($, 'model-switch')
  expect(text).toContain('모델 opus (claude-opus-5-5) · effort xhigh · advisor fable')
  expect(text).toContain('사용법: /model-switch')
  expect(world.ran).toEqual([])
})

// 한 번에 여러 항목을 바꾸면 모델을 먼저 바꾼 뒤 effort·advisor를 걸어야 새 모델에 맞게 적용된다.
test('/model-switch는 모델 → effort → advisor 순서로 바꾼다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const { text } = await typed($, 'model-switch', 'advisor=opus effort high model sonnet')
  expect(text).toBe('바꿉니다: 모델 sonnet · effort high · advisor opus')
  await settle($, world, 3)

  expect(world.ran).toEqual(['/model sonnet', '/effort high', '/advisor opus'])
  expect(await marked($)).toEqual(['model-sonnet', 'effort-high', 'advisor-opus'])
})

// sonnet·opus·fable은 모델과 advisor 둘 다의 이름이라 항목 없이 쓰면 거절하고, 틀린 값은 아무것도 실행하지 않아야 한다.
test('/model-switch는 잘못된 인자를 거절하고 아무것도 바꾸지 않는다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  expect((await typed($, 'model-switch', 'sonnet')).text).toContain('알 수 없는 항목: sonnet')
  expect((await typed($, 'model-switch', 'effort ultra')).text).toContain('effort에 쓸 수 없는 값: ultra')
  expect((await typed($, 'model-switch', 'advisor')).text).toContain('advisor 값이 없습니다')
  expect((await typed($, 'model-switch', 'model haiku advisor gpt')).text).toContain('advisor에 쓸 수 없는 값: gpt')
  await settle($, world, 1)

  expect(world.ran).toEqual([])
})

// 사람이 직접 친 /effort·/advisor도 줄에 반영해야 한다. 안 그러면 줄과 실제 값이 어긋난다.
test('직접 친 /effort·/advisor를 줄에 반영한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  await typed($, 'effort', 'max')
  await typed($, 'advisor', 'sonnet')

  expect(await marked($)).toEqual(['model-opus', 'effort-max', 'advisor-sonnet'])
})

// 설정에 advisorModel이 없으면 advisor가 꺼진 것으로 표시해야 한다.
test('설정에 advisor가 없으면 off로 표시한다', async ($, on) => {
  const world = newWorld()
  delete world.settings.advisorModel
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  expect(await marked($)).toEqual(['model-opus', 'effort-xhigh', 'advisor-off'])
})

// /advisor가 쓸 수 없는 모델을 거절하면 줄은 원래 advisor를 계속 표시해야 한다. 고른 값을 표시하면 실제와 어긋난다.
test('/advisor가 거절하면 잠시 뒤 원래 advisor로 돌아온다', async ($, on) => {
  const world = newWorld()
  world.refuse = ['sonnet']
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  standIn(on, world)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'advisor-sonnet' })
  await ui.unmount()
  await settle($, world, 1)
  expect(world.ran).toEqual(['/advisor sonnet'])
  // 결과를 알 수 없어 처음에는 고른 값을 표시한다.
  expect(await marked($)).toEqual(['model-opus', 'effort-xhigh', 'advisor-sonnet'])

  await clock.advance(3_000)
  await clock.settle()
  expect(await marked($)).toEqual(['model-opus', 'effort-xhigh', 'advisor-fable'])
})
