import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 가짜 워크스페이스: /w/docs(메인 checkout, develop)와 /w/.worktrees/T1/docs(워크트리, feature/T1-작업).
// 세션 폴더는 메인 checkout이고 실제 수정은 워크트리에서 한다. 이 mod가 막으려는 상황이 바로 이것이다.
const MAIN = '/w/docs'
const TREE = '/w/.worktrees/T1/docs'

const PANE = {
  plugin: 'changed-files',
  component: 'Pane',
  requestId: 'changed-files',
  props: {
    title: '수정한 파일',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** 테스트 하나가 쓰는 가짜 git 상태: 있는 폴더, 작업 트리별 브랜치·git status 줄·세션 시작 뒤 커밋된 파일 */
type World = { dirs: Set<string>; branch: Map<string, string>; status: Map<string, string[]>; log: Map<string, string[]> }

/** 처음 상태의 가짜 git을 만든다 */
function newWorld(): World {
  return {
    dirs: new Set(['/', '/w', MAIN, `${MAIN}/std`, '/w/.worktrees', '/w/.worktrees/T1', TREE, `${TREE}/std`]),
    branch: new Map([
      [MAIN, 'develop'],
      [TREE, 'feature/T1-작업'],
    ]),
    status: new Map([
      [MAIN, ['?? DB.md']],
      [TREE, []],
    ]),
    log: new Map([
      [MAIN, []],
      [TREE, []],
    ]),
  }
}

/** 파일 경로가 속한 가짜 작업 트리와 그 안의 상대 경로. 저장소 밖이면 null */
function splitPath(path: string): { root: string; rel: string } | null {
  const root = path.startsWith(`${TREE}/`) ? TREE : path.startsWith(`${MAIN}/`) ? MAIN : null
  return root === null ? null : { root, rel: path.slice(root.length + 1) }
}

/** 고친 파일을 git status에 올린다(이미 있으면 그대로). 새 파일이면 ??, 아니면 수정이다 */
function markDirty(world: World, path: string, isNew: boolean) {
  const at = splitPath(path)
  if (at === null) return
  const lines = world.status.get(at.root) ?? []
  if (!lines.some(line => line.slice(3) === at.rel)) lines.push(`${isNew ? '??' : ' M'} ${at.rel}`)
  world.status.set(at.root, lines)
}

/** 실제 git 대신 rev-parse·branch·status·log에 답한다. 없는 폴더는 시작하지 못한 것으로 거부한다 */
function fakeGit(world: World, argv: readonly string[], cwd: string) {
  if (!world.dirs.has(cwd)) return { deny: `no such directory: ${cwd}` }
  const root = cwd.startsWith(TREE) ? TREE : cwd.startsWith(MAIN) ? MAIN : null
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  if (root === null) {
    return {
      value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }
  }
  // mod는 git -c core.quotePath=false --no-optional-locks <명령>으로 부른다. 앞의 옵션을 떼고 명령만 본다.
  const args = argv.slice(argv.indexOf('--no-optional-locks') + 1).join(' ')
  const branch = world.branch.get(root) ?? 'develop'
  if (args.startsWith('log --since=')) return ok((world.log.get(root) ?? []).map(rel => `${rel}\n`).join(''))
  if (args.startsWith('rev-parse --path-format=absolute')) {
    const gitDir = root === TREE ? `${MAIN}/.git/worktrees/docs` : `${MAIN}/.git`
    const rest = cwd === root ? '' : `${cwd.slice(root.length + 1)}/`
    return ok(`${root}\n${gitDir}\n${MAIN}/.git\n${rest}\n`)
  }
  if (args === 'branch --show-current') return ok(`${branch}\n`)
  if (args === 'rev-parse --short HEAD') return ok('abc1234\n')
  if (args.startsWith('status')) {
    const lines = [`## ${branch}...origin/${branch}`, ...(world.status.get(root) ?? [])]
    return ok(`${lines.join('\0')}\0`)
  }
  return ok('')
}

/** 엔진 자리에 서는 훅들: 시계·환경·명령 등록·패널·대화 기록·git·도구 결과. 시계를 돌려야 하는 테스트를 위해 시계를 돌려준다 */
function standIn(on: On, world: World, history: unknown[] = []) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/u' })
  on('command.register', () => ({ value: { command: 'changed-files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: history as never }))
  on('session.usage', () => ({ value: { startedAt: 1_699_999_000_000, context: {}, rateLimits: [] } as never }))
  on('process.run', (_, e) => fakeGit(world, e.argv, e.init?.cwd ?? MAIN) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      if (e.file_path.includes('denied')) return { deny: '사용자가 거부함' }
      markDirty(world, e.file_path, false)
      return {
        result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] },
      } as never
    }
    if (e.tool === 'Write') {
      markDirty(world, e.file_path, true)
      return { result: { type: 'create', structuredPatch: [] } } as never
    }
    if (e.tool === 'NotebookEdit') {
      markDirty(world, e.notebook_path, false)
      return { result: {} } as never
    }
    if (e.tool === 'Bash' && e.command.includes('git commit')) {
      // 워크트리의 바뀐 파일을 모두 커밋한 것처럼, status에서 빼고 세션 시작 뒤 커밋 기록에 넣는다.
      const lines = world.status.get(TREE) ?? []
      world.log.set(TREE, [...(world.log.get(TREE) ?? []), ...lines.map(line => line.slice(3))])
      world.status.set(TREE, [])
      return { result: { stdout: '', stderr: '' } } as never
    }
    if (e.tool === 'Bash') {
      // 명령이 워크트리 파일을 고치고 새 파일을 만들고 브랜치를 바꾼 것처럼 git 상태를 바꾼다.
      world.status.set(TREE, [' M std/README.md', '?? std/added.md'])
      world.branch.set(TREE, 'feature/T1-다른')
      return { result: { stdout: '', stderr: '' } } as never
    }
    return { result: {} } as never
  })
  return clock
}

/** 그린 패널에서 파일 행(Button)을 상대 경로로 찾아 그 행의 커밋 여부(키 앞부분)를 돌려준다. 없으면 undefined */
async function stateOfRow(ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }, rel: string) {
  const rows = await ui.findAll({ type: 'Button' })
  const row = rows.find(one => one.key !== undefined && one.key.endsWith(`\n${rel}`))
  return row?.key?.split(':')[0]
}

