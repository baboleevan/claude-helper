// 결정 사항 패널: 사용자가 정해야 할 것(결정할 것)과 이미 정한 것(결정된 것)을 오른쪽 패널에 보여 주고, 패널에서 바로 고르게 한다.
//
// 기록은 워크스페이스마다 파일 하나(~/.claude/decisions/<워크스페이스 이름>.json)에 둔다. 이 PC의 모든 세션·설정 폴더가 같은 파일을 본다.
//   워크스페이스: 세션 폴더가 속한 git 저장소의 메인 checkout 상위 폴더에 .worktrees나 CLAUDE.md가 있으면 그 상위 폴더
//   (여러 저장소를 모아 둔 폴더), 아니면 그 저장소, git 밖이면 세션 폴더.
//   파일이 원본이다. 패널은 $.state에 둔 사본을 그리고, 다른 세션이 파일을 바꾸면 10초마다 수정 시각을 보고 다시 읽는다.
//
// 항목이 생기는 길
//   - Claude가 도구로 올린다: mcp__decisions__add(결정할 것), record(대화로 정한 것), resolve(대화로 답한 결정할 것을 닫음).
//   - AskUserQuestion으로 받은 답을 결정된 것으로 기록한다. 같은 제목의 결정할 것이 있으면 그것을 닫는다.
// 사용자가 패널에서 고르면(선택지 버튼 또는 직접 입력) 기록하고, "[결정 사항] 제목 / 선택: ..." 메시지를 Claude에게 보낸다.
// 세션이 비어 있으면 바로, 작업 중이면 그 작업이 끝난 뒤 새 턴으로 전달된다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, DecisionBook, DecisionOption } from '../types'

const PANE = 'decisions'
const TITLE = '결정 사항'
// 값의 모양을 바꾸면 태그를 올린다. 다른 태그로 저장된 값은 초기값으로 읽고, 세션 시작 때 파일에서 다시 채운다.
const book = atom({ plugin: 'decisions', key: 'book' } as const, null, { shape: 'book-1' })

// 다른 세션이 기록 파일을 바꿨는지 보는 주기
const RELOAD_MS = 10_000
// 패널에 보일 결정된 것의 최대 개수(나머지는 파일에 있다)
const MAX_DECIDED_SHOWN = 30
// 입력창 위에 놓일 때 보일 결정할 것의 최대 개수
const INLINE_PENDING = 2

const TOOL = {
  add: 'mcp__decisions__add',
  record: 'mcp__decisions__record',
  resolve: 'mcp__decisions__resolve',
  list: 'mcp__decisions__list',
} as const

// 시스템 프롬프트에 더하는 안내. 언제 패널에 올리고 언제 AskUserQuestion을 쓰는지 Claude가 알게 한다.
const GUIDE = [
  '# 결정 사항 패널',
  "사용자 화면 오른쪽에 '결정 사항' 패널이 있다. 사용자가 정해야 할 것과 이미 정한 것을 모아 보여 주고, 사용자는 패널에서 바로 고른다.",
  '- 사용자가 정해야 할 일(정책·범위·여러 선택지 중 고르기·지울지 말지 등)이 생겼는데 그 답 없이도 다른 일을 계속할 수 있으면 mcp__decisions__add로 올리고 계속 진행한다. 선택지에는 추천을 표시한다.',
  '- 지금 답이 있어야 다음 단계를 할 수 있으면 AskUserQuestion을 쓴다. 그 답은 자동으로 결정된 것에 기록된다.',
  '- 대화에서 사용자가 정한 것은 mcp__decisions__record로 남긴다. 패널에 올린 항목에 사용자가 대화로 답하면 mcp__decisions__resolve로 닫는다.',
  '- 사용자가 패널에서 고르면 "[결정 사항] 제목" 메시지가 온다. 그 결정대로 이어서 진행한다.',
  '- 남은 결정할 것은 mcp__decisions__list로 본다.',
].join('\n')

