/**
 * dsh-code-studio shared — Git 集成共享类型与展示映射（host/client 共用，无 node/react import）。
 * 作者 ddj 2026年10月14号
 */

/** git status porcelain 状态字母（X/Y 位可出现的值）。 */
export type GitStatusLetter =
  | ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!'

/** git status 一条解析结果（porcelain v1：XY path，X=staged Y=unstaged）。 */
export interface GitChangeEntry {
  /** 仓库根相对路径（`/` 分隔，无引号展开，重命名显示为 a -> b）。 */
  path: string
  /** staged 状态字母（' ' = 无 staged 变更）。 */
  x: string
  /** unstaged 状态字母（' ' = 无 unstaged 变更）。 */
  y: string
  /** 汇总状态（与 y 同步，向后兼容单字母消费方）。 */
  status: string
}

/** git.status 载荷。 */
export interface GitStatusPayload {
  /** 工作区是否位于 git 仓库内。 */
  managed: boolean
  /** 仓库根目录绝对路径（未受管理为 null）。 */
  repoRoot: string | null
  /** git CLI 是否可用。 */
  gitCli: boolean
  /** 实际使用的 git 可执行文件（诊断用）。 */
  gitPath: string
}

/** 状态字母 → 中文说明（徽标 tooltip / 弹窗行 tooltip）。 */
export const GIT_STATUS_LABEL: Record<string, string> = {
  'M': '已修改',
  'A': '已暂存（新增）',
  'D': '已删除',
  'R': '已重命名',
  'C': '已复制',
  'U': '已更新但未合并',
  '?': '未跟踪',
  '!': '已忽略',
}

/** 状态字母 → 展示徽标色 class 后缀（client CSS 变量选择）。 */
export const GIT_STATUS_TONE: Record<string, string> = {
  'M': 'mod',
  'A': 'add',
  'D': 'del',
  'R': 'mod',
  'C': 'add',
  'U': 'conflict',
  '?': 'untracked',
  '!': 'ignore',
}
