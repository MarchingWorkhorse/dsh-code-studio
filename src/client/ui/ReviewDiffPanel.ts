// @ts-nocheck
/**
 * dsh-code-studio client — ReviewDiffPanel：VSCode 式可操作差异审查视图。
 *
 * 与只读的 SideBySideDiff（SVN 基线比较）不同，本视图面向 Agent 修改审查：
 * - 左侧「修改前」/ 右侧「修改后」双栏 Monaco diff（原版快照 ↔ 当前磁盘内容）；
 * - 每个变更块行内直接提供 接受 / 拒绝 修订操作（对齐 VSCode diff 编辑器的
 *   Accept/Revert 行内按钮语义），无需回到 hover 浮窗或底部差异条；
 * - 顶部工具条提供 当前文件 采纳全部 / 拒绝全部 与全局 采纳全部文件 / 拒绝全部文件；
 * - 变更块列表快速跳转（↑ i/N ↓），统计徽标（+新增/−删除，git diff --stat 口径）。
 *
 * 数据来源：审查记录（capture.ts 捕获的 before/after 快照与 hunks）。
 * - 左侧内容 = 按待处理块从当前内容反解出的「本批次修改前」重建结果
 *   （reconstructOriginal 纯函数，已含 stale 标记）；
 * - 右侧内容 = 当前磁盘内容；
 * - 已拒绝/已采纳的块已反映在两侧内容中（重建跳过已决策块），行内按钮只对
 *   仍待处理的块提供操作。
 *
 * 作者 ddj 2026年10月13号
 */
import React from 'react'
import { langOf } from '../monaco/loader.js'
import { themeNameOf } from '../monaco/theme.js'
import { diffStatsOf, navTargetOf } from './SideBySideDiff.js'

/**
 * 构造 model URI（对齐 SideBySideDiff 的约定；路径剥前导斜杠防四斜杠）。
 * @private @author ddj 2026年10月13号
 * @param scheme URI scheme
 * @param path 文件路径
 * @param side 侧别
 * @returns Monaco Uri
 */
function uriOf(scheme, path, side) {
  return window.monaco.Uri.parse(scheme + '-' + side + ':///' + encodeURI(String(path ?? '').replace(/^\/+/, '')))
}

/**
 * 取（或建）指定 URI 的只读 model。
 * @private @author ddj 2026年10月13号
 * @param monaco Monaco 实例
 * @param uri 目标 URI
 * @param text 内容
 * @param language Monaco language id
 * @param created 本视图创建的 model 收集器
 * @returns model
 */
function modelFor(monaco, uri, text, language, created) {
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    existing.setValue(text)
    return existing
  }
  const model = monaco.editor.createModel(text, language, uri)
  created.push(model)
  return model
}

/**
 * 可操作差异编辑器选项（审查视图专用：可编辑关闭、行内装饰宽度预留操作按钮）。
 * 与 SideBySideDiff 的 diffOptsOf 同构，但：
 * - readOnly 保持 true（审查动作走 RPC 决策，不直接编辑 model）；
 * - lineDecorationsWidth 预留 22px 指示符 + 操作按钮走 view zone（对齐原差异条路径）。
 * @author ddj 2026年10月13号
 * @param themeName Monaco 主题 id
 * @param viewOpts 视图选项（trimWhitespace/hideUnchanged/eolNormalize）
 * @returns createDiffEditor 选项对象
 */
export function reviewDiffOptsOf(themeName, viewOpts) {
  return {
    theme: themeName,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    renderIndicators: true,
    lineDecorationsWidth: 22,
    minimap: { enabled: false },
    glyphMargin: false,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderOverviewRuler: true,
    wordWrap: 'off',
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 6 },
    ignoreTrimWhitespace: !viewOpts || viewOpts.trimWhitespace !== false,
    hideUnchangedRegions: { enabled: Boolean(viewOpts && viewOpts.hideUnchanged === true) },
  }
}