// 세션 폴더가 메인 checkout이어도, 워크트리 파일을 고치면 머리에 그 워크트리와 브랜치가 보여야 한다.
test('워크트리에서 고친 파일이 보이고 머리에 워크트리·브랜치가 보인다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/README.md`, old_string: 'a', new_string: 'b\nc' })
  await $.tool.call({ tool: 'Write', file_path: `${TREE}/std/new.md`, content: 'x\ny\n' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: '.worktrees/T1/docs' }))?.text).toBe('.worktrees/T1/docs')
    expect((await ui.find({ type: 'Text', text: 'feature/T1-작업' }))?.text).toBe('feature/T1-작업')
    expect((await ui.find({ type: 'Text', text: /수정한 파일 \d+개/ }))?.text).toBe('수정한 파일 2개')
    expect(await ui.find({ type: 'Button', text: /std\/README\.md/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /\+2 −1/ }))?.text).toBe(' +2 −1')
    expect((await ui.find({ type: 'Text', text: /\+2$/ }))?.text).toBe(' +2')
    await ui.unmount()
  }
})

// 거부된 편집은 파일을 바꾸지 않았으므로 목록에 넣지 않는다.
test('거부된 편집은 목록에 없다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/denied.md`, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /수정한 파일 \d+개/ }))?.text).toBe('수정한 파일 0개')
  expect(await ui.find({ type: 'Button', text: /denied/ })).toBeUndefined()
  // 아직 고친 파일이 없으면 머리는 세션 폴더의 메인 checkout을 보인다.
  expect((await ui.find({ type: 'Text', text: 'docs (메인)' }))?.text).toBe('docs (메인)')
  expect((await ui.find({ type: 'Text', text: 'develop' }))?.text).toBe('develop')
  await ui.unmount()
})

// 같은 파일을 여러 번 고치면 한 줄로 합치고 횟수를 보인다. 다시 불러와도(세션 시작이 다시 돌아도) 대화 기록을 두 번 세지 않는다.
test('같은 파일은 한 줄로 합치고 다시 불러와도 두 번 세지 않는다', async ($, on) => {
  const world = newWorld()
  const history = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'u1',
          tool: 'Edit',
          input: { file_path: `${TREE}/std/old.md` },
          result: { structuredPatch: [{ lines: ['+x'] }] },
          text: 'ok',
        },
      ],
    },
  ]
  standIn(on, world, history)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/README.md`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/README.md`, old_string: 'b', new_string: 'c' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /수정한 파일 \d+개/ }))?.text).toBe('수정한 파일 2개')
  expect((await ui.find({ type: 'Text', text: /×2/ }))?.text).toBe(' +4 −2 ×2')
  expect((await ui.find({ type: 'Text', text: /^ \+1$/ }))?.text).toBe(' +1')
  await ui.unmount()
})

// sed -i나 heredoc처럼 Bash로 바꾼 파일도 git 상태 비교로 잡고, 바뀐 브랜치를 머리에 보인다.
test('Bash로 바꾼 파일과 바뀐 브랜치가 보인다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `cd ${TREE} && sed -i '' s/a/b/ std/README.md > std/added.md` })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'feature/T1-다른' }))?.text).toBe('feature/T1-다른')
  expect(await ui.find({ type: 'Button', text: /std\/README\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /std\/added\.md/ })).toBeDefined()
  // 원래부터 바뀌어 있던 메인 checkout의 DB.md는 이 세션의 변경이 아니다.
  expect(await ui.find({ type: 'Button', text: /DB\.md/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /수정한 파일 \d+개/ }))?.text).toBe('수정한 파일 2개')
  await ui.unmount()
})

