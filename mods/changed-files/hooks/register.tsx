// 이 세션에서 수정한 파일을 오른쪽 패널(fullscreen 화면에서는 대화 옆, 아니면 입력창 위)에 실시간으로 보여 준다.
// 맨 위에는 지금 작업 중인 워크트리와 브랜치를 보인다. 세션 폴더가 아니라 마지막으로 바꾼 파일이 속한 작업 트리를 기준으로 한다.
// 세션 폴더는 메인 checkout(develop)이고 실제 작업은 .worktrees/<작업명>에서 하는 경우가 많기 때문이다.
//
// 수정을 알아내는 길은 세 가지다.
//   1. Edit·Write·NotebookEdit 도구 호출: 성공한 호출만 센다. 더한 줄·지운 줄은 도구 결과의 diff로 센다.
//   2. Bash 호출: 명령 앞뒤로 아는 작업 트리의 `git status`를 비교해 새로 바뀐 파일을 넣는다.
//      sed -i, heredoc, rm, git mv처럼 도구를 거치지 않는 수정을 잡기 위해서다. 이미 바뀐 상태였던 파일을 다시 바꾸면 잡지 못한다.
//      사진을 찍는 작업 트리는 파일을 바꾼 적 있는 곳, 세션 폴더, 이번·최근 명령에 경로가 나온 곳이다. mod를 불러온 뒤부터만 잡는다.
//   3. mod를 불러올 때(세션 시작·다시 불러오기): 대화 기록에 남은 Edit·Write·NotebookEdit 호출로 목록을 채운다.
//      대화를 압축했으면 압축 전 기록은 남아 있지 않을 수 있다.
// git은 --no-optional-locks로 불러 index.lock을 잡지 않는다. 동시에 도는 사용자의 git 명령을 막지 않기 위해서다.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, ToolCallResult } from 'claude-code'

import type { ChangedFile, FileLog, Place, WorkTree } from '../types'

const PANE = 'changed-files'
const TITLE = '수정한 파일'
// 값의 모양을 바꾸면 태그를 올린다. 이전 버전이 저장한 값은 다시 불러와도 남으므로, 태그가 다르면 초기값으로 읽는다.
const EMPTY_LOG: FileLog = { list: [], seen: [] }
const files = atom({ plugin: 'changed-files', key: 'files' } as const, EMPTY_LOG, { shape: 'files-2' })
const trees = atom({ plugin: 'changed-files', key: 'trees' } as const, [], { shape: 'trees-1' })
const place = atom({ plugin: 'changed-files', key: 'place' } as const, null, { shape: 'place-1' })

const MAX_FILES = 500
// 이미 센 도구 호출 id를 이만큼 둔다. 한 세션의 Edit·Write 호출 수보다 넉넉해야 다시 읽을 때 두 번 세지 않는다.
const MAX_SEEN = 5000
const MAX_SNAPSHOT_TREES = 8
const MAX_RECENT_BASH_TREES = 4
const BRANCH_REFRESH_MS = 30_000

/** 폴더 하나의 git 정보: 작업 트리 최상위, 그 안에서 이 폴더의 상대 경로, 워크트리 여부, 공용 .git 폴더 */
type DirInfo = { root: string; prefix: string; isLinked: boolean; commonDir: string }

/**
 * 기록할 변경 하나. id는 Edit·Write·NotebookEdit 호출의 tool_use_id로, 대화 기록을 다시 읽을 때 두 번 세지 않는 데 쓴다.
 * Bash 변경은 다시 읽을 일이 없어 id가 없다. root·rel을 이미 아는 Bash 변경은 located를 함께 넘긴다.
 */
type Change = {
  path: string
  id?: string
  kind: ChangedFile['kind']
  via: ChangedFile['via']
  added: number
  removed: number
  byAgent: boolean
  at: number
  located?: { info: DirInfo | null; rel: string }
}

/** 한 작업 트리의 git status 사진: 바뀐 파일(상대 경로 → 두 글자 상태)과 브랜치 */
type Snapshot = { root: string; entries: Map<string, string>; branch: string | null }