/**
 * 把 Monaco getLineChanges 的行区间映射到审查块（待处理块按块序对齐变更区间）。
 * Monaco 的变更清单与审查块不一一对应（公共上下文裁剪不同），这里按「重叠即归属」
 * 建立映射：一个 Monaco 变更区间命中某待处理块的展示行区间，即认为该块对应此变更。
 * @private @author ddj 2026年10月13号
 * @param changes Monaco diff 变更清单（ILineChange[]）
 * @param pending 待处理审查块清单（{ callId, idx, start, end, create }）
 * @returns 每个变更区间对应的审查块（可为 null）
 */
export function changeRegionMapOf(changes, pending) {
  const map = new Map()
  for (const change of changes || []) {
    const modStart = Number(change?.modifiedStartLineNumber) || 1
    const modEnd = Math.max(modStart, Number(change?.modifiedEndLineNumber) || 0)
    let hit = null
    for (const region of pending) {
      const start = Number(region?.start) || 0
      const end = Math.max(start, Number(region?.end) || 0)
      if (!start || !end) continue
      // 区间重叠判定（行号 1 基、end 为「末行+1」或与 start 相等的占位）
      if (modStart <= end && modEnd >= start) { hit = region; break }
    }
    map.set(change, hit)
  }
  return map
}

/**
 * 审查差异视图（编辑器主体内的一个分支，非弹窗）。
 * @author ddj 2026年10月13号
 * @param props.monaco Monaco 实例（未就绪为 null）
 * @param props.path 文件路径
 * @param props.left 左侧内容（修改前重建；null = 新建文件无左栏）
 * @param props.right 右侧内容（当前磁盘内容）
 * @param props.pending 待处理块清单（Region[]，来自 diffRegions）
 * @param props.onDecide 单块决策回调 (region, reject) => void
 * @param props.onAcceptFile 当前文件全部采纳回调
 * @param props.onUndoFile 当前文件全部拒绝回调
 * @param props.onAcceptAllFiles 全部文件采纳回调
 * @param props.onUndoAllFiles 全部文件拒绝回调
 * @param props.allPendingCount 全部文件待处理块数
 * @param props.onRefresh 刷新回调
 * @param props.onClose 关闭回调（回到普通编辑器）
 * @param props.staleCount 当前文件 stale（无法定位）块数
 * @returns 审查视图元素
 */
