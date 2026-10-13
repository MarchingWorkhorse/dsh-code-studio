/**
 * dsh-code-studio client — 「本批次修改前」内容重建（审查视图左侧栏数据源，纯函数可单测）。
 *
 * 与 host 侧 src/model.ts reconstructOriginal 的语义对齐：把仍待处理（pending）的
 * 差异块按 新→旧 顺序从当前内容反向替换（newText → oldText）。已采纳/已拒绝的块
 * 跳过（它们的修改已体现在当前内容中且决策已定）。反解失败的块如实上报 stale，
 * 不猜测其在左侧的位置。
 *
 * 注意：client 拿到的 RecordView 不含 before 全文快照，因此这里必须走「定位 + 反向
 * 替换」而不是直接用 rec.before；这与 host 侧口径一致（host reconstructOriginal 同样
 * 面对可能已被外部修改的当前内容）。
 * 作者 ddj 2026年10月13号
 */
import type { RecordView } from '../../shared/types.js'
import { applyLocations, preciseHunk, isNoopHunk, locateHunks } from '../../shared/diff.js'

/** 重建失败的单块定位（callId + hunk 下标）。 */
export interface ReconstructStale {
  callId: string
  idx: number
}

/** 重建结果：内容与反解失败的块清单。 */
export interface ReconstructResult {
  content: string
  stale: ReconstructStale[]
}

/**
 * 从当前内容反解「待处理块全部拒绝后」的文件内容（即修改前快照的等价重建）。
 * @author ddj 2026年10月13号
 * @param records 同一文件的未归档、未 superseded 记录
 * @param content 当前文件内容（归一化前原文即可；定位按 hunk 文本匹配）
 * @returns 重建内容与 stale 块清单
 */
export function reconstructOriginalOf(records: RecordView[], content: string): ReconstructResult {
  const pending: Array<{ callId: string; idx: number; hunk: NonNullable<ReturnType<typeof preciseHunk>> }> = []
  for (const rec of records) {
    const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
    for (let i = 0; i < hunks.length; i++) {
      const st = rec.decisions?.perHunk?.[i] ?? rec.decisions?.call
      const hunk = preciseHunk(rec, i)
      if (st === 'pending' && hunk && !isNoopHunk(hunk)) pending.push({ callId: rec.callId, idx: i, hunk })
    }
  }
  pending.sort((a, b) => (a.hunk.newText.length < b.hunk.newText.length ? 1 : a.hunk.newText.length > b.hunk.newText.length ? -1 : 0))
  const locations = locateHunks(content, pending.map((item) => item.hunk))
  const rebuilt = applyLocations(content, locations, true)
  return {
    content: rebuilt.content,
    stale: rebuilt.stale.map((i) => ({ callId: pending[i].callId, idx: pending[i].idx })),
  }
}
