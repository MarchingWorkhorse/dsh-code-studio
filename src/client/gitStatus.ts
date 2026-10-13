/**
 * dsh-code-studio client — Git RPC 包装（薄层：错误捕获 + 结果归一 + 反馈文案）。
 *
 * 与 svnStatus.ts 的差异：git 是「无状态薄包装」——status/changes 每次 dialog 打开时
 * 直拉（不走 store 缓存），因为 Git 总览是低频弹窗入口，无需像 SVN 那样常驻广播。
 * 作者 ddj 2026年10月14号
 */
import type { GitChangeEntry, GitStatusPayload } from '../shared/git.js'
import { rpc } from './rpc.js'

/** 最近一次 git 状态探测快照（命令面板可用性判定用；未探测返回 null）。 */
let lastGitStatus: { managed: boolean; gitCli: boolean } | null = null

/**
 * 读取最近一次 git 状态探测快照（不发起 RPC）。
 * @author ddj 2026年10月14号
 */
export function gitCurrentStatus(): { managed: boolean; gitCli: boolean } | null {
  return lastGitStatus
}

/**
 * 惰性探测 git 状态并写快照（命令面板首个 F1 触发一次；后续走快照）。
 * @author ddj 2026年10月14号
 */
export function probeGitStatus(): Promise<{ managed: boolean; gitCli: boolean }> {
  return gitStatus(undefined).then((outcome) => {
    lastGitStatus = { managed: outcome.managed, gitCli: outcome.gitCli }
    return lastGitStatus
  })
}

/** git.status 归一结果。 */
export interface GitStatusOutcome {
  ok: boolean
  managed: boolean
  repoRoot: string | null
  gitCli: boolean
  message: string
}

/**
 * 拉取 git 能力状态（受管理 / CLI 可用）。
 * @author ddj 2026年10月14号
 * @param sessionId 会话 id
 * @param force 跳过 host 缓存
 */
export async function gitStatus(sessionId: string | undefined, force = false): Promise<GitStatusOutcome> {
  try {
    const res = await rpc('git.status', { sessionId, force })
    if (!res.ok) return { ok: false, managed: false, repoRoot: null, gitCli: false, message: '读取 git 状态失败：' + (res.error ?? '未知错误') }
    lastGitStatus = { managed: res.managed === true, gitCli: res.gitCli === true }
    return {
      ok: true,
      managed: res.managed === true,
      repoRoot: res.repoRoot ?? null,
      gitCli: res.gitCli === true,
      message: res.managed ? 'git 仓库就绪' : '当前工作区不在 git 仓库内',
    }
  } catch (error) {
    return { ok: false, managed: false, repoRoot: null, gitCli: false, message: '读取 git 状态失败：' + String(error) }
  }
}

/** git.changes 归一结果。 */
export interface GitChangesOutcome {
  ok: boolean
  entries: GitChangeEntry[]
  truncated: boolean
  message: string
}

/**
 * 拉取工作区变更清单（`git status --porcelain`）。
 * @author ddj 2026年10月14号
 * @param sessionId 会话 id
 * @param force 跳过 host 缓存
 */
export async function gitChanges(sessionId: string | undefined, force = false): Promise<GitChangesOutcome> {
  try {
    const res = await rpc('git.changes', { sessionId, force })
    if (!res.ok) return { ok: false, entries: [], truncated: false, message: res.error ?? '读取 git 变更失败' }
    return { ok: true, entries: res.entries ?? [], truncated: res.truncated === true, message: '已读取 git 变更' }
  } catch (error) {
    return { ok: false, entries: [], truncated: false, message: '读取 git 变更失败：' + String(error) }
  }
}

/** 单文件 git 基线差异结果（HEAD 左 / 磁盘右）。 */
export interface GitDiffBaseOutcome {
  ok: boolean
  left: string | null
  right: string
  reason?: string
  message: string
  binary?: boolean
  encodingHint?: boolean
}

/**
 * 读取单文件基线差异（HEAD 左 / 磁盘右）。
 * HEAD 无此文件（新增/未跟踪）= 正常业务分支 reason 'no-head'。
 * @author ddj 2026年10月14号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 */
export async function gitDiffBase(sessionId: string | undefined, path: string): Promise<GitDiffBaseOutcome> {
  try {
    const res = await rpc('git.diffBase', { sessionId, path })
    if (!res.ok) return { ok: false, left: null, right: '', message: '读取 git 基线失败：' + (res.error ?? '未知错误') }
    if (res.left === null) {
      const message = res.reason === 'no-head'
        ? '该文件在 HEAD 中不存在（新增/未跟踪文件）'
        : '读取 HEAD 版本失败' + (res.error ? '：' + res.error : '')
      return { ok: true, left: null, right: res.right, reason: res.reason, message, binary: res.binary === true, encodingHint: res.encodingHint === true }
    }
    return { ok: true, left: res.left, right: res.right, message: '已打开 git 基线差异', binary: res.binary === true, encodingHint: res.encodingHint === true }
  } catch (error) {
    return { ok: false, left: null, right: '', message: '读取 git 基线失败：' + String(error) }
  }
}

/** git.patchText 归一结果。 */
export interface GitPatchOutcome {
  ok: boolean
  text: string
  truncated: boolean
  message: string
}

/**
 * 生成完整工作区补丁（`git diff HEAD`；path 为空 = 全仓库）。
 * @author ddj 2026年10月14号
 * @param sessionId 会话 id
 * @param path 工作区相对路径（'' = 全仓库）
 */
export async function gitPatchText(sessionId: string | undefined, path = ''): Promise<GitPatchOutcome> {
  try {
    const res = await rpc('git.patchText', { sessionId, path })
    if (!res.ok) return { ok: false, text: '', truncated: false, message: '生成 git 补丁失败：' + (res.error ?? '未知错误') }
    return { ok: true, text: res.text ?? '', truncated: res.truncated === true, message: '已生成 git 补丁' }
  } catch (error) {
    return { ok: false, text: '', truncated: false, message: '生成 git 补丁失败：' + String(error) }
  }
}
