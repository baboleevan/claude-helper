import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 가짜 워크스페이스: /w/docs(메인 checkout, develop)와 /w/.worktrees/T1/docs(워크트리, feature/T1-작업).
// 세션 폴더는 메인 checkout이고 실제 수정은 워크트리에서 한다. 이 mod가 막으려는 상황이 바로 이것이다.
const MAIN = '/w/docs'
const TREE = '/w/.worktrees/T1/docs'
const DIRS = new Set(['/', '/w', MAIN, `${MAIN}/std`, '/w/.worktrees', '/w/.worktrees/T1', TREE, `${TREE}/std`])

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

/** 테스트 하나가 쓰는 가짜 git 상태: 작업 트리별 브랜치와 git status 줄 */
type World = { branch: Map<string, string>; status: Map<string, string[]> }

/** 처음 상태의 가짜 git을 만든다 */
function newWorld(): World {
  return {
    branch: new Map([
      [MAIN, 'develop'],
      [TREE, 'feature/T1-작업'],
    ]),
    status: new Map([
      [MAIN, ['?? DB.md']],
      [TREE, []],
    ]),
  }
}

/** 실제 git 대신 rev-parse·branch·status에 답한다. 없는 폴더는 시작하지 못한 것으로 거부한다 */
function fakeGit(world: World, argv: readonly string[], cwd: string) {
  if (!DIRS.has(cwd)) return { deny: `no such directory: ${cwd}` }
  const root = cwd.startsWith(TREE) ? TREE : cwd.startsWith(MAIN) ? MAIN : null
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  if (root === null) {
    return {
      value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }
  }
  const args = argv.slice(2).join(' ')
  const branch = world.branch.get(root) ?? 'develop'
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

/** 엔진 자리에 서는 훅들: 시계·환경·명령 등록·패널·대화 기록·git·도구 결과 */
function standIn(on: On, world: World, history: unknown[] = []) {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/u' })
  on('command.register', () => ({ value: { command: 'changed-files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: history as never }))
  on('process.run', (_, e) => fakeGit(world, e.argv, e.init?.cwd ?? MAIN) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      if (e.file_path.includes('denied')) return { deny: '사용자가 거부함' }
      return {
        result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] },
      } as never
    }
    if (e.tool === 'Write') return { result: { type: 'create', structuredPatch: [] } } as never
    if (e.tool === 'Bash') {
      // 명령이 워크트리 파일을 고치고 새 파일을 만들고 브랜치를 바꾼 것처럼 git 상태를 바꾼다.
      world.status.set(TREE, [' M std/README.md', '?? std/added.md'])
      world.branch.set(TREE, 'feature/T1-다른')
      return { result: { stdout: '', stderr: '' } } as never
    }
    return { result: {} } as never
  })
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
    expect((await ui.find({ type: 'Text', text: '저장소 밖' }))?.text).toBe('저장소 밖')
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
