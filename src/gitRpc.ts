/**
 * dsh-code-studio host — Git 能力：仓库检测、工作区状态、文件基线差异与补丁生成。
 *
 * 与 svn.ts 同一护栏口径：
 * - CLI 全部走 subprocess spawn（无 shell 插值），cwd 换算经 fs.processPath；
 * - 只读命令（status/diff）30s 宽限，输出上限对齐 svn（diff 补丁 16MB，其余 1MB）；
 * - 内容护栏（NUL 二进制 / U+FFFD 编码提示）复用 shared/svn 的 contentGuardOf；
 * - 路径安全复用 safeRel 语义（拒绝绝对路径与 .. 越界）。
 *
 * 与 SVN 的差异：
 * - 仓库根以 `git rev-parse --show-toplevel` 探测（无 .git 目录扫描）；
 * - 文件基线差异 = `git show HEAD:<path>` vs 磁盘内容（git 没有 pristine 概念，
 *   staged 变更以 INDEX 为准的用户可在补丁模式里看 `git diff HEAD` 全量）；
 * - 未跟踪文件（git status ??）没有 HEAD 版本，返回 reason 'no-head'（对齐 svn no-pristine 语义）。
 *
 * 作者 ddj 2026年10月14号
 */
import { tmpdir } from 'node:os'
import type { Ctx } from './store.js'
import { cwdOf, sessionOf } from './registry.js'
import type { SvnContentGuard } from './shared/svn.js'
import type { GitChangeEntry, GitStatusPayload } from './shared/git.js'
import { contentGuardOf } from './shared/svn.js'
import { TEXT_OUTPUT_CAP, tailOfText } from './svnText.js'

/** 输出载荷上限（1MB，对齐 runSvn stdio 限额）。 */
const OUTPUT_CAP = TEXT_OUTPUT_CAP
/** 补丁输出上限（16MB，对齐 svn.patchText）。 */
const PATCH_OUTPUT_CAP = 16 * 1024 * 1024
/** 只读命令宽限。 */
const READ_GRACE_MS = 30_000
/** 文本读取上限（对齐 rpc.ts READ_CAP：>8MB 拒绝整文件读取/差异）。 */
const READ_CAP = 8 * 1024 * 1024
/** git 状态/根探测 TTL：与 svn STATUS_TTL_MS 对齐。 */
const STATUS_TTL_MS = 60_000
/** git CLI 探测 TTL（PATH 很少变）。 */
const CLI_TTL_MS = 5 * 60_000
/** CLI 探测超时。 */
const CLI_GRACE_MS = 6_000
/** 状态/补丁命令行数硬上限（防失控仓库爆炸输出；超出标 truncated）。 */
const STATUS_LINES_CAP = 5000

/** 单文件基线差异结果（left=HEAD 内容，right=磁盘内容）。 */
export interface GitDiffBaseResult {
  ok: boolean
  /** 左侧（HEAD 版本）内容；null = HEAD 无此文件（新增/未跟踪）。 */
  left: string | null
  /** 右侧（工作区磁盘内容）。 */
  right: string
  /** left 缺失原因（'no-head' = HEAD 无此文件）。 */
  reason?: string
  /** 失败提示（诊断用）。 */
  error?: string
  /** W2-6 护栏：内容含 NUL 字节（二进制嫌疑）。 */
  binary?: boolean
  /** W2-6 护栏：嗅探窗含 U+FFFD（可能非 UTF-8）。 */
  encodingHint?: boolean
}

/** subprocess 产句柄最小结构面（对齐 svn.ts SpawnedHandle；done 载荷 exitCode/code 双读）。 */
interface SpawnedHandle {
  done: Promise<{ exitCode?: number; code?: number } | undefined>
  terminate?: () => void
  collected?: {
    stdout?: { readFrom: (n: number) => { text: string } }
    stderr?: { readFrom: (n: number) => { text: string } }
  }
}

/** subprocess 服务 spawn 方法最小结构面。 */
type SpawnFn = (spec: Record<string, unknown>) => SpawnedHandle

/** createGitRpc 依赖。 */
export interface GitRpcDeps {
  ctx: Ctx
}

/** host 会话/工作区前置（对齐 svn.ts requireSvnSession）。 */
async function requireGitSession(
  ctx: Ctx,
  sessionId?: string,
): Promise<{ cwd: string } | { err: string }> {
  const session: { id?: unknown } | undefined = sessionOf(ctx, sessionId)
  if (!session) return { err: '会话不存在' }
  const cwd = cwdOf(session)
  if (!cwd) return { err: '会话无工作区' }
  return { cwd }
}