// 행을 누르면 워크스페이스 기준 경로를 복사한다(PC 절대 경로를 복사하지 않는다).
test('행을 누르면 워크스페이스 기준 경로를 복사한다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  let copied = ''
  on('ui.copy', (_, e) => {
    copied = e.text
    return { value: { isCopied: true } }
  })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/README.md`, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /std\/README\.md/ })
  await ui.press({ key: row?.key ?? '' })
  expect(copied).toBe('.worktrees/T1/docs/std/README.md')
  await ui.unmount()
})

// 한 파일을 30번 넘게 고친 기록이 있어도, 다시 불러올 때 오래된 호출을 다시 세어 횟수가 부풀면 안 된다.
test('많이 고친 파일도 다시 불러올 때 두 번 세지 않는다', async ($, on) => {
  const world = newWorld()
  const history = [
    {
      role: 'assistant',
      text: '',
      toolUses: Array.from({ length: 35 }, (_, i) => ({
        tool_use_id: `h${i}`,
        tool: 'Edit',
        input: { file_path: `${TREE}/std/busy.md` },
        result: { structuredPatch: [{ lines: ['+x'] }] },
        text: 'ok',
      })),
    },
  ]
  standIn(on, world, history)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /×\d+/ }))?.text).toBe(' +35 ×35')
  await ui.unmount()
})

// 메모리·임시 파일처럼 git 저장소 밖 파일은 '저장소 밖' 묶음에 ~로 줄인 경로로 보인다.
test('저장소 밖 파일은 따로 묶어 ~ 경로로 보인다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/home/u/notes/a.md', content: 'x\n' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^저장소 밖/ }))?.text).toBe('저장소 밖 1')
    expect(await ui.find({ type: 'Button', text: /~\/notes\/a\.md/ })).toBeDefined()
    await ui.unmount()
  }
})

// 줄 수를 세지 않는 NotebookEdit 행도 그려져야 한다(숫자 꼬리가 없는 Button).
test('숫자 꼬리가 없는 행도 그린다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${TREE}/std/n.ipynb`, new_source: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /std\/n\.ipynb/ })).toBeDefined()
  await ui.unmount()
})

// fullscreen이 아니라 입력창 위에 놓이면 대화를 가리지 않게 최근 6개만 보이고 나머지 수를 알린다.
test('입력창 위에 놓이면 최근 6개만 보인다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 8; i += 1) {
    await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/f${i}.md`, old_string: 'a', new_string: 'b' })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  expect((await ui.findAll({ type: 'Button', text: /std\/f\d\.md/ })).length).toBe(6)
  expect((await ui.find({ type: 'Text', text: /^외 \d+개/ }))?.text).toBe('외 2개 (fullscreen 화면에서 모두 보입니다)')
  await ui.unmount()
})

// 커밋할 것이 남았는지 한눈에 보이도록, 세션에서 고친 파일을 커밋한 것과 아직 커밋하지 않은 것으로 나눠 보여야 한다.
test('커밋한 파일과 커밋하지 않은 파일을 나눠 보인다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/a.md`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: `cd ${TREE} && git commit -am 'a 고침'` })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/b.md`, old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await stateOfRow(ui, 'std/a.md')).toBe('committed')
    expect(await stateOfRow(ui, 'std/b.md')).toBe('uncommitted')
    expect((await ui.find({ type: 'Text', text: /^미커밋/ }))?.text).toBe('미커밋 1')
    expect((await ui.find({ type: 'Text', text: /^커밋됨/ }))?.text).toBe('커밋됨 1')
    await ui.unmount()
  }
})

// 사람이 세션 밖 터미널에서 커밋하거나 되돌려도, 30초마다 git 상태를 다시 읽어 맞춰야 한다.
test('세션 밖에서 커밋·되돌린 것을 주기적으로 다시 읽는다', async ($, on) => {
  const world = newWorld()
  const clock = standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/a.md`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/b.md`, old_string: 'a', new_string: 'b' })

  // 터미널에서 a.md는 커밋하고 b.md는 되돌렸다(status에서 빠지고 커밋 기록에도 없다).
  world.status.set(TREE, [])
  world.log.set(TREE, ['std/a.md'])
  await clock.advance(30_000)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await stateOfRow(ui, 'std/a.md')).toBe('committed')
  expect(await stateOfRow(ui, 'std/b.md')).toBe('unchanged')
  expect(await ui.find({ type: 'Text', text: /^미커밋/ })).toBeUndefined()
  await ui.unmount()
})

// 머지 뒤 워크트리를 지우면 그 안 파일은 커밋된 것이다. 머리는 지운 워크트리 대신 세션 폴더를 보여야 한다.
test('지운 워크트리의 파일은 커밋됨으로 보이고 머리는 세션 폴더로 돌아간다', async ($, on) => {
  const world = newWorld()
  standIn(on, world)
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${TREE}/std/a.md`, old_string: 'a', new_string: 'b' })

  world.dirs.delete(TREE)
  world.dirs.delete(`${TREE}/std`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })

  expect(await stateOfRow(ui, 'std/a.md')).toBe('committed')
  expect((await ui.find({ type: 'Text', text: '작업 트리 삭제됨' }))?.text).toBe('작업 트리 삭제됨')
  expect((await ui.find({ type: 'Text', text: 'docs (메인)' }))?.text).toBe('docs (메인)')
  await ui.unmount()
})
