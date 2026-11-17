import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 가짜 워크스페이스 /w(.worktrees가 있는 여러 저장소 폴더)와 그 안의 저장소 /w/docs. 세션 폴더는 /w/docs다.
// 기록 파일은 홈(/home/u)의 .claude/decisions/w.json이 되어야 한다.
const HOME = '/home/u'
const FILE = `${HOME}/.claude/decisions/w.json`

const PANE = {
  plugin: 'decisions',
  component: 'Pane',
  requestId: 'decisions',
  props: {
    title: '결정 사항',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** 테스트 하나가 쓰는 가짜 파일·보낸 메시지 */
type World = { files: Map<string, { text: string; mtimeMs: number }>; dirs: Set<string>; sent: string[]; tick: number }

/** 처음 상태: 워크스페이스 표시(.worktrees)만 있고 기록 파일은 없다 */
function newWorld(): World {
  return { files: new Map(), dirs: new Set(['/w/.worktrees']), sent: [], tick: 1 }
}

/** 기록 파일 내용을 읽어 결정 사항 목록으로 돌려준다 */
function itemsOf(world: World): { title: string; status: string; choice: string; how: string }[] {
  const text = world.files.get(FILE)?.text ?? '{"items":[]}'
  return (JSON.parse(text) as { items: { title: string; status: string; choice: string; how: string }[] }).items
}

/** 엔진 자리에 서는 훅들: 시계·환경·git·파일·패널·도구 등록·프롬프트 보내기 */
function standIn(on: On, world: World) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME })
  on('command.register', () => ({ value: { command: 'decisions' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'decisions', title: '결정 사항', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    world.sent.push(e.text)
    return { text: e.text } as never
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '/w/docs/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', (_, e) => ({ value: world.files.has(e.path) || world.dirs.has(e.path) }))
  on('fs.read', (_, e) => {
    const file = world.files.get(e.path)
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: file.text }
  })
  on('fs.write', (_, e) => {
    world.tick += 1
    world.files.set(e.path, { text: e.text, mtimeMs: world.tick })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const file = world.files.get(e.path)
    return file === undefined
      ? { deny: `ENOENT ${e.path}` }
      : ({ value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } } as never)
  })
  on('tool.call', (_, e) => {
    // AskUserQuestion은 사용자가 첫 질문에 '추천안'을 고른 것처럼 답한다.
    if (e.tool === 'AskUserQuestion') {
      const first = e.questions[0]
      return { result: { questions: e.questions, answers: first === undefined ? {} : { [first.question]: '추천안' } } } as never
    }
    return { result: {} } as never
  })
  return clock
}

/** mod 도구를 부르고 결과 글을 돌려준다 */
async function callTool($: { tool: { call: (input: never) => Promise<unknown> } }, name: string, args: Record<string, unknown>) {
  const ran = (await $.tool.call({ tool: `mcp__decisions__${name}`, ...args } as never)) as {
    result?: { content?: { text?: string }[] }
  }
  return ran.result?.content?.[0]?.text ?? ''
}

const OPTIONS = [
  { label: '유지', description: '지금 규칙을 그대로 둔다', recommended: true },
  { label: '빼기', description: '규칙에서 뺀다' },
]

// Claude가 올린 결정할 것이 패널에 보이고, 선택지를 누르면 결정된 것으로 옮겨지며 Claude에게 결정이 전달돼야 한다.
test('올린 결정할 것을 패널에서 고르면 기록하고 Claude에게 보낸다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })
  const added = await callTool($ as never, 'add', { title: '500줄 권고', context: '공통 3절', source: 'TRM2-2098', options: OPTIONS })
  expect(added).toContain('결정할 것으로 올렸습니다')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^결정할 것/ }))?.text).toBe('결정할 것 1')
    expect(await ui.find({ type: 'Button', text: /1\) 유지 \(추천\)/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const option = await ui.find({ type: 'Button', text: /2\) 빼기/ })
  await ui.press({ key: option?.key ?? '' })
  expect(itemsOf(world)).toEqual([expect.objectContaining({ title: '500줄 권고', status: 'decided', choice: '빼기', how: 'panel' })])
  expect(world.sent[0]).toContain('[결정 사항] 500줄 권고')
  expect(world.sent[0]).toContain('선택: 빼기')
  expect(world.sent[0]).toContain('출처: TRM2-2098')
  await ui.unmount()

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /^결정할 것/ }))?.text).toBe('결정할 것 0')
  expect(await after.find({ type: 'Text', text: /✓ .* 500줄 권고 → 빼기/ })).toBeDefined()
  await after.unmount()
})