// 폴더 → git 정보. 저장소 밖이면 null, 폴더가 없어 git을 시작하지 못했으면 'missing'.
// 같은 폴더에 git을 다시 부르지 않게 한다. 다시 불러오면 비워지고 그때 다시 채운다.
const dirCache = new Map<string, DirInfo | null | 'missing'>()
// 최근 Bash 명령에 나온 작업 트리. 이 세션은 Bash의 cd가 다음 호출로 이어지므로,
// 앞 명령에서 cd한 워크트리를 다음 명령(경로 없이 sed -i 등)에서도 사진 찍도록 남겨 둔다. 다시 불러오면 비워진다.
let recentBashTrees: string[] = []

/** 경로의 상위 폴더 */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** 경로의 마지막 이름 */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 경로가 base 안에 있으면 base 다음 부분을, 아니면 null을 돌려준다 */
function under(base: string, path: string): string | null {
  if (path === base) return ''
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/** 홈 폴더 아래 경로를 ~로 줄인다 */
function tilde(path: string, home: string | null): string {
  const rest = home === null ? null : under(home, path)
  if (rest === null) return path
  return rest === '' ? '~' : `~/${rest}`
}

/** '.'·'..'·빈 칸을 풀어 경로를 정리한다 */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** 터미널에서 글자 하나가 차지하는 칸 수. 한글·한자·전각 문자·그림 문자는 두 칸 */
function cells(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)
  return isWide ? 2 : 1
}

/** 글이 차지하는 칸 수 */
function widthOf(text: string): number {
  let sum = 0
  for (const ch of text) sum += cells(ch)
  return sum
}

/** 글이 max 칸을 넘으면 앞을 잘라 '…'을 붙인다. 경로는 끝(파일 이름)이 중요해서 앞을 자른다 */
function keepTail(text: string, max: number): string {
  if (widthOf(text) <= max) return text
  const chars = [...text]
  let used = 1
  let start = chars.length
  while (start > 0 && used + cells(chars[start - 1] ?? '') <= max) {
    start -= 1
    used += cells(chars[start] ?? '')
  }
  return `…${chars.slice(start).join('')}`
}

/** git을 셸 없이 실행해 표준 출력을 돌려준다. 종료 코드가 0이 아니면 null. 폴더가 없어 시작하지 못하면 예외를 던진다 */
async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | null> {
  const ran = await $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: 5000 })
  return ran.exitCode === 0 ? ran.stdout : null
}

/** 폴더 하나의 git 정보를 읽는다. 저장소 밖이면 null, 폴더가 없으면 'missing' */
async function dirInfo($: EngineInterface, dir: string): Promise<DirInfo | null | 'missing'> {
  const cached = dirCache.get(dir)
  if (cached !== undefined) return cached
  let out: string | null
  try {
    out = await git($, dir, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      '--show-prefix',
    ])
  } catch {
    dirCache.set(dir, 'missing')
    return 'missing'
  }
  const [root = '', gitDir = '', commonDir = '', prefix = ''] = (out ?? '').split('\n')
  const info = out === null || root === '' ? null : { root, prefix, isLinked: gitDir !== commonDir, commonDir }
  dirCache.set(dir, info)
  return info
}

/** 경로가 속한 작업 트리와 그 안의 상대 경로를 찾는다. 경로가 없으면(지운 파일·폴더) 있는 상위 폴더까지 올라가 찾는다 */
async function locate(
  $: EngineInterface,
  start: string,
  restStart = '',
): Promise<{ info: DirInfo | null; rel: string }> {
  let dir = start
  let rest = restStart
  for (let i = 0; i < 16 && dir !== '/'; i += 1) {
    const info = await dirInfo($, dir)
    if (info !== 'missing') {
      return { info, rel: info === null ? '' : info.prefix + rest }
    }
    rest = rest === '' ? basename(dir) : `${basename(dir)}/${rest}`
    dir = dirname(dir)
  }
  return { info: null, rel: '' }
}

/** 작업 트리의 지금 브랜치 이름. 분리된 HEAD면 '(분리됨) <짧은 해시>' */
async function branchOf($: EngineInterface, root: string): Promise<string> {
  try {
    const name = (await git($, root, ['branch', '--show-current']))?.trim()
    if (name) return name
    const sha = (await git($, root, ['rev-parse', '--short', 'HEAD']))?.trim()
    return sha ? `(분리됨) ${sha}` : '(알 수 없음)'
  } catch {
    return '(알 수 없음)'
  }
}