/** 경로의 상위 폴더 */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** 경로의 마지막 이름 */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 파일 이름에 쓸 수 없는 글자를 -로 바꾼다 */
function safeName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'workspace' : cleaned
}

/** 홈 폴더 아래 경로를 ~로 줄인다 */
function tilde(path: string, home: string): string {
  return home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** 값이 글이면 그대로, 아니면 빈 문자열 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** ISO 시각을 MM-DD로 줄인다 */
function monthDay(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10) : ''
}

/**
 * 세션 폴더의 워크스페이스를 찾는다. 메인 checkout의 상위 폴더에 .worktrees나 CLAUDE.md가 있으면(여러 저장소를 모은 폴더)
 * 그 폴더, 아니면 저장소 폴더, git 밖이면 세션 폴더다.
 */
async function workspaceOf($: EngineInterface, cwd: string): Promise<string> {
  try {
    const ran = await $.process.run(['git', '--no-optional-locks', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      timeoutMs: 5000,
    })
    const common = ran.stdout.trim()
    if (ran.exitCode !== 0 || common === '') return cwd
    const repo = common.endsWith('/.git') ? dirname(common) : common
    const parent = dirname(repo)
    const isWorkspace =
      (await $.fs.exists(`${parent}/.worktrees`).catch(() => false)) || (await $.fs.exists(`${parent}/CLAUDE.md`).catch(() => false))
    return isWorkspace ? parent : repo
  } catch {
    return cwd
  }
}

/** 선택지 하나를 읽는다. 이름이 없으면 버린다 */
function normalizeOption(raw: unknown): DecisionOption | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const label = str(r.label).trim()
  if (label === '') return null
  return { label, description: str(r.description).trim(), isRecommended: r.isRecommended === true || r.recommended === true }
}

/** 결정 사항 하나를 읽는다. id나 제목이 없으면 버린다(사람이 파일을 고쳐 모양이 틀어진 경우) */
function normalizeItem(raw: unknown): Decision | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const title = str(r.title).trim()
  if (id === '' || title === '') return null
  const options = Array.isArray(r.options) ? r.options.flatMap(one => normalizeOption(one) ?? []) : []
  const how = r.how === 'panel' || r.how === 'chat' || r.how === 'question' ? r.how : ''
  return {
    id,
    title,
    context: str(r.context),
    source: str(r.source),
    options,
    status: r.status === 'decided' ? 'decided' : 'pending',
    choice: str(r.choice),
    how,
    createdAt: str(r.createdAt),
    decidedAt: str(r.decidedAt),
  }
}

/** 기록 파일 내용을 결정 목록으로 읽는다. JSON이 깨졌으면 빈 목록이다 */
function parseItems(text: string): Decision[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : []
  return list.flatMap(one => normalizeItem(one) ?? [])
}

/** 기록 파일을 읽는다. 없으면 빈 목록이다. 다른 세션이 바꿨는지 보려고 수정 시각도 돌려준다 */
async function readFile($: EngineInterface, file: string): Promise<{ items: Decision[]; mtimeMs: number }> {
  if (!(await $.fs.exists(file).catch(() => false))) return { items: [], mtimeMs: 0 }
  const text = await $.fs.read(file)
  const mtimeMs = await $.fs
    .stat(file)
    .then(stat => stat.mtimeMs)
    .catch(() => 0)
  return { items: parseItems(typeof text === 'string' ? text : ''), mtimeMs }
}

/** 세션 폴더로 기록 파일을 정하고 읽어 패널 사본에 둔다 */
async function openBook($: EngineInterface, cwd: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const workspace = await workspaceOf($, cwd)
  const file = `${home === '' ? cwd : `${home}/.claude`}/decisions/${safeName(basename(workspace))}.json`
  const loaded = await readFile($, file)
  await update($, book, () => ({ file, label: tilde(file, home), items: loaded.items, mtimeMs: loaded.mtimeMs }))
}