// 선택지에 없는 답은 직접 입력으로 정할 수 있어야 한다.
test('직접 입력으로 정한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })
  await callTool($ as never, 'add', { title: 'stash 처리', options: OPTIONS })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field?.key ?? '', text: '내용을 먼저 보여 줘' })
  expect(itemsOf(world)).toEqual([expect.objectContaining({ status: 'decided', choice: '내용을 먼저 보여 줘' })])
  expect(world.sent[0]).toContain('선택: 내용을 먼저 보여 줘')
  await ui.unmount()
})

// AskUserQuestion으로 받은 답도 결정된 것에 남아야 하고, 같은 제목의 결정할 것은 닫혀야 한다.
test('AskUserQuestion 답을 결정된 것으로 기록한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })
  await callTool($ as never, 'add', { title: '머지 방식을 어떻게 할까요?', options: OPTIONS })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: '머지 방식을 어떻게 할까요?', header: '머지', options: [{ label: '추천안', description: '' }], multiSelect: false }],
  } as never)

  expect(itemsOf(world)).toEqual([expect.objectContaining({ title: '머지 방식을 어떻게 할까요?', status: 'decided', choice: '추천안', how: 'question' })])
})

// 대화로 정한 것은 record로 남기고, 올린 항목에 대화로 답하면 resolve로 닫고, list로 남은 것을 본다.
test('record·resolve·list 도구', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })
  await callTool($ as never, 'record', { title: 'React 버전', choice: '19로 공통', source: 'TRM2-2098' })
  const added = await callTool($ as never, 'add', { title: '도메인 이름', options: OPTIONS })
  const id = /id=(\S+)/.exec(added)?.[1] ?? ''

  expect(await callTool($ as never, 'list', { status: 'pending' })).toContain('결정할 것 1개')
  expect(await callTool($ as never, 'resolve', { id, choice: '그대로' })).toContain('닫았습니다')
  expect(await callTool($ as never, 'list', {})).toContain('결정할 것 0개')
  expect(itemsOf(world).map(one => `${one.title}:${one.status}:${one.how}`)).toEqual(['React 버전:decided:chat', '도메인 이름:decided:chat'])
})

// 다른 세션(다른 설정 폴더)이 기록 파일을 바꾸면 10초 안에 이 세션 패널에도 보여야 한다.
test('다른 세션이 바꾼 기록 파일을 다시 읽는다', async ($, on) => {
  const world = newWorld()
  const clock = standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })

  world.files.set(FILE, {
    text: JSON.stringify({ items: [{ id: 'd-x', title: '다른 세션의 질문', status: 'pending', options: [{ label: '예' }] }] }),
    mtimeMs: 99,
  })
  await clock.advance(10_000)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^결정할 것/ }))?.text).toBe('결정할 것 1')
  expect(await ui.find({ type: 'Text', text: '▸ 다른 세션의 질문' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^기록 / }))?.text).toBe('기록 ~/.claude/decisions/w.json')
  await ui.unmount()
})

// 사람이 기록 파일을 잘못 고쳐 JSON이 깨져도 패널이 죽지 않고 빈 목록으로 그려져야 한다.
test('깨진 기록 파일은 빈 목록으로 읽는다', async ($, on) => {
  const world = newWorld()
  world.files.set(FILE, { text: '{ 깨진', mtimeMs: 1 })
  standIn(on, world)
  await $.session.start({ cwd: '/w/docs', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^결정할 것/ }))?.text).toBe('결정할 것 0')
  await ui.unmount()
})
