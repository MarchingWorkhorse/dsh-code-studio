// @ts-nocheck
/**
 * dsh-code-studio client — Git 工作区差异视图（编辑区主体分支，非弹窗）。
 *
 * 形态对齐 VSCode 源代码管理：左侧变更文件列表（git status --porcelain 全量），
 * 点击行 → 右侧内嵌 HEAD ↔ 工作区双栏 diff（复用 SideBySideDiff 渲染）。
 * 顶部工具条提供「完整补丁」出口（git diff HEAD 全量补丁 → SvnPatchDialog 预览）。
 *
 * 为什么放编辑区主体：弹窗形态点击无反应排查成本高（2026-10-14 实测），
 * 且本视图与差异审查/SVN 基线差异同层，交互一致（关闭即回原编辑器）。
 * 作者 ddj 2026年10月14号
 */
import React from 'react'
import { SideBySideDiff } from './SideBySideDiff.js'
import { GIT_STATUS_LABEL } from '../../shared/git.js'
import { gitChanges, gitDiffBase, gitPatchText } from '../gitStatus.js'

/** 状态字母 → 徽标色 class（复用 svn 徽标色板）。 */
function toneOf(status) {
  if (status === 'M' || status === 'R') return 'edrv-svn-ch-modified'
  if (status === 'A' || status === 'C') return 'edrv-svn-ch-added'
  if (status === 'D') return 'edrv-svn-ch-deleted'
  if (status === 'U') return 'edrv-svn-ch-conflict'
  return 'edrv-svn-ch-plain'
}

/**
 * Git 工作区差异视图（左列表 / 右双栏 diff）。
 * @author ddj 2026年10月14号
 * @param props.monaco Monaco 实例
 * @param props.sessionId 会话 id
 * @param props.initialPath 初始选中文件（从命令「与 HEAD 比较」进入时带活动文件）
 * @param props.onOpenPatch 打开完整补丁预览（host 层由 EditorView 提供）
 * @param props.onClose 关闭回调（回到原编辑器）
 * @param props.onNote 轻量反馈（状态栏）
 * @returns 视图元素
 */
export function GitDiffView(props) {
  const { monaco, sessionId, initialPath, onOpenPatch, onClose, onNote } = props
  const [entries, setEntries] = React.useState(null) // null = 加载中
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(initialPath ?? null)
  const [diff, setDiff] = React.useState(null) // { left, right, reason, message, binary, encodingHint }
  const [loadingDiff, setLoadingDiff] = React.useState(false)

  /** 打开时拉一次全量变更；initialPath 有值则同时加载其差异。 */
  React.useEffect(() => {
    let alive = true
    void gitChanges(sessionId, true).then((outcome) => {
      if (!alive) return
      if (!outcome.ok) { setError(outcome.message); return }
      setEntries(outcome.entries)
      if (outcome.truncated) onNote?.('变更数量超出上限，清单已截断')
    }, (error) => {
      if (!alive) return
      setError('读取 git 变更失败：' + String(error))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /** 点击文件行：拉该文件 HEAD ↔ 工作区差异。 */
  const selectFile = (path) => {
    setSelected(path)
    setLoadingDiff(true)
    setDiff(null)
    void gitDiffBase(sessionId, path).then((outcome) => {
      setLoadingDiff(false)
      if (!outcome.ok) { onNote?.(outcome.message); setDiff({ left: null, right: '', reason: 'error', message: outcome.message }); return }
      setDiff({
        left: outcome.left,
        right: outcome.right,
        reason: outcome.reason,
        message: outcome.left === null ? outcome.message : '',
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
      })
    }, (error) => {
      setLoadingDiff(false)
      const message = '读取差异失败：' + String(error)
      onNote?.(message)
      setDiff({ left: null, right: '', reason: 'error', message })
    })
  }

  /** initialPath 首次自动加载（仅一次）。 */
  const initialLoadedRef = React.useRef(false)
  React.useEffect(() => {
    if (initialLoadedRef.current || !initialPath || entries === null) return
    initialLoadedRef.current = true
    selectFile(initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, initialPath])

  const listBody = () => {
    if (error) return React.createElement('div', { className: 'edrv-git-empty' }, error)
    if (entries === null) return React.createElement('div', { className: 'edrv-git-empty' }, '读取 git 变更中…')
    if (!entries.length) return React.createElement('div', { className: 'edrv-git-empty' }, '工作区无变更（与 HEAD 一致）')
    return entries.map((entry) => React.createElement('div', {
      key: entry.path,
      className: 'edrv-git-file' + (selected === entry.path ? ' edrv-git-file-active' : ''),
      title: entry.path + '（' + (GIT_STATUS_LABEL[entry.status] || entry.status) + '）',
      onClick: () => selectFile(entry.path),
    },
      React.createElement('span', { className: 'edrv-svn-ch ' + toneOf(entry.status) }, entry.status),
      React.createElement('span', { className: 'edrv-git-file-path' }, entry.path)))
  }

  const diffBody = () => {
    if (!selected) {
      return React.createElement('div', { className: 'edrv-git-empty' }, '← 点击左侧文件查看差异')
    }
    if (loadingDiff || (!diff && !error)) {
      return React.createElement('div', { className: 'edrv-git-empty' }, '读取差异中…')
    }
    if (error && !diff) return React.createElement('div', { className: 'edrv-git-empty' }, error)
    return React.createElement(SideBySideDiff, {
      monaco,
      path: selected,
      left: diff.left,
      right: diff.right,
      title: selected,
      leftLabel: 'HEAD',
      rightLabel: '工作区',
      emptyNote: diff.reason === 'no-head' ? '该文件在 HEAD 中不存在（新增/未跟踪文件），无法比较' : (diff.message || '读取差异失败'),
      message: '',
      scheme: 'edrv-git-view',
      onClose,
    })
  }

  return React.createElement('div', { className: 'edrv-gitview' },
    React.createElement('div', { className: 'edrv-gitview-bar' },
      React.createElement('span', { className: 'edrv-gitview-title' }, 'Git 变更（工作区 ↔ HEAD）'),
      React.createElement('span', { className: 'edrv-svn-count' }, entries === null ? '' : String(entries.length) + ' 项'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost',
        title: '生成 git diff HEAD 全量补丁（含暂存与未暂存）',
        disabled: !entries || !entries.length,
        onClick: () => onOpenPatch?.(),
      }, '完整补丁'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '关闭，回到编辑器', onClick: onClose }, '✕ 关闭')),
    React.createElement('div', { className: 'edrv-gitview-body' },
      React.createElement('div', { className: 'edrv-gitview-list' }, listBody()),
      React.createElement('div', { className: 'edrv-gitview-diff' }, diffBody())))
}