/** git status 머리줄('## develop...origin/develop [ahead 1]')에서 브랜치 이름을 꺼낸다. 분리된 HEAD면 null */
function parseBranch(head: string): string | null {
  if (head.startsWith('No commits yet on ')) return head.slice('No commits yet on '.length)
  if (head.startsWith('HEAD (no branch)')) return null
  return head.split('...')[0]?.split(' ')[0] ?? null
}

/** 작업 트리 하나의 git status를 찍는다. 저장소가 아니거나 실패하면 null */
async function snapshot($: EngineInterface, root: string): Promise<Snapshot | null> {
  try {
    const out = await git($, root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
    if (out === null) return null
    const parts = out.split('\0')
    const entries = new Map<string, string>()
    let branch: string | null = null
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? ''
      if (part.startsWith('## ')) {
        branch = parseBranch(part.slice(3))
        continue
      }
      if (part.length < 4) continue
      const xy = part.slice(0, 2)
      entries.set(part.slice(3), xy)
      // -z에서 이름 바꾸기·복사는 다음 칸이 원래 이름이다.
      if (xy[0] === 'R' || xy[0] === 'C') i += 1
    }
    return { root, entries, branch }
  } catch {
    return null
  }
}

/** 두 상태 글자로 변경 종류를 정한다 */
function kindOf(xy: string): ChangedFile['kind'] {
  if (xy.includes('D')) return 'deleted'
  if (xy === '??' || xy.includes('A')) return 'added'
  return 'modified'
}

/** Bash 앞뒤 git status를 비교해 작업 파일이 새로 바뀐 것만 고른다. git add처럼 인덱스만 바뀐 것은 뺀다 */
function diffSnapshots(before: Snapshot, after: Snapshot): { rel: string; kind: ChangedFile['kind'] }[] {
  const out: { rel: string; kind: ChangedFile['kind'] }[] = []
  for (const [rel, xy] of after.entries) {
    const prev = before.entries.get(rel)
    const isNew = prev === undefined
    const isWorktreeChanged = prev !== undefined && xy[1] !== ' ' && xy[1] !== prev[1]
    if (isNew || isWorktreeChanged) out.push({ rel, kind: kindOf(xy) })
  }
  return out
}

/** 저장소의 상위 폴더. 작업 트리 이름을 이 기준으로 보인다(메인 checkout의 상위, 즉 워크스페이스) */
function baseOf(info: DirInfo): string {
  return info.commonDir.endsWith('/.git') ? dirname(dirname(info.commonDir)) : dirname(info.root)
}

/** 작업 트리를 화면에 보일 이름. 워크스페이스 기준 상대 경로, 그 밖이면 ~로 줄인 경로 */
function treeLabel(root: string, where: Place | null): string {
  const rel = where?.base ? under(where.base, root) : null
  if (rel !== null && rel !== '') return rel
  return tilde(root, where?.home ?? null)
}

/** 복사·표시에 쓰는 파일 경로. 작업 트리 이름 + 그 안의 상대 경로 */
function fileLabel(file: ChangedFile, where: Place | null): string {
  if (file.root === null) return tilde(file.path, where?.home ?? null)
  return `${treeLabel(file.root, where)}/${file.rel}`
}

/** 같은 파일인지 가리는 열쇠. 작업 트리 안이면 (작업 트리, 상대 경로)로 비교해 심볼릭 링크 차이를 덮는다 */
function keyOf(file: { root: string | null; rel: string; path: string }): string {
  return file.root === null ? file.path : `${file.root}\n${file.rel}`
}

/** 변경 하나를 목록에 합친다. 이미 센 호출은 applyChanges가 먼저 걸러 낸다 */
function mergeFile(list: ChangedFile[], change: Change, root: string | null, rel: string): ChangedFile[] {
  const path = root === null ? change.path : `${root}/${rel}`
  const key = keyOf({ root, rel, path })
  const i = list.findIndex(one => keyOf(one) === key)
  if (i < 0) {
    const fresh: ChangedFile = {
      path,
      root,
      rel,
      kind: change.kind,
      via: change.via,
      count: 1,
      added: change.added,
      removed: change.removed,
      lastAt: change.at,
      byAgent: change.byAgent,
    }
    const grown = [...list, fresh]
    return grown.length <= MAX_FILES ? grown : [...grown].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_FILES)
  }
  const prev = list[i]
  if (prev === undefined) return list
  // 이 세션에서 새로 만든 파일은 다시 고쳐도 '새 파일'로 둔다. 지우면 '지움'이 된다.
  const kind = change.kind === 'deleted' ? 'deleted' : prev.kind === 'added' ? 'added' : change.kind
  const next: ChangedFile = {
    ...prev,
    kind,
    via: change.via,
    count: prev.count + 1,
    added: prev.added + change.added,
    removed: prev.removed + change.removed,
    lastAt: Math.max(prev.lastAt, change.at),
    byAgent: prev.byAgent || change.byAgent,
  }
  return list.map((one, j) => (j === i ? next : one))
}