/** 다른 세션이 기록 파일을 바꿨으면 다시 읽어 패널을 맞춘다 */
async function syncFromFile($: EngineInterface): Promise<void> {
  const current = await read($, book)
  if (current === null) return
  const mtimeMs = await $.fs
    .stat(current.file)
    .then(stat => stat.mtimeMs)
    .catch(() => 0)
  if (mtimeMs === current.mtimeMs) return
  const loaded = await readFile($, current.file)
  await update($, book, () => ({ ...current, items: loaded.items, mtimeMs: loaded.mtimeMs }))
  await retitle($, loaded.items)
}

/** 패널 탭 이름에 결정할 것 개수를 붙인다. 패널이 열려 있을 때만 바꾼다(닫은 패널을 다시 열지 않는다) */
async function retitle($: EngineInterface, items: readonly Decision[]): Promise<void> {
  const isOpen = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)
  if (!isOpen) return
  const pending = items.filter(item => item.status === 'pending').length
  await $.ui.open({ id: PANE, title: pending > 0 ? `${TITLE} ${pending}` : TITLE }).catch(() => undefined)
}

/**
 * 기록 파일의 최신 내용에 변경을 적용해 쓰고 패널 사본도 맞춘다.
 * 다른 세션이 그사이 쓴 내용을 덮지 않게 쓰기 직전에 파일을 다시 읽는다.
 */
