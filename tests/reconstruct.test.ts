/**
 * client state/reconstruct.ts 纯函数测试 — 审查视图左侧「修改前」重建。
 * 覆盖：待处理块反向替换、已决策块跳过、多块排序定位、stale 上报、空输入。
 * 作者 ddj 2026年10月13号
 */
import { describe, expect, it } from 'vitest'
import type { RecordView } from '../src/shared/types.js'
import { reconstructOriginalOf } from '../src/client/state/reconstruct.js'

function rec(partial: Partial<RecordView>): RecordView {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: '/ws/a.ts',
    beforeLen: 3,
    create: false,
    callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    at: '2026-10-13T00:00:00.000Z',
    ...partial,
  }
}

describe('reconstructOriginalOf', () => {
  it('单个待处理块：newText 反向替换为 oldText', () => {
    const result = reconstructOriginalOf([rec()], 'x\nb\ny')
    expect(result.content).toBe('x\na\ny')
    expect(result.stale).toEqual([])
  })

  it('已决策块跳过：accepted/rejected 不参与反解', () => {
    const accepted = rec({ callId: 'a1', hunks: [{ oldText: 'a', newText: 'b' }], decisions: { call: 'accepted', perHunk: ['accepted'] } })
    const rejected = rec({ callId: 'r1', hunks: [{ oldText: 'p', newText: 'q' }], decisions: { call: 'rejected', perHunk: ['rejected'] } })
    const result = reconstructOriginalOf([accepted, rejected], 'b\nq')
    // 无待处理块：内容原样返回
    expect(result.content).toBe('b\nq')
    expect(result.stale).toEqual([])
  })

  it('superseded 记录按契约由调用方过滤（本函数只认 pending 状态）', () => {
    // 契约：调用方传入未 superseded 记录（EditorView 已过滤）。此处固化语义：
    // 即便误传 superseded 记录，只要块状态是 pending 也会参与反解（与 host 侧
    // model.ts reconstructOriginal 口径一致，避免两层语义漂移）。
    const result = reconstructOriginalOf([rec({ superseded: true })], 'b')
    expect(result.content).toBe('a')
  })

  it('多个待处理块：长块优先定位，按位置倒序替换', () => {
    const r1 = rec({ callId: 'm1', hunks: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'two', newText: 'TWO' }] })
    const result = reconstructOriginalOf([r1], 'head ONE mid TWO tail')
    expect(result.content).toBe('head one mid two tail')
    expect(result.stale).toEqual([])
  })

  it('纯新增块（oldText=null）反向替换为空串', () => {
    const r = rec({ hunks: [{ oldText: null, newText: 'added\n' }] })
    const result = reconstructOriginalOf([r], 'before added\n after')
    expect(result.content).toBe('before  after')
  })

  it('定位失败的块上报 stale，不影响其他块', () => {
    const r1 = rec({ callId: 'k1', hunks: [{ oldText: 'x', newText: 'y' }] })
    const r2 = rec({ callId: 'k2', hunks: [{ oldText: 'hello', newText: 'world' }] })
    const result = reconstructOriginalOf([r1, r2], 'keep world here')
    expect(result.content).toBe('keep hello here')
    expect(result.stale).toEqual([{ callId: 'k1', idx: 0 }])
  })

  it('空记录列表：内容原样返回', () => {
    const result = reconstructOriginalOf([], 'same')
    expect(result.content).toBe('same')
    expect(result.stale).toEqual([])
  })
})