export function ReviewDiffPanel(props) {
  const {
    monaco, path, left, right, pending, staleCount = 0,
    onDecide, onAcceptFile, onUndoFile, onAcceptAllFiles, onUndoAllFiles,
    allPendingCount = 0, onRefresh, onClose,
  } = props
  const hostRef = React.useRef(null)
  const diffRef = React.useRef(null)
  const [nav, setNav] = React.useState({ list: [], idx: 0 })
  const [viewOpts, setViewOpts] = React.useState({ trimWhitespace: true, hideUnchanged: false, eolNormalize: false })
  // 决策后的短时提示（放在工具条上，不打断差异视图）
  const [flash, setFlash] = React.useState('')
  const flashTimer = React.useRef(null)
  const showFlash = (text) => {
    setFlash(text)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(''), 2600)
  }
  React.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  React.useEffect(() => {
    const host = hostRef.current
    if (!monaco || !host) return undefined
    const created = []
    const language = langOf(path)
    const eolOn = viewOpts.eolNormalize === true
    const norm = (t) => (eolOn && typeof t === 'string' ? String(t).replace(/\r\n?/g, '\n') : t)
    const leftModel = modelFor(monaco, uriOf('edrv-review', path, 'left'), norm(left ?? ''), language, created)
    const rightModel = modelFor(monaco, uriOf('edrv-review', path, 'right'), norm(right ?? ''), language, created)
    const diff = monaco.editor.createDiffEditor(host, reviewDiffOptsOf(themeNameOf(), viewOpts))
    diff.setModel({ original: leftModel, modified: rightModel })
    diffRef.current = diff
    const listener = diff.onDidUpdateDiff(() => {
      setNav((prev) => {
        const list = diff.getLineChanges() || []
        return { list, idx: Math.min(prev.idx, Math.max(0, list.length - 1)) }
      })
    })
    setNav((prev) => ({ list: diff.getLineChanges() || [], idx: prev.idx }))
    return () => {
      try { listener.dispose() } catch (error) { /* 随 diff 一并销毁 */ }
      diffRef.current = null
      try { diff.dispose() } catch (error) { /* 已随宿主卸载 */ }
      for (const model of created) {
        try { model.dispose() } catch (error) { /* 已被其他持有者销毁 */ }
      }
    }
  }, [monaco, path, left, right, viewOpts])

  /** 顶部快速跳转（复用 SideBySideDiff 的 navTargetOf 语义）。 */
  const stepDiff = (delta) => {
    const diff = diffRef.current
    const total = nav.list.length
    if (!diff || !total) return
    const idx = (nav.idx + delta + total) % total
    setNav({ list: nav.list, idx })
    const diffRoot = hostRef.current?.querySelector('.monaco-diff-editor')
    const inline = diffRoot ? !diffRoot.classList.contains('side-by-side') : false
    const target = navTargetOf(nav.list[idx], inline)
    const editor = target.side === 'modified' ? diff.getModifiedEditor() : diff.getOriginalEditor()
    try { editor.revealLinesInCenter(target.start, target.end) } catch (error) { /* 区间异常忽略 */ }
  }

  const toggleOpt = (key) => setViewOpts((prev) => ({ ...prev, [key]: !prev[key] }))

  /**
   * 滚动 diff 编辑器到指定审查块（待处理块的修改侧行区间）。
   * @private @author ddj 2026年10月13号
   * @param region 审查块
   */
  const gotoRegion = (region) => {
    const diff = diffRef.current
    const start = Math.max(1, Number(region?.start) || 1)
    const end = Math.max(start, Number(region?.end) || start)
    try {
      diff?.getModifiedEditor()?.revealLinesInCenter(start, end)
    } catch (error) { /* 区间异常忽略 */ }
  }

  /** 单块决策：调用上层回调并给出行内反馈。 */
  const decide = (region, reject) => {
    const result = onDecide?.(region, reject)
    if (result && typeof result.then === 'function') {
      result.then((ok) => showFlash(ok === false ? '操作失败，可刷新后重试' : (reject ? '已拒绝该修订' : '已接受该修订')))
    } else {
      showFlash(reject ? '已拒绝该修订' : '已接受该修订')
    }
  }

  const stats = diffStatsOf(nav.list)
  const hasPending = pending.length > 0 || staleCount > 0

  const optCheckEl = (key, label, title) => React.createElement('label', { className: 'edrv-svn-check edrv-svndiff-opt', title },
    React.createElement('input', { type: 'checkbox', checked: Boolean(viewOpts[key]), onChange: () => toggleOpt(key) }), label)

  return React.createElement('div', { className: 'edrv-review', 'data-edrv-review': '1' },
    React.createElement('div', { className: 'edrv-svndiff-bar' },
      navClusterEl(nav, stepDiff),
      statsEl(stats),
      React.createElement('span', { className: 'edrv-svndiff-title', title: path }, String(path ?? '')),
      React.createElement('span', { className: 'edrv-svndiff-tag' }, '修改前 ↔ 当前'),
      (flash ? React.createElement('span', { className: 'edrv-review-flash' }, flash) : null),
      (staleCount > 0 ? React.createElement('span', { className: 'edrv-svndiff-tag', style: { color: 'var(--dsw-alias-state-warn-primary,#b7791f)' } }, staleCount + ' 处无法定位') : null),
      React.createElement('span', { style: { flex: 1 } }),
      // 单文件批量
      React.createElement('button', { className: 'edrv-pill edrv-pill-keep', title: '接受当前文件全部待处理修订', disabled: !hasPending, onClick: () => { onAcceptFile?.(); showFlash('已接受当前文件全部修订') } }, '✓ 全部接受'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-undo', title: '拒绝当前文件全部待处理修订（回滚该文件本批修改）', disabled: !hasPending, onClick: () => { onUndoFile?.(); showFlash('已拒绝当前文件全部修订') } }, '↩ 全部拒绝'),
      // 全局批量
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '接受所有文件的待处理修订', disabled: !allPendingCount, onClick: () => { onAcceptAllFiles?.(); showFlash('已接受全部文件修订') } }, '⇉ 接受全部文件'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '拒绝所有文件的待处理修订（全部回滚）', disabled: !allPendingCount, onClick: () => { onUndoAllFiles?.(); showFlash('已拒绝全部文件修订') } }, '⇇ 拒绝全部文件'),
      React.createElement('div', { className: 'edrv-svndiff-opts' },
        optCheckEl('trimWhitespace', '行尾空白', '忽略行尾空白差异'),
        optCheckEl('hideUnchanged', '折叠未变更', '折叠未变更区域，仅显示差异及其上下文'),
        optCheckEl('eolNormalize', 'EOL 规范化', '比较前把 CRLF/CR 规范化为 LF（仅影响展示）')),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '刷新差异与内容', onClick: () => { onRefresh?.(); showFlash('已刷新') } }, '⟳'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '关闭审查视图，回到普通编辑器', onClick: onClose }, '✕ 关闭')),
    React.createElement('div', { className: 'edrv-review-hunkbar' },
      React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } },
        '待处理修订 ' + pending.length + ' 处：逐块点击行内 接受/拒绝，或使用上方批量操作。'),
      pending.map((region) => hunkChipEl(region, decide, gotoRegion))),
    ((left === null && right === null) || !monaco
      ? React.createElement('div', { className: 'edrv-svndiff-empty' }, !monaco ? '编辑器加载中…' : '无可比较内容')
      : React.createElement('div', { ref: hostRef, className: 'edrv-svndiff-host edrv-review-host' })))
}