/** 변경들을 기록한다. 이미 센 호출은 빼고, 처음 보는 작업 트리는 브랜치를 읽어 함께 넣는다 */
async function applyChanges($: EngineInterface, incoming: readonly Change[]): Promise<void> {
  // 다시 읽은 기록이 작업 트리의 마지막 변경 시각을 끌어올려 머리가 바뀌지 않게, 이미 센 호출은 처음부터 뺀다.
  const seenBefore = new Set((await read($, files)).seen)
  const changes = incoming.filter(change => change.id === undefined || !seenBefore.has(change.id))
  if (changes.length === 0) return
  const located: { change: Change; info: DirInfo | null; rel: string }[] = []
  for (const change of changes) {
    const found = change.located ?? (await locate($, dirname(change.path), basename(change.path)))
    located.push({ change, info: found.info, rel: found.rel })
  }
  const known = new Set((await read($, trees)).map(tree => tree.root))
  const fresh = new Map<string, WorkTree>()
  for (const { info } of located) {
    if (info === null || known.has(info.root) || fresh.has(info.root)) continue
    fresh.set(info.root, { root: info.root, branch: await branchOf($, info.root), isLinked: info.isLinked, lastAt: 0 })
  }
  const lastAt = new Map<string, number>()
  for (const { change, info } of located) {
    if (info === null) continue
    lastAt.set(info.root, Math.max(lastAt.get(info.root) ?? 0, change.at))
  }
  await update($, trees, list => {
    const merged = [...list.filter(tree => !fresh.has(tree.root)), ...fresh.values()]
    return merged.map(tree => {
      const at = lastAt.get(tree.root)
      return at === undefined || at <= tree.lastAt ? tree : { ...tree, lastAt: at }
    })
  })
  // 위에서 걸렀어도 그사이 다른 호출이 같은 id를 셌을 수 있으므로, 쓰는 순간에 한 번 더 거른다.
  await update($, files, log => {
    const seen = new Set(log.seen)
    let list = log.list
    const added: string[] = []
    for (const one of located) {
      const id = one.change.id
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
        added.push(id)
      }
      list = mergeFile(list, one.change, one.info?.root ?? null, one.rel)
    }
    return { list, seen: [...log.seen, ...added].slice(-MAX_SEEN) }
  })
}