async function mutate($: EngineInterface, change: (items: Decision[]) => Decision[]): Promise<Decision[]> {
  const current = await read($, book)
  if (current === null) throw new Error('결정 기록 파일을 아직 정하지 못했습니다')
  const latest = await readFile($, current.file)
  const items = change(latest.items)
  await $.fs.write(current.file, `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
  const mtimeMs = await $.fs
    .stat(current.file)
    .then(stat => stat.mtimeMs)
    .catch(() => 0)
  await update($, book, () => ({ ...current, items, mtimeMs }))
  await retitle($, items)
  return items
}

/** 새 결정 사항 id. 시각과 무작위 글자로 만든다 */
function newId(ms: number): string {
  return `d-${ms.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 결정할 것을 올린다. 같은 제목의 결정할 것이 이미 있으면 새로 만들지 않고 그것을 돌려준다 */
async function addPending(
  $: EngineInterface,
  input: { title: string; context: string; source: string; options: DecisionOption[] },
): Promise<{ item: Decision; isNew: boolean }> {
  const ms = await $.clock.now()
  const fresh: Decision = {
    id: newId(ms),
    title: input.title,
    context: input.context,
    source: input.source,
    options: input.options,
    status: 'pending',
    choice: '',
    how: '',
    createdAt: new Date(ms).toISOString(),
    decidedAt: '',
  }
  let found: Decision | undefined
  await mutate($, items => {
    found = items.find(one => one.status === 'pending' && one.title === input.title)
    return found === undefined ? [...items, fresh] : items
  })
  return found === undefined ? { item: fresh, isNew: true } : { item: found, isNew: false }
}

/**
 * 정한 것들을 기록한다. 같은 제목의 결정할 것이 있으면 그것을 닫고, 없으면 결정된 것으로 새로 넣는다.
 * AskUserQuestion 답과 대화로 정한 것(record)이 이 길로 들어온다.
 */
async function addDecided(
  $: EngineInterface,
  entries: readonly { title: string; choice: string; context: string; source: string; how: Decision['how'] }[],
): Promise<void> {
  if (entries.length === 0) return
  const ms = await $.clock.now()
  const at = new Date(ms).toISOString()
  await mutate($, items => {
    let next = items
    entries.forEach((entry, i) => {
      const pending = next.find(one => one.status === 'pending' && one.title === entry.title)
      if (pending !== undefined) {
        next = next.map(one => (one.id === pending.id ? { ...one, status: 'decided', choice: entry.choice, how: entry.how, decidedAt: at } : one))
        return
      }
      next = [
        ...next,
        {
          id: newId(ms + i),
          title: entry.title,
          context: entry.context,
          source: entry.source,
          options: [],
          status: 'decided',
          choice: entry.choice,
          how: entry.how,
          createdAt: at,
          decidedAt: at,
        },
      ]
    })
    return next
  })
}

/** 결정할 것 하나를 닫는다. 없거나 이미 정했으면 null */
async function decide($: EngineInterface, id: string, choice: string, how: Decision['how']): Promise<Decision | null> {
  const at = new Date(await $.clock.now()).toISOString()
  let decided: Decision | null = null
  await mutate($, items =>
    items.map(one => {
      if (one.id !== id || one.status !== 'pending') return one
      decided = { ...one, status: 'decided', choice, how, decidedAt: at }
      return decided
    }),
  )
  return decided
}

/** 패널에서 정한 결정을 Claude에게 보낼 메시지 */
function messageOf(item: Decision): string {
  return [
    `[결정 사항] ${item.title}`,
    `선택: ${item.choice}`,
    ...(item.source === '' ? [] : [`출처: ${item.source}`]),
    '결정 사항 패널에서 사용자가 골랐습니다. 이 결정대로 이어서 진행하세요.',
  ].join('\n')
}

/** 패널에서 고른(또는 입력한) 결정을 기록하고 Claude에게 보낸다 */
async function choose($: EngineInterface, id: string, choice: string): Promise<void> {
  const text = choice.trim()
  if (text === '') {
    $.ui.toast('결정 내용을 입력해 주세요')
    return
  }
  const item = await decide($, id, text, 'panel')
  if (item === null) {
    $.ui.toast('이미 정한 결정입니다')
    return
  }
  $.ui.toast(`결정했습니다: ${item.title} → ${text}`)
  await $.prompt.submit({ text: messageOf(item) })
}

/** mod 도구가 Claude에게 돌려주는 글 결과 */
function textResult(text: string, isError = false) {
  return { result: { content: [{ type: 'text' as const, text }], isError } }
}

/** 도구 인자를 글자 키로 읽는다(도구 이름 옆에 펼쳐져 온다) */
function argsOf(e: unknown): Record<string, unknown> {
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
}

/** 목록 도구의 결과 글: 결정할 것(id·선택지)과 최근 결정된 것 */
function listText(items: readonly Decision[], status: string): string {
  const pending = items.filter(one => one.status === 'pending')
  const decided = items.filter(one => one.status === 'decided').sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
  const lines: string[] = []
  if (status !== 'decided') {
    lines.push(`결정할 것 ${pending.length}개`)
    for (const one of pending) {
      const options = one.options.map(option => `${option.label}${option.isRecommended ? '(추천)' : ''}`).join(' / ')
      lines.push(`- id=${one.id} ${one.title}${one.source === '' ? '' : ` [${one.source}]`}${options === '' ? '' : ` 선택지: ${options}`}`)
    }
  }
  if (status !== 'pending') {
    lines.push(`결정된 것 ${decided.length}개`)
    for (const one of decided.slice(0, 50)) lines.push(`- ${monthDay(one.decidedAt)} ${one.title} → ${one.choice}`)
  }
  return lines.join('\n')
}

/** Claude가 부를 도구 네 개를 등록한다. 스키마를 처음부터 프롬프트에 둬(isDeferred: false) 바로 쓰게 한다 */
async function registerTools($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'add',
    description:
      '사용자가 정해야 할 결정을 결정 사항 패널에 올립니다. 정책·범위·여러 선택지 중 고르기처럼 사용자가 정할 일이 생겼고 그 답 없이도 다른 일을 계속할 수 있을 때 씁니다. 사용자가 패널에서 고르면 "[결정 사항] 제목" 메시지가 옵니다. 같은 제목의 결정할 것이 있으면 새로 만들지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '무엇을 정하는지 한 줄(한국어)' },
        context: { type: 'string', description: '배경과 영향 1~3문장' },
        source: { type: 'string', description: '출처: Jira 키, PR 주소, 저장소 등' },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '버튼에 보일 짧은 이름' },
              description: { type: 'string', description: '고르면 무엇이 되는지 한 줄' },
              recommended: { type: 'boolean', description: '추천하는 선택지면 true' },
            },
            required: ['label'],
          },
        },
      },
      required: ['title', 'options'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'record',
    description: '대화에서 사용자가 정한 결정을 결정 사항 패널의 결정된 것에 남깁니다. 같은 제목의 결정할 것이 있으면 그것을 닫습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '무엇을 정했는지 한 줄' },
        choice: { type: 'string', description: '정한 내용' },
        context: { type: 'string', description: '배경 1~2문장' },
        source: { type: 'string', description: '출처: Jira 키, PR 주소 등' },
      },
      required: ['title', 'choice'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'resolve',
    description: '패널에 올린 결정할 것에 사용자가 대화로 답했을 때 그 항목을 닫습니다. id는 mcp__decisions__list나 add 결과에 있습니다.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, choice: { type: 'string', description: '정한 내용' } },
      required: ['id', 'choice'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'list',
    description: '결정할 것(id·선택지)과 최근 결정된 것을 봅니다.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'decided', 'all'], description: '기본 all' } },
    },
    isDeferred: false,
  })
}