/**
 * 差异导航簇（↑ i/N ↓；无差异时 0/0 且禁用）。
 * @private @author ddj 2026年10月13号
 * @param nav 导航状态
 * @param onStep 步进回调
 * @returns 导航簇元素
 */
function navClusterEl(nav, onStep) {
  const total = nav.list.length
  return React.createElement('span', { className: 'edrv-svndiff-nav' },
    React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异', disabled: !total, onClick: () => onStep(-1) }, '↑'),
    React.createElement('span', { className: 'edrv-svndiff-nav-count', title: '差异位置' }, total ? (nav.idx + 1) + '/' + total : '0/0'),
    React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异', disabled: !total, onClick: () => onStep(1) }, '↓'))
}

/**
 * 差异统计徽标（+新增/−删除）。
 * @private @author ddj 2026年10月13号
 * @param stats diffStatsOf 结果
 * @returns 元素或 null
 */
function statsEl(stats) {
  if (!stats.added && !stats.deleted) return null
  return React.createElement('span', {
    className: 'edrv-svndiff-stat',
    title: '差异行数：+新增/修改行 −删除/修改行（git diff --stat 口径）',
  },
    React.createElement('span', { className: 'edrv-svndiff-stat-add' }, '+' + stats.added),
    React.createElement('span', { className: 'edrv-svndiff-stat-del' }, '-' + stats.deleted))
}

/**
 * 待处理修订行内条目：位置 + 增删行数 + 行内跳转 + 接受/拒绝按钮。
 * @private @author ddj 2026年10月13号
 * @param region 审查块（Region）
 * @param decide 决策回调 (region, reject)
 * @param onGoto 跳转回调（region => void，由外层滚动 diff 编辑器）
 * @returns 条目元素
 */
function hunkChipEl(region, decide, onGoto) {
  const label = region.create ? '新建' : 'L' + (region.start ?? '?')
  const size = []
  if (region.oldLines?.length) size.push('-' + region.oldLines.length)
  if (region.newLines?.length) size.push('+' + region.newLines.length)
  return React.createElement('span', { key: region.callId + ':' + region.idx, className: 'edrv-review-chip' },
    React.createElement('button', {
      className: 'edrv-review-chip-loc',
      title: '滚动到该修订（' + label + '）',
      onClick: () => onGoto?.(region),
    }, label + (size.length ? ' ' + size.join(' ') : '')),
    React.createElement('button', { className: 'edrv-btn-mini edrv-btn-keep', title: '接受该修订（保留修改）', onClick: () => decide(region, false) }, '接受'),
    React.createElement('button', { className: 'edrv-btn-mini edrv-btn-undo', title: '拒绝该修订（回滚此处修改）', onClick: () => decide(region, true) }, '拒绝'))
}