/** Edit·Write 결과의 diff에서 더한 줄·지운 줄을 센다. 새로 만든 파일은 내용 줄 수를 더한 줄로 본다 */
function countLines(result: unknown, content?: string): { added: number; removed: number; isCreate: boolean } {
  const record = (typeof result === 'object' && result !== null ? result : {}) as {
    type?: unknown
    structuredPatch?: unknown
  }
  let added = 0
  let removed = 0
  if (Array.isArray(record.structuredPatch)) {
    for (const hunk of record.structuredPatch as { lines?: unknown }[]) {
      if (!Array.isArray(hunk.lines)) continue
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
  }
  const isCreate = record.type === 'create'
  if (isCreate && added === 0 && typeof content === 'string' && content !== '') {
    added = content.replace(/\n$/, '').split('\n').length
  }
  return { added, removed, isCreate }
}

/** 성공한 파일 도구 호출 하나를 기록한다. 거부·오류면 넘어간다 */
async function recordTool(
  $: EngineInterface,
  input: { id: string; path: string; via: 'Edit' | 'Write' | 'NotebookEdit'; agentId?: string; content?: string },
  ran: ToolCallResult,
): Promise<void> {
  if (ran.deny !== undefined || ran.isError === true) return
  const { added, removed, isCreate } = countLines(ran.result, input.content)
  await applyChanges($, [
    {
      path: input.path,
      id: input.id,
      kind: isCreate ? 'added' : 'modified',
      via: input.via,
      added,
      removed,
      byAgent: input.agentId !== undefined,
      at: await $.clock.now(),
    },
  ])
}

/** Bash 명령에서 경로로 보이는 낱말을 골라 절대 경로로 바꾼다('/'가 든 낱말, cd·-C 다음 낱말). 최대 12개 */
function pathsIn(command: string, where: Place): string[] {
  const words = command.split(/[\s;|&()<>`"'=]+/).filter(word => word !== '')
  const out = new Set<string>()
  for (let i = 0; i < words.length && out.size < 12; i += 1) {
    const word = words[i] ?? ''
    const prev = words[i - 1] ?? ''
    if (word.startsWith('-') || word.includes('://') || word.includes('$')) continue
    if (!word.includes('/') && prev !== 'cd' && prev !== '-C') continue
    const isHome = word === '~' || word.startsWith('~/')
    const raw = isHome && where.home ? where.home + word.slice(1) : word.startsWith('/') ? word : `${where.cwd}/${word}`
    out.add(normalize(raw))
  }
  return [...out]
}

/**
 * Bash 앞뒤로 사진을 찍을 작업 트리: 최근에 파일을 바꾼 작업 트리, 세션 폴더의 작업 트리,
 * 이번 명령에 나온 경로의 작업 트리, 최근 Bash 명령에 나온 작업 트리(cd가 다음 호출로 이어지는 경우)
 */
async function treesForBash($: EngineInterface, command: string): Promise<string[]> {
  const where = await read($, place)
  const roots = new Set(
    [...(await read($, trees))]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, MAX_SNAPSHOT_TREES)
      .map(tree => tree.root),
  )
  const named: string[] = []
  if (where !== null) {
    for (const path of pathsIn(command, where)) {
      const { info } = await locate($, path)
      if (info !== null && !named.includes(info.root)) named.push(info.root)
    }
  }
  for (const root of [...named, ...recentBashTrees]) roots.add(root)
  recentBashTrees = [...named, ...recentBashTrees.filter(root => !named.includes(root))].slice(0, MAX_RECENT_BASH_TREES)
  return [...roots]
}

/** 여러 작업 트리의 git status를 한꺼번에 찍는다. Bash 앞뒤 지연을 줄이려고 나란히 돌린다 */
async function snapshotAll($: EngineInterface, roots: readonly string[]): Promise<Snapshot[]> {
  const shots = await Promise.all(roots.map(root => snapshot($, root)))
  return shots.filter((shot): shot is Snapshot => shot !== null)
}

/** Bash가 끝난 뒤 사진을 다시 찍어 새로 바뀐 파일을 기록하고, 작업 트리의 브랜치 이름을 맞춘다 */
async function recordBash(
  $: EngineInterface,
  before: readonly Snapshot[],
  input: { agentId?: string },
): Promise<void> {
  const at = await $.clock.now()
  const changes: Change[] = []
  const branches = new Map<string, string>()
  const afterShots = await snapshotAll($, before.map(shot => shot.root))
  for (const prev of before) {
    const after = afterShots.find(shot => shot.root === prev.root)
    if (after === undefined) continue
    branches.set(after.root, after.branch ?? (await branchOf($, after.root)))
    const info = await dirInfo($, after.root)
    const tree = info === 'missing' ? null : info
    for (const { rel, kind } of diffSnapshots(prev, after)) {
      changes.push({
        path: `${after.root}/${rel}`,
        kind,
        via: 'Bash',
        added: 0,
        removed: 0,
        byAgent: input.agentId !== undefined,
        at,
        located: { info: tree, rel },
      })
    }
  }
  await setBranches($, branches)
  await applyChanges($, changes)
}

/** 바뀐 브랜치 이름만 상태에 쓴다. 같으면 쓰지 않아 패널을 괜히 다시 그리지 않는다 */
async function setBranches($: EngineInterface, branches: ReadonlyMap<string, string>): Promise<void> {
  const list = await read($, trees)
  const isChanged = list.some(tree => branches.has(tree.root) && branches.get(tree.root) !== tree.branch)
  if (!isChanged) return
  await update($, trees, current =>
    current.map(tree => {
      const branch = branches.get(tree.root)
      return branch === undefined || branch === tree.branch ? tree : { ...tree, branch }
    }),
  )
}

/** 아는 작업 트리의 브랜치를 모두 다시 읽는다(세션 밖에서 checkout한 경우를 맞춘다) */
async function refreshBranches($: EngineInterface): Promise<void> {
  const branches = new Map<string, string>()
  for (const tree of await read($, trees)) branches.set(tree.root, await branchOf($, tree.root))
  await setBranches($, branches)
}

/** 대화 기록 한 묶음에서 성공한 파일 도구 호출을 변경으로 옮긴다 */
function changesFrom(
  rows: readonly { toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true }[] }[],
  byAgent: boolean,
): Change[] {
  const out: Change[] = []
  for (const row of rows) {
    for (const use of row.toolUses) {
      if (use.tool !== 'Edit' && use.tool !== 'Write' && use.tool !== 'NotebookEdit') continue
      if (use.isError === true || (use.result === undefined && use.text === undefined)) continue
      const path = use.tool === 'NotebookEdit' ? use.input.notebook_path : use.input.file_path
      if (typeof path !== 'string' || path === '') continue
      const content = use.tool === 'Write' && typeof use.input.content === 'string' ? use.input.content : undefined
      const { added, removed, isCreate } = countLines(use.result, content)
      out.push({ path, id: use.tool_use_id, kind: isCreate ? 'added' : 'modified', via: use.tool, added, removed, byAgent, at: 0 })
    }
  }
  return out
}

/** 대화 기록(메인과 서브에이전트)에 남은 파일 도구 호출로 목록을 채운다. 이미 센 호출은 id로 걸러 두 번 세지 않는다 */
async function backfill($: EngineInterface): Promise<void> {
  const rows = await $.session.messages()
  const changes = changesFrom(rows, false)
  for (const row of rows) {
    for (const use of row.toolUses) {
      if (use.agentId === undefined) continue
      try {
        const sub = await $.session.messages({ agentId: use.agentId })
        if (Array.isArray(sub)) changes.push(...changesFrom(sub, true))
      } catch {
        // 끝난 지 오래된 서브에이전트는 기록을 읽지 못할 수 있다. 메인 대화 기록만으로 채운다.
      }
    }
  }
  // 기록 순서를 지키면서 이후 실시간 변경보다 앞에 오도록 지금보다 조금 이른 시각을 차례로 준다.
  const now = await $.clock.now()
  const timed = changes.map((change, i) => ({ ...change, at: now - (changes.length - i) }))
  await applyChanges($, timed)
}

/** 세션 폴더의 작업 트리와 경로 기준(워크스페이스·홈)을 정한다 */
async function setupPlace($: EngineInterface, cwd: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? null
  const { info } = await locate($, cwd)
  await update($, place, () => ({ cwd, base: info === null ? null : baseOf(info), home }))
  if (info === null) return
  const known = (await read($, trees)).some(tree => tree.root === info.root)
  if (known) return
  const tree: WorkTree = { root: info.root, branch: await branchOf($, info.root), isLinked: info.isLinked, lastAt: 0 }
  await update($, trees, list => (list.some(one => one.root === tree.root) ? list : [...list, tree]))
}

/** 머리에 보일 작업 트리: 마지막으로 파일을 바꾼 곳, 아직 없으면 세션 폴더의 작업 트리 */
function currentTree(list: readonly WorkTree[], where: Place | null): WorkTree | null {
  const active = [...list].sort((a, b) => b.lastAt - a.lastAt)[0]
  if (active !== undefined && active.lastAt > 0) return active
  const cwd = where?.cwd
  return list.find(tree => cwd !== undefined && under(tree.root, cwd) !== null) ?? active ?? null
}

/** 파일 행 끝에 붙일 숫자·꼬리표: +더한 줄 −지운 줄 ×횟수 Bash 에이전트 */
function statsOf(file: ChangedFile): string {
  const parts: string[] = []
  if (file.added > 0) parts.push(`+${file.added}`)
  if (file.removed > 0) parts.push(`−${file.removed}`)
  if (file.count > 1) parts.push(`×${file.count}`)
  if (file.via === 'Bash') parts.push('Bash')
  if (file.byAgent) parts.push('에이전트')
  return parts.join(' ')
}

/** 변경 종류를 한 글자와 색으로 보인다 */
function markOf(kind: ChangedFile['kind']): { text: string; color: 'success' | 'warning' | 'error' } {
  if (kind === 'added') return { text: 'A', color: 'success' }
  if (kind === 'deleted') return { text: 'D', color: 'error' }
  return { text: 'M', color: 'warning' }
}

/** 파일 경로를 클립보드에 넣고 결과를 알린다 */
async function copyPath($: EngineInterface, surface: RenderSurface, text: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `경로를 복사했습니다: ${text}` : `경로를 복사하지 못했습니다 (${copied.reason})`)
}

/**
 * 목록을 비운다. 이미 센 호출 id는 남겨 새로고침·다시 불러오기 때 비운 파일이 되살아나지 않게 한다.
 * 작업 트리는 남기되 마지막 변경 시각을 지워 머리가 세션 폴더로 돌아가게 한다.
 */
async function clearAll($: EngineInterface): Promise<void> {
  await update($, files, log => ({ list: [], seen: log.seen }))
  await update($, trees, list => list.map(tree => ({ ...tree, lastAt: 0 })))
  $.ui.toast('수정한 파일 목록을 비웠습니다')
}

/** 브랜치를 다시 읽고 대화 기록으로 빠진 파일을 채운다 */
async function refreshAll($: EngineInterface): Promise<void> {
  await refreshBranches($)
  await backfill($)
  $.ui.toast('브랜치와 수정한 파일 목록을 다시 읽었습니다')
}

/** 패널을 연다. 사람이 명령으로 열면 화면 폭과 상관없이 자리를 잡는다 */
async function openPane($: EngineInterface): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  return opened.isPlaced ? '수정한 파일 패널을 열었습니다.' : `패널이 아직 자리를 잡지 못했습니다: ${opened.reason}`
}

export const register: Register = on => {
  // 세션 시작·다시 불러오기마다: 명령 등록, 경로 기준 설정, 대화 기록으로 목록 채우기, 패널 열기, 브랜치 주기 확인.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'changed-files', description: '이 세션에서 수정한 파일과 작업 중인 워크트리·브랜치 패널을 엽니다' })
      await setupPlace($, e.cwd)
      await backfill($)
    } catch (error) {
      $.ui.log(`changed-files: 시작 준비 중 오류: ${String(error)}`)
    }
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(BRANCH_REFRESH_MS, () => {
      void refreshBranches($).catch(() => undefined)
    })
    return started
  })

  // /changed-files: 닫았거나 화면이 좁아 자리를 못 잡은 패널을 연다.
  on('command.run', { command: 'changed-files' }, async $ => ({ text: await openPane($) }))

  // Edit: 성공하면 diff 줄 수와 함께 기록한다. 기록이 실패해도 도구 결과는 그대로 돌려준다.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await recordTool($, { id: e.tool_use_id, path: e.file_path, via: 'Edit', agentId: e.agentId }, ran)
    } catch {
      // 기록 실패는 편집 결과에 영향을 주지 않는다.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Write: 새 파일이면 'A', 덮어쓰면 'M'으로 기록한다.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await recordTool($, { id: e.tool_use_id, path: e.file_path, via: 'Write', agentId: e.agentId, content: e.content }, ran)
    } catch {
      // 기록 실패는 쓰기 결과에 영향을 주지 않는다.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // NotebookEdit: 노트북 파일을 고친 것으로 기록한다(줄 수는 세지 않는다).
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await recordTool($, { id: e.tool_use_id, path: e.notebook_path, via: 'NotebookEdit', agentId: e.agentId }, ran)
    } catch {
      // 기록 실패는 편집 결과에 영향을 주지 않는다.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Bash: 명령 앞뒤 git status를 비교해 새로 바뀐 파일을 기록하고 브랜치 이름을 맞춘다.
  // 명령이 실패해도 파일은 바뀌었을 수 있으므로 오류여도 비교한다. 거부돼 돌지 않았으면 넘어간다.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let before: Snapshot[] = []
    try {
      before = await snapshotAll($, await treesForBash($, e.command))
    } catch {
      before = []
    }
    const ran = await next(e)
    if (ran.deny === undefined && before.length > 0) {
      try {
        await recordBash($, before, { agentId: e.agentId })
      } catch {
        // 기록 실패는 명령 결과에 영향을 주지 않는다.
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // 패널 그리기: 맨 위 작업 위치(워크트리·브랜치), 그 아래 작업 트리별 수정한 파일.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = (await read($, files)).list
    const treeList = await read($, trees)
    const where = await read($, place)
    const width = Math.max(16, e.props.bodyColumns)
    const current = currentTree(treeList, where)
    const currentLabel = current === null ? null : treeLabel(current.root, where)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>{current?.branch ?? '브랜치 없음'}</Text>
          <Text dimColor>수정한 파일 {list.length}개</Text>
        </Box>
      )
    }

    const header =
      current === null || currentLabel === null ? (
        <Text dimColor>세션 폴더가 git 저장소가 아닙니다.</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>작업 위치</Text>
          <Box flexDirection="row">
            <Box width={9} flexShrink={0}>
              <Text dimColor>{current.isLinked ? '워크트리' : '저장소'}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text>{current.isLinked ? currentLabel : `${currentLabel} (메인)`}</Text>
            </Box>
          </Box>
          <Box flexDirection="row">
            <Box width={9} flexShrink={0}>
              <Text dimColor>브랜치</Text>
            </Box>
            <Box flexShrink={1}>
              <Text color="suggestion">{current.branch}</Text>
            </Box>
          </Box>
        </Box>
      )

    // 작업 트리별로 묶고, 묶음과 그 안의 파일을 최근 순으로 둔다. 저장소 밖 파일은 마지막 묶음이다.
    const groups = new Map<string, ChangedFile[]>()
    for (const file of [...list].sort((a, b) => b.lastAt - a.lastAt)) {
      const key = file.root ?? ''
      groups.set(key, [...(groups.get(key) ?? []), file])
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0))
    const isInline = e.props.placement === 'inline'
    // 입력창 위에 놓일 때는 대화를 가리지 않게 최근 파일 몇 개만 보인다.
    const inlineLimit = 6
    let shown = 0
    const rows = []
    for (const [root, group] of ordered) {
      const visible = isInline ? group.slice(0, Math.max(0, inlineLimit - shown)) : group
      if (visible.length === 0) continue
      shown += visible.length
      const tree = treeList.find(one => one.root === root)
      const title = root === '' ? '저장소 밖' : treeLabel(root, where)
      rows.push(
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{keepTail(title, width)}</Text>
          {tree !== undefined && <Text dimColor>{keepTail(`브랜치 ${tree.branch}`, width)}</Text>}
          {visible.map(file => {
            const mark = markOf(file.kind)
            const stats = statsOf(file)
            const shownPath = file.root === null ? tilde(file.path, where?.home ?? null) : file.rel
            const room = Math.max(12, width - 4 - (stats === '' ? 0 : widthOf(stats) + 1))
            const path = keepTail(shownPath, room)
            const copyText = fileLabel(file, where)
            const key = `file:${keyOf(file)}`
            // Button 안에는 글과 Text만 둔다. 숫자가 없을 때 false 같은 값이 끼지 않게 두 모양으로 나눈다.
            return stats === '' ? (
              <Button key={key} plain onPress={() => copyPath($, e.surface, copyText)}>
                <Text color={mark.color}>{mark.text}</Text> {path}
              </Button>
            ) : (
              <Button key={key} plain onPress={() => copyPath($, e.surface, copyText)}>
                <Text color={mark.color}>{mark.text}</Text> {path}
                <Text dimColor> {stats}</Text>
              </Button>
            )
          })}
        </Box>,
      )
    }

    const hidden = list.length - shown

    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>
          <Text bold>수정한 파일 {list.length}개</Text>
        </Box>
        {list.length === 0 && <Text dimColor>아직 수정한 파일이 없습니다.</Text>}
        {rows}
        {isInline && hidden > 0 && <Text dimColor>외 {hidden}개 (fullscreen 화면에서 모두 보입니다)</Text>}
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button key="refresh" label="새로고침" onPress={() => refreshAll($)} />
          <Button key="clear" label="비우기" onPress={() => clearAll($)} />
        </Box>
        <Text dimColor>행을 누르면 경로를 복사합니다. Bash 변경은 git 상태 비교로 찾습니다.</Text>
      </Box>
    )
  })
}