/** 工作区相对路径归一（'' 合法 = 工作区根；非法含越界/绝对路径返回 null）。 */
function safeRel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') return null
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith('../') || rel.includes('/../')) return null
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return null
  return rel
}

/** 生成默认 git 可执行名（Windows 不带 .exe 也能被 spawn 解析；对齐 SVN_CLI_DEFAULT 口径）。 */
const GIT_CLI_DEFAULT = 'git'

/**
 * 创建 git.* RPC handlers（缓存随装配生命周期）。
 * @author ddj 2026年10月14号
 * @param deps ctx 注入面
 * @returns handlers（Partial<RpcHandlerMap> 形状）与 dispose
 */
export function createGitRpc(deps: GitRpcDeps): { handlers: Record<string, unknown>; dispose: () => void } {
  const { ctx } = deps
  /** 状态缓存（键 = 会话 cwd）。 */
  const statusCache = new Map<string, { at: number; payload: GitStatusPayload }>()
  /** 变更清单缓存（键 = 仓库根；TTL 同状态，合并同一轮 UI 的多处拉取）。 */
  const changesCache = new Map<string, { at: number; value: { entries: GitChangeEntry[]; truncated: boolean } }>()
  let cliProbe: { at: number; exe: string; ok: boolean } | null = null

  const subprocess = (): SpawnFn | null => {
    const sub = ctx.get('subprocess') as { spawn?: unknown } | null | undefined
    if (!sub || typeof sub.spawn !== 'function') return null
    return (sub.spawn as SpawnFn).bind(sub)
  }

  /** git CLI 探测（inherit stdio 只取退出码；TTL 缓存按 exe 键）。 */
  const probeCli = async (exe: string): Promise<boolean> => {
    const at = Date.now()
    if (cliProbe && cliProbe.exe === exe && at - cliProbe.at < CLI_TTL_MS) return cliProbe.ok
    let ok = false
    const spawn = subprocess()
    if (spawn) {
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(new Error('git CLI 探测超时')), CLI_GRACE_MS)
      deadline.unref?.()
      try {
        const handle = spawn({
          argv: [exe, '--version'],
          cwd: tmpdirSafe(),
          stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
          graceMs: CLI_GRACE_MS,
          signal: controller.signal,
        })
        const outcome = await handle.done
        ok = (outcome?.exitCode ?? outcome?.code) === 0
      } catch {
        ok = false
      } finally {
        clearTimeout(deadline)
      }
    }
    cliProbe = { at, exe, ok }
    return ok
  }

  /**
   * 运行 git CLI（管道收集；spawn 级失败回退 inherit，输出降级为空）。
   * @author ddj 2026年10月14号
   * @param cwd 运行目录
   * @param argv 参数（不含可执行文件名）
   * @param graceMs 进程宽限
   * @param stdoutCap stdout 收集上限
   * @returns 退出码与输出
   */
  const runGit = async (cwd: string, argv: string[], graceMs: number, stdoutCap: number = OUTPUT_CAP): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const spawn = subprocess()
    if (!spawn) throw new Error('缺少 subprocess 服务')
    const fs = ctx.get('fs') as { resolve?: (p: string, o: object) => Promise<unknown>; processPath?: (t: unknown) => string } | null | undefined
    let realCwd = cwd
    if (fs?.resolve && fs?.processPath) realCwd = fs.processPath(await fs.resolve(cwd, {}))
    const attempt = (mode: 'pipe' | 'inherit') => spawn({
      argv: [GIT_CLI_DEFAULT, ...argv],
      cwd: realCwd,
      stdio: mode === 'pipe'
        ? { stdout: { maxBytes: stdoutCap }, stderr: { maxBytes: OUTPUT_CAP }, stdin: 'ignore' }
        : { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      graceMs,
    })
    try {
      const handle = attempt('pipe')
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
      return { code: outcome?.exitCode ?? outcome?.code ?? null, stdout, stderr }
    } catch {
      // 受管环境管道 EPERM：回退 inherit（只拿退出码，输出为空）
      const handle = attempt('inherit')
      const outcome = await handle.done
      return { code: outcome?.exitCode ?? outcome?.code ?? null, stdout: '', stderr: '' }
    }
  }

  /** 仓库根探测（`git rev-parse --show-toplevel`，失败 = 不在仓库内）。 */
  const repoRootOf = async (cwd: string): Promise<string | null> => {
    const outcome = await runGit(cwd, ['rev-parse', '--show-toplevel'], READ_GRACE_MS)
    if (outcome.code !== 0) return null
    const root = outcome.stdout.trim()
    return root ? root : null
  }

  /** 合成状态（managed/gitCli），带 TTL 缓存。 */
  const statusOf = async (cwd: string, force = false): Promise<GitStatusPayload> => {
    const at = Date.now()
    const hit = statusCache.get(cwd)
    if (!force && hit && at - hit.at < STATUS_TTL_MS) return hit.payload
    const cliOk = await probeCli(GIT_CLI_DEFAULT)
    const repoRoot = cliOk ? await repoRootOf(cwd) : null
    const payload: GitStatusPayload = {
      managed: repoRoot !== null,
      repoRoot,
      gitCli: cliOk,
      gitPath: GIT_CLI_DEFAULT,
    }
    statusCache.set(cwd, { at, payload })
    return payload
  }

  /** W2-6：双侧内容护栏标记（干净时返回空对象，展开进载荷不添字段）。 */
  const guardSides = (a: string | null, b: string | null): SvnContentGuard => {
    const merged = { ...contentGuardOf(a ?? ''), ...contentGuardOf(b ?? '') }
    return merged.binary || merged.encodingHint ? merged : {}
  }

  /**
   * 解析 `git status --porcelain` 输出为变更清单。
   * 行形态 `XY <path>`（X=staged，Y=unstaged；重命名 `R  old -> new`）。
   */
  const parsePorcelain = (text: string): GitChangeEntry[] => {
    const entries: GitChangeEntry[] = []
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length < 4) continue
      const x = raw[0] ?? ' '
      const y = raw[1] ?? ' '
      const path = raw.slice(3).trim()
      if (!path) continue
      entries.push({ path, x, y, status: y === ' ' ? x : y })
    }
    return entries
  }

  /** 拉取并缓存工作区变更（`git status --porcelain=v1 -z` 之外的简化形态：普通 porcelain v1）。 */
  const changesOf = async (repoRoot: string, force = false): Promise<{ entries: GitChangeEntry[]; truncated: boolean }> => {
    const at = Date.now()
    const hit = changesCache.get(repoRoot)
    if (!force && hit && at - hit.at < STATUS_TTL_MS) return hit.value
    // -z：路径 NUL 分隔，天然规避带空格路径的引号歧义；-z 时重命名不输出 " -> "（原样两条）。
    const outcome = await runGit(repoRoot, ['status', '--porcelain'], READ_GRACE_MS, OUTPUT_CAP)
    if (outcome.code !== 0) return { entries: [], truncated: false }
    const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.length >= 4)
    const truncated = lines.length >= STATUS_LINES_CAP
    const entries = parsePorcelain(outcome.stdout)
    const value = { entries, truncated }
    changesCache.set(repoRoot, { at, value })
    return value
  }

  const handlers = {
    /** git 能力状态（显隐判定唯一数据源）。 */
    'git.status': async (args: { sessionId?: string; force?: boolean }): Promise<GitStatusPayload & { ok: boolean; error?: string }> => {
      const sc = await requireGitSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, managed: false, repoRoot: null, gitCli: false, gitPath: GIT_CLI_DEFAULT, error: sc.err }
      const payload = await statusOf(sc.cwd, args.force === true)
      return { ok: true as const, ...payload }
    },
    /** 变更清单（`git status --porcelain`）。 */
    'git.changes': async (args: { sessionId?: string; force?: boolean }): Promise<{ ok: boolean; repoRoot?: string; entries?: GitChangeEntry[]; truncated?: boolean; error?: string }> => {
      const sc = await requireGitSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.repoRoot) return { ok: false as const, error: '当前工作区不在 git 仓库内' }
      if (!status.gitCli) return { ok: false as const, error: 'git 命令不可用' }
      try {
        const result = await changesOf(status.repoRoot, args.force === true)
        return { ok: true as const, repoRoot: status.repoRoot, ...result }
      } catch (error) {
        return { ok: false as const, error: '读取变更失败：' + String(error) }
      }
    },
    /**
     * 文件基线差异（HEAD 左 / 磁盘右）。
     * HEAD 无此文件（新增/未跟踪）= 正常业务分支 reason 'no-head'，客户端提示而非报错。
     */
    'git.diffBase': async (args: { sessionId?: string; path?: string }): Promise<GitDiffBaseResult & { ok: boolean }> => {
      const sc = await requireGitSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, left: null, right: '', error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '/') return { ok: false as const, left: null, right: '', error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.repoRoot) return { ok: false as const, left: null, right: '', error: '当前工作区不在 git 仓库内' }
      const fs = ctx.get('fs') as {
        resolve?: (p: string, o: object) => Promise<unknown>
        stat?: (t: unknown) => Promise<{ type?: string; size?: number } | null>
        readText?: (t: unknown) => Promise<string>
      } | null | undefined
      if (!fs?.resolve || !fs?.stat || !fs?.readText) return { ok: false as const, left: null, right: '', error: '缺少 fs' }
      try {
        const target = await fs.resolve(rel, { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false as const, left: null, right: '', error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false as const, left: null, right: '', error: '文件过大（>8MB），不支持基线差异' }
        const working = await fs.readText(target)
        // HEAD 侧：以仓库根为 cwd 执行（保证相对路径语义一致）
        const outcome = await runGit(status.repoRoot, ['show', 'HEAD:' + rel], READ_GRACE_MS)
        if (outcome.code !== 0) {
          const text = (outcome.stderr || outcome.stdout).trim()
          const reason = /does not exist|exists on disk, but not in|unknown revision|Invalid object name/i.test(text) ? 'no-head' : 'show-failed'
          return { ok: true as const, left: null, right: working, reason, error: tailOfText(text), ...guardSides(null, working) }
        }
        return { ok: true as const, left: outcome.stdout, right: working, ...guardSides(outcome.stdout, working) }
      } catch (error) {
        return { ok: false as const, left: null, right: '', error: '读取基线失败：' + String(error) }
      }
    },
    /**
     * 完整工作区补丁（`git diff HEAD`，staged + unstaged 一并呈现）。
     * 未跟踪文件不出现在 git diff 中：单独补一段 diff --no-index /dev/null <file>（失败静默跳过）。
     */
    'git.patchText': async (args: { sessionId?: string; path?: string }): Promise<{ ok: boolean; text?: string; truncated?: boolean; error?: string }> => {
      const sc = await requireGitSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.repoRoot) return { ok: false as const, error: '当前工作区不在 git 仓库内' }
      try {
        // 单文件模式：git diff HEAD -- <path>；整体模式：git diff HEAD（含 staged）
        const argv = rel === ''
          ? ['diff', 'HEAD', '--no-color']
          : ['diff', 'HEAD', '--no-color', '--', rel]
        const outcome = await runGit(status.repoRoot, argv, READ_GRACE_MS, PATCH_OUTPUT_CAP)
        if (outcome.code !== 0) {
          return { ok: false as const, error: '生成补丁失败：' + tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')) }
        }
        let text = outcome.stdout
        let truncated = text.length >= PATCH_OUTPUT_CAP
        // 未跟踪文件补段（仅整体模式）：对每个 ?? 条目生成 no-index diff（失败静默）；
        // no-index diff 需要绝对路径且以仓库根为 cwd，单文件上限 50 个防爆炸
        if (rel === '' && !truncated) {
          const { entries } = await changesOf(status.repoRoot)
          const untracked = entries.filter((e) => e.status === '?').slice(0, 50).map((e) => e.path)
          for (const path of untracked) {
            const piece = await serialNoIndexDiff(status.repoRoot, path)
            if (!piece) continue
            text += '\n' + piece
            if (text.length >= PATCH_OUTPUT_CAP) { truncated = true; text = text.slice(0, PATCH_OUTPUT_CAP); break }
          }
        }
        return { ok: true as const, text, truncated }
      } catch (error) {
        return { ok: false as const, error: '生成补丁失败：' + String(error) }
      }
    },
  }

  /** 单文件 no-index diff（未跟踪文件 → /dev/null 对比；失败返回 null）。 */
  const serialNoIndexDiff = async (repoRoot: string, path: string): Promise<string | null> => {
    try {
      const outcome = await runGit(repoRoot, ['diff', '--no-index', '--no-color', '--', '/dev/null', path], READ_GRACE_MS, OUTPUT_CAP)
      // no-index diff 对有差异时退出码 1 是正常语义（有差异即 1）
      if (outcome.code !== 0 && outcome.code !== 1) return null
      return outcome.stdout || null
    } catch {
      return null
    }
  }

  return { handlers, dispose: () => { statusCache.clear(); changesCache.clear(); cliProbe = null } }
}

/** tmpdir 快捷（探测 cwd 契约要求字符串）。 */
function tmpdirSafe(): string {
  try { return tmpdir() } catch { return '.' }
}