export const register: Register = on => {
  // 세션 시작·다시 불러오기마다: 명령·도구 등록, 기록 파일 읽기, 패널 열기, 다른 세션의 변경 확인.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'decisions', description: '결정 사항 패널(결정할 것·결정된 것)을 엽니다' })
      await registerTools($)
      await openBook($, e.cwd)
    } catch (error) {
      $.ui.log(`decisions: 시작 준비 중 오류: ${String(error)}`)
    }
    const items = (await read($, book))?.items ?? []
    const pending = items.filter(one => one.status === 'pending').length
    void $.ui.open({ id: PANE, title: pending > 0 ? `${TITLE} ${pending}` : TITLE })
    $.clock.every(RELOAD_MS, () => {
      void syncFromFile($).catch(() => undefined)
    })
    return started
  })

  // 시스템 프롬프트에 패널 안내를 더한다(세션 범위).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'decisions-panel', text: GUIDE, scope: 'session' as const }] }
  })

  // /decisions: 닫았거나 화면이 좁아 자리를 못 잡은 패널을 연다.
  on('command.run', { command: 'decisions' }, async $ => {
    const items = (await read($, book))?.items ?? []
    const pending = items.filter(one => one.status === 'pending').length
    const opened = await $.ui.open({ id: PANE, title: pending > 0 ? `${TITLE} ${pending}` : TITLE })
    return { text: opened.isPlaced ? '결정 사항 패널을 열었습니다.' : `패널이 아직 자리를 잡지 못했습니다: ${opened.reason}` }
  })

  // 결정할 것을 올린다.
  on('tool.call', { tool: TOOL.add }, async ($, e) => {
    const args = argsOf(e)
    const title = str(args.title).trim()
    const options = Array.isArray(args.options) ? args.options.flatMap(one => normalizeOption(one) ?? []) : []
    if (title === '' || options.length === 0) return textResult('title과 선택지(options, label 필수)가 하나 이상 있어야 합니다.', true)
    const { item, isNew } = await addPending($, { title, context: str(args.context).trim(), source: str(args.source).trim(), options })
    if (isNew) $.ui.toast(`결정할 것이 생겼습니다: ${title}`)
    return textResult(isNew ? `결정할 것으로 올렸습니다. id=${item.id}` : `같은 제목의 결정할 것이 이미 있습니다. id=${item.id}`)
  })

  // 대화로 정한 것을 기록한다.
  on('tool.call', { tool: TOOL.record }, async ($, e) => {
    const args = argsOf(e)
    const title = str(args.title).trim()
    const choice = str(args.choice).trim()
    if (title === '' || choice === '') return textResult('title과 choice가 있어야 합니다.', true)
    await addDecided($, [{ title, choice, context: str(args.context).trim(), source: str(args.source).trim(), how: 'chat' }])
    return textResult('결정된 것에 기록했습니다.')
  })

  // 대화로 답한 결정할 것을 닫는다.
  on('tool.call', { tool: TOOL.resolve }, async ($, e) => {
    const args = argsOf(e)
    const choice = str(args.choice).trim()
    if (choice === '') return textResult('choice가 있어야 합니다.', true)
    const item = await decide($, str(args.id), choice, 'chat')
    return item === null ? textResult('그 id의 결정할 것이 없거나 이미 정했습니다.', true) : textResult(`닫았습니다: ${item.title} → ${choice}`)
  })

  // 결정 사항을 본다.
  on('tool.call', { tool: TOOL.list }, async ($, e) => {
    const status = str(argsOf(e).status) || 'all'
    const current = await read($, book)
    return textResult(listText(current?.items ?? [], status))
  })

  // AskUserQuestion 답을 결정된 것으로 기록한다. 기록이 실패해도 도구 결과는 그대로 돌려준다.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny === undefined && ran.isError !== true) {
        const answers = (typeof ran.result === 'object' && ran.result !== null ? (ran.result as { answers?: unknown }).answers : undefined) ?? {}
        const entries = e.questions.flatMap(question => {
          const answer = str((answers as Record<string, unknown>)[question.question]).trim()
          return answer === '' ? [] : [{ title: question.question, choice: answer, context: '', source: question.header, how: 'question' as const }]
        })
        await addDecided($, entries)
      }
    } catch {
      // 기록 실패는 질문 결과에 영향을 주지 않는다.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // 패널 그리기: 결정할 것(선택지 버튼·직접 입력)과 결정된 것(최근 순).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const current = await read($, book)
    const items = current?.items ?? []
    const pending = items.filter(one => one.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const decided = items.filter(one => one.status === 'decided').sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>결정할 것 {pending.length}</Text>
          <Text dimColor>결정된 것 {decided.length}</Text>
        </Box>
      )
    }

    const isInline = e.props.placement === 'inline'
    const shownPending = isInline ? pending.slice(0, INLINE_PENDING) : pending

    // 결정할 것 하나: 제목·출처·배경, 선택지 버튼(번호·추천 표시, 설명은 아래 줄), 직접 입력.
    const pendingBlock = (item: Decision) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>▸ {item.title}</Text>
        {item.source !== '' && <Text dimColor>출처 {item.source}</Text>}
        {item.context !== '' && <Text dimColor>{item.context}</Text>}
        {item.options.map((option, index) => (
          <Box flexDirection="column">
            <Button key={`option:${item.id}:${index}`} plain onPress={() => choose($, item.id, option.label)}>
              <Text color="suggestion">{`${index + 1}) ${option.label}${option.isRecommended ? ' (추천)' : ''}`}</Text>
            </Button>
            {option.description !== '' && <Text dimColor>{`   ${option.description}`}</Text>}
          </Box>
        ))}
        <Input
          key={`input:${item.id}`}
          placeholder="직접 입력 후 Enter"
          onSubmit={value => {
            void choose($, item.id, value)
          }}
        />
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold color="warning">
          결정할 것 {pending.length}
        </Text>
        {pending.length === 0 && <Text dimColor>지금 정할 것이 없습니다.</Text>}
        {shownPending.map(pendingBlock)}
        {isInline && pending.length > shownPending.length && (
          <Text dimColor>외 {pending.length - shownPending.length}개 (fullscreen 화면에서 모두 보입니다)</Text>
        )}
        <Box marginTop={1}>
          <Text bold color="success">
            결정된 것 {decided.length}
          </Text>
        </Box>
        {!isInline &&
          decided.slice(0, MAX_DECIDED_SHOWN).map(item => (
            <Text dimColor>{`✓ ${monthDay(item.decidedAt)} ${item.title} → ${item.choice}`}</Text>
          ))}
        {!isInline && decided.length > MAX_DECIDED_SHOWN && (
          <Text dimColor>외 {decided.length - MAX_DECIDED_SHOWN}개는 기록 파일에 있습니다.</Text>
        )}
        <Box marginTop={1}>
          <Text dimColor>기록 {current?.label ?? '(아직 정하지 못함)'}</Text>
        </Box>
      </Box>
    )
  })
}
