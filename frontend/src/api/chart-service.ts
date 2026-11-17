import { findChartDataset, findDatasetRevision, findDatasetVersion } from '@/data/chart-sources'
import type { ChartDataset, DatasetRevision, DatasetVersion } from '@/data/chart-sources'
import { allChartSnapshots, saveChartSnapshots } from '@/data/chart-snapshot-store'
import { listRows } from '@/data/local-store'
import type {
  ChartAggregation,
  ChartConflictPolicy,
  ChartDataDetail,
  ChartDataDetailRow,
  ChartDataPoint,
  ChartDataSnapshot,
  ChartSnapshotBuildResult,
  ChartSnapshotConfig,
  ChartSnapshotExport,
  ChartSnapshotResolution,
  ChartSnapshotVerification,
  EntryRow,
  ReportChartPreview,
  ReportChartPreviewItem,
} from '@/data/types'

/**
 * 图表数据构建与快照服务。
 *
 * 一次构建 = 图表配置（坐标字段）+ 数据集某一版源数据，结果整体落成一份不可变快照：
 * - 同一时刻每张图表最多一份 active 快照对下游（页面 / 报告 / 导出）可见；
 * - 构建先在内存里完整校验并聚合，失败不写任何东西，上一份完整快照原样保留；
 * - 同一份配置 + 同一份源版本 + 同一套口径重复提交时复用已有快照，不追加新记录。
 */

const CHART_MODULE = 'chart'
const DEFAULT_POLICY: ChartConflictPolicy = 'prefer-active-version'

const FIELD_CHART_NO = '图表编号'
const FIELD_CHART_NAME = '图表名称'
const FIELD_CHART_TYPE = '图表类型'
const FIELD_DATA_SOURCE = '数据来源'
const FIELD_X = 'X轴字段'
const FIELD_Y = 'Y轴字段'
const FIELD_PALETTE = '配色方案'
const FIELD_REFRESH = '刷新间隔秒'

const EXPORT_HEADER = [
  '快照版本',
  '坐标点',
  'X轴字段',
  'Y值',
  'Y轴字段',
  '数据集版本',
  '源X列',
  '源Y列',
  '行数',
  '口径说明',
  '备选口径',
]

type NormalizedVersion = {
  version: DatasetVersion
  points: Map<string, { y: number; rowCount: number }>
  nullCoordinates: string[]
}

type ChartReference = number | string | EntryRow

function fail(message: string, previous?: ChartDataSnapshot | null): ChartSnapshotBuildResult {
  return { ok: false, message, previous: previous ?? null }
}

function nowIso(): string {
  return new Date().toISOString()
}

function chartRows(): EntryRow[] {
  return listRows(CHART_MODULE)
}

function snapshotVersionNumber(snapshot: ChartDataSnapshot): number {
  const matched = /^v(\d+)$/.exec(snapshot.version)
  return matched ? Number(matched[1]) : 0
}

function activeSnapshotFor(chartId: number): ChartDataSnapshot | null {
  const candidates = allChartSnapshots()
    .filter((snapshot) => snapshot.chartId === chartId && snapshot.status === 'active')
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))
  return candidates[0] ?? null
}

function previousSnapshotFor(chartId: number): ChartDataSnapshot | null {
  const candidates = allChartSnapshots()
    .filter((snapshot) => snapshot.chartId === chartId && snapshot.status === 'superseded')
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))
  return candidates[0] ?? null
}

function resolveChart(reference: ChartReference): EntryRow | null {
  const rows = chartRows()
  if (typeof reference === 'object') {
    return rows.find((row) => Number(row.id) === Number(reference.id)) ?? null
  }
  if (typeof reference === 'number') {
    return rows.find((row) => Number(row.id) === reference) ?? null
  }
  const token = reference.trim()
  if (!token) {
    return null
  }
  const byNo = rows.find((row) => String(row[FIELD_CHART_NO] ?? '').trim() === token)
  if (byNo) {
    return byNo
  }
  const numeric = Number(token)
  return Number.isFinite(numeric) ? rows.find((row) => Number(row.id) === numeric) ?? null : null
}

function datasetForRow(row: EntryRow): ChartDataset | null {
  const raw = String(row[FIELD_DATA_SOURCE] ?? '').trim()
  if (!raw) {
    return null
  }
  const direct = findChartDataset(raw)
  if (direct) {
    return direct
  }
  // 允许「数据集编号 + 名称」这种便于页面阅读的写法。
  for (const token of raw.split(/[\s,，;；|/]+/).filter(Boolean)) {
    const matched = findChartDataset(token)
    if (matched) {
      return matched
    }
  }
  return null
}

function chartConfigFor(row: EntryRow, dataset: ChartDataset): ChartSnapshotConfig {
  return {
    chartNo: String(row[FIELD_CHART_NO] ?? '').trim(),
    chartName: String(row[FIELD_CHART_NAME] ?? '').trim(),
    chartType: String(row[FIELD_CHART_TYPE] ?? '').trim(),
    datasetId: dataset.id,
    datasetName: dataset.name,
    xField: String(row[FIELD_X] ?? '').trim(),
    yField: String(row[FIELD_Y] ?? '').trim(),
    logicalXField: dataset.logicalXField,
    logicalYField: dataset.logicalYField,
    palette: String(row[FIELD_PALETTE] ?? '').trim(),
    refreshInterval: String(row[FIELD_REFRESH] ?? '').trim(),
    aggregation: dataset.aggregation,
  }
}

function policyLabel(policy: ChartConflictPolicy): string {
  return policy === 'prefer-previous-version' ? '优先旧版本' : '优先新版本'
}

function hashString(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function configSignature(config: ChartSnapshotConfig): string {
  return [
    config.chartNo,
    config.datasetId,
    config.xField,
    config.yField,
    config.aggregation,
  ]
    .map((item) => encodeURIComponent(item))
    .join('|')
}

function buildKeyFor(
  chartId: number,
  config: ChartSnapshotConfig,
  revisionId: string,
  policy: ChartConflictPolicy,
): string {
  return [chartId, configSignature(config), encodeURIComponent(revisionId), policy].join('::')
}

/** 逐行聚合一个数据集版本：同一坐标的 Y 值求和，空值单独记下来交给完整性校验。 */
function aggregateVersion(version: DatasetVersion): NormalizedVersion {
  const points = new Map<string, { y: number; rowCount: number }>()
  const nullCoordinates: string[] = []
  for (const row of version.rows) {
    const coordinate = String(row.coordinate ?? '').trim()
    if (!coordinate) {
      continue
    }
    if (row.value === null || row.value === undefined || !Number.isFinite(row.value)) {
      nullCoordinates.push(coordinate)
      continue
    }
    const current = points.get(coordinate)
    if (current) {
      current.y += row.value
      current.rowCount += 1
    } else {
      points.set(coordinate, { y: row.value, rowCount: 1 })
    }
  }
  return { version, points, nullCoordinates }
}

type ValidationOutcome =
  | { ok: true; revision: DatasetRevision; activeVersion: DatasetVersion; normalized: NormalizedVersion[] }
  | { ok: false; message: string }

/**
 * 在写任何快照之前做的整体校验：源版本必须完整、每个坐标都有非空 Y 值，
 * 并且不能比上一份完整快照少坐标。任一条不满足就整体拒绝，不做局部覆盖。
 */
function validateRevision(
  dataset: ChartDataset,
  revisionId: string,
  previousActive: ChartDataSnapshot | null,
  config: ChartSnapshotConfig,
): ValidationOutcome {
  const revision = findDatasetRevision(dataset, revisionId)
  if (!revision) {
    return { ok: false, message: `数据集 ${dataset.id} 没有版本 ${revisionId}` }
  }
  if (revision.status === 'failed') {
    return {
      ok: false,
      message: revision.failureReason || `数据集版本 ${revisionId} 发布失败，不能生成图表数据快照`,
    }
  }
  const activeVersion = findDatasetVersion(revision, revision.activeVersion)
  if (!activeVersion) {
    return {
      ok: false,
      message: `数据集版本 ${revisionId} 缺少当前版本 ${revision.activeVersion} 的列定义`,
    }
  }
  const previousVersion = revision.previousVersion
    ? findDatasetVersion(revision, revision.previousVersion) ?? null
    : null
  if (revision.versions.length === 0 || activeVersion.rows.length === 0) {
    return { ok: false, message: `数据集版本 ${revisionId} 没有可聚合的数据行` }
  }
  if (revision.previousVersion && !previousVersion) {
    return {
      ok: false,
      message: `数据集版本 ${revisionId} 声明了上一版本 ${revision.previousVersion}，但快照里没有它的列结果，无法做口径比较`,
    }
  }
  const normalized = revision.versions.map((version) => aggregateVersion(version))
  for (const item of normalized) {
    if (item.nullCoordinates.length > 0) {
      return {
        ok: false,
        message: `数据集版本 ${item.version.version} 的坐标点「${item.nullCoordinates.join('、')}」Y 值为空，刷新结果不完整`,
      }
    }
    if (item.points.size === 0) {
      return {
        ok: false,
        message: `数据集版本 ${item.version.version} 没有有效坐标点，刷新结果不完整`,
      }
    }
  }

  const union = new Set<string>()
  for (const item of normalized) {
    for (const coordinate of item.points.keys()) {
      union.add(coordinate)
    }
  }
  if (union.size === 0) {
    return { ok: false, message: `数据集版本 ${revisionId} 没有有效坐标点` }
  }

  if (previousActive && previousActive.configHash === hashConfig(config)) {
    const missing = previousActive.points
      .map((point) => point.x)
      .filter((coordinate) => !union.has(coordinate))
    if (missing.length > 0) {
      return {
        ok: false,
        message: `刷新结果缺少上一份完整快照中的坐标点「${missing.join('、')}」，不能用半次刷新替代完整快照`,
      }
    }
  }

  return { ok: true, revision, activeVersion, normalized }
}

function hashConfig(config: ChartSnapshotConfig): string {
  return hashString(JSON.stringify(config))
}

type PointBuild = {
  points: ChartDataPoint[]
  resolution: ChartSnapshotResolution
}

/** 把各版本结果按坐标归并，一坐标一取值，同时把另一版本的取值留作比较依据。 */
function resolvePoints(
  normalized: NormalizedVersion[],
  activeVersion: DatasetVersion,
  policy: ChartConflictPolicy,
): PointBuild {
  const coordinateSet = new Set<string>()
  for (const item of normalized) {
    for (const coordinate of item.points.keys()) {
      coordinateSet.add(coordinate)
    }
  }
  const active = normalized.find((item) => item.version.version === activeVersion.version) ?? null
  // 坐标点按当前版本的行顺序输出，保证页面明细与导出文件顺序一致、可逐行对照。
  const orderSource = active ?? normalized[normalized.length - 1]
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const row of orderSource.version.rows) {
    const coordinate = String(row.coordinate ?? '').trim()
    if (!coordinate || seen.has(coordinate) || !coordinateSet.has(coordinate)) {
      continue
    }
    seen.add(coordinate)
    ordered.push(coordinate)
  }
  const coordinates = [
    ...ordered,
    ...[...coordinateSet].filter((coordinate) => !seen.has(coordinate)),
  ]

  const preferredOrder = normalized.some((item) => item.version.version === activeVersion.version)
    ? [
        ...(policy === 'prefer-previous-version'
          ? normalized.filter((item) => item.version.version !== activeVersion.version)
          : normalized.filter((item) => item.version.version === activeVersion.version)),
        ...(policy === 'prefer-previous-version'
          ? normalized.filter((item) => item.version.version === activeVersion.version)
          : normalized.filter((item) => item.version.version !== activeVersion.version)),
      ]
    : [...normalized]
  const orderIndex = new Map(preferredOrder.map((item, index) => [item.version.version, index]))

  const points: ChartDataPoint[] = []
  let conflictCount = 0
  let fallbackCount = 0

  for (const coordinate of coordinates) {
    const hits = normalized
      .filter((item) => item.points.has(coordinate))
      .sort(
        (a, b) =>
          (orderIndex.get(a.version.version) ?? 99) - (orderIndex.get(b.version.version) ?? 99),
      )
    const primary = hits[0]
    const primaryPoint = primary.points.get(coordinate)!
    const alternatives = hits.slice(1).map((item) => {
      const value = item.points.get(coordinate)!
      return {
        y: value.y,
        sourceVersion: item.version.version,
        sourceXField: item.version.xColumn,
        sourceYField: item.version.yColumn,
        rowCount: value.rowCount,
        delta: Number((primaryPoint.y - value.y).toFixed(6)),
      }
    })
    const conflict = alternatives.length > 0
    if (conflict) {
      conflictCount += 1
    }
    if (primary.version.version !== activeVersion.version) {
      fallbackCount += 1
    }
    const alternativeText =
      alternatives.length > 0
        ? alternatives
            .map((item) => `${item.sourceVersion}=${item.y}（差 ${item.delta}）`)
            .join('；')
        : '无'
    const reasonText =
      alternatives.length > 0
        ? `多版本并存：${hits
            .map((item) => `${item.version.version}=${item.points.get(coordinate)!.y}`)
            .join('，')}；按「${policyLabel(policy)}」取 ${primary.version.version}`
        : `仅 ${primary.version.version} 提供该坐标`

    points.push({
      x: coordinate,
      y: primaryPoint.y,
      xField: primary.version.xColumn,
      yField: primary.version.yColumn,
      sourceVersion: primary.version.version,
      sourceXField: primary.version.xColumn,
      sourceYField: primary.version.yColumn,
      rowCount: primaryPoint.rowCount,
      conflict,
      conflictNote: `${reasonText}；备选：${alternativeText}`,
      selectedReason:
        primary.version.version === activeVersion.version ? 'active-version' : 'previous-version',
      alternatives,
    })
  }

  return {
    points,
    resolution: {
      coordinateCount: points.length,
      conflictCount,
      fallbackCount,
      policy,
      note:
        conflictCount > 0
          ? `共 ${points.length} 个坐标点，其中 ${conflictCount} 个坐标点同时存在多版本结果，按「${policyLabel(policy)}」比较后取舍；${fallbackCount} 个坐标点取自非当前版本。`
          : `共 ${points.length} 个坐标点，均来自 ${activeVersion.version}，未出现口径冲突。`,
    },
  }
}

function conflictNoteOf(point: ChartDataPoint): string {
  return point.conflictNote || (point.conflict ? '多版本并存' : `仅 ${point.sourceVersion} 提供该坐标`)
}

function alternativeTextOf(point: ChartDataPoint): string {
  if (point.alternatives.length === 0) {
    return '无'
  }
  return point.alternatives
    .map((item) => `${item.sourceVersion}=${item.y}（差 ${item.delta}）`)
    .join('；')
}

function snapshotToDetailRows(snapshot: ChartDataSnapshot): ChartDataDetailRow[] {
  return snapshot.points.map((point) => ({
    snapshotVersion: snapshot.version,
    coordinate: point.x,
    xField: point.xField,
    y: point.y,
    yField: point.yField,
    datasetVersion: point.sourceVersion,
    sourceXField: point.sourceXField,
    sourceYField: point.sourceYField,
    rowCount: point.rowCount,
    conflictNote: conflictNoteOf(point),
    alternatives: alternativeTextOf(point),
  }))
}

function demoteOtherActive(
  snapshots: ChartDataSnapshot[],
  chartId: number,
  keepId: string | null,
  at: string,
): ChartDataSnapshot[] {
  return snapshots.map((snapshot) => {
    if (snapshot.chartId !== chartId) {
      return snapshot
    }
    if (snapshot.status !== 'active' || snapshot.id === keepId) {
      return snapshot
    }
    return { ...snapshot, status: 'superseded' as const, supersededAt: at }
  })
}

type BuildOptions = {
  /** 指定要读取的数据集版本，默认使用数据集的 currentRevision。 */
  revisionId?: string
  policy?: ChartConflictPolicy
}

/**
 * 刷新图表数据：读取数据集的当前源版本，聚合后生成快照。
 * 失败时不改动现有快照，并在返回结果里带上仍在生效的上一份完整快照。
 */
export function refreshChartSnapshot(
  reference: ChartReference,
  options: BuildOptions = {},
): ChartSnapshotBuildResult {
  const row = resolveChart(reference)
  if (!row) {
    return fail(`没有找到图表配置 ${String(reference)}`)
  }
  const chartId = Number(row.id)
  const previousActive = activeSnapshotFor(chartId)
  const dataset = datasetForRow(row)
  if (!dataset) {
    return fail(
      `图表 ${String(row[FIELD_CHART_NO] ?? chartId)} 的数据来源「${String(row[FIELD_DATA_SOURCE] ?? '')}」不是可用的图表数据集`,
      previousActive,
    )
  }
  const config = chartConfigFor(row, dataset)
  if (!config.xField) {
    return fail('图表配置缺少 X轴字段，无法按坐标维度聚合', previousActive)
  }
  if (!config.yField) {
    return fail('图表配置缺少 Y轴字段，无法聚合图表数据', previousActive)
  }
  // 配置字段必须落在数据集发布的逻辑字段口径上，否则构建出来的坐标轴没有意义。
  if (config.xField !== config.logicalXField || config.yField !== config.logicalYField) {
    return fail(
      `图表配置的坐标字段（${config.xField} / ${config.yField}）与数据集 ${dataset.id} 的字段口径（${config.logicalXField} / ${config.logicalYField}）不一致，无法生成图表数据快照`,
      previousActive,
    )
  }

  const revisionId = (options.revisionId ?? dataset.currentRevision).trim()
  const policy = options.policy ?? DEFAULT_POLICY
  const validation = validateRevision(dataset, revisionId, previousActive, config)
  if (!validation.ok) {
    return fail(
      `刷新失败：${validation.message}${previousActive ? `；已保留上一份完整快照 ${previousActive.id}` : ''}`,
      previousActive,
    )
  }

  const buildKey = buildKeyFor(chartId, config, revisionId, policy)
  const snapshots = allChartSnapshots()
  const existing = snapshots.find(
    (snapshot) => snapshot.chartId === chartId && snapshot.buildKey === buildKey,
  )
  if (existing) {
    if (existing.status === 'active') {
      return {
        ok: true,
        duplicate: true,
        message: `重复提交：${existing.id} 已是生效快照，未新增图表数据快照`,
        snapshot: existing,
        previous: null,
      }
    }
    const at = nowIso()
    const reactivated: ChartDataSnapshot = {
      ...existing,
      status: 'active',
      activatedAt: at,
      supersededAt: undefined,
    }
    const next = demoteOtherActive(snapshots, chartId, existing.id, at).map((snapshot) =>
      snapshot.id === existing.id ? reactivated : snapshot,
    )
    saveChartSnapshots(next)
    return {
      ok: true,
      reactivated: true,
      duplicate: true,
      message: `重复提交：复用已有图表数据快照 ${existing.id}，未追加新快照`,
      snapshot: reactivated,
      previous: previousActive && previousActive.id !== existing.id ? previousActive : null,
    }
  }

  const built = resolvePoints(validation.normalized, validation.activeVersion, policy)
  const nextVersionNumber =
    snapshots
      .filter((snapshot) => snapshot.chartId === chartId)
      .reduce((max, snapshot) => Math.max(max, snapshotVersionNumber(snapshot)), 0) + 1
  const version = `v${nextVersionNumber}`
  const chartNo = config.chartNo || String(chartId)
  const at = nowIso()
  const snapshot: ChartDataSnapshot = {
    id: `${chartNo}-${version}`,
    version,
    chartId,
    chartNo,
    chartName: config.chartName,
    chartType: config.chartType,
    datasetId: dataset.id,
    datasetName: dataset.name,
    xField: config.xField,
    yField: config.yField,
    aggregation: config.aggregation as ChartAggregation,
    conflictPolicy: policy,
    datasetVersions: validation.revision.versions.map((item) => item.version),
    sourceRevision: revisionId,
    configHash: hashConfig(config),
    buildKey,
    expectedCoordinateCount: built.points.length,
    status: 'active',
    points: built.points,
    createdAt: at,
    activatedAt: at,
    config,
    resolution: built.resolution,
  }

  const next = [...demoteOtherActive(snapshots, chartId, snapshot.id, at), snapshot]
  saveChartSnapshots(next)
  return {
    ok: true,
    created: true,
    message: `图表数据快照 ${snapshot.id} 已生成，${snapshot.points.length} 个坐标点，源版本 ${snapshot.sourceRevision}`,
    snapshot,
    previous: previousActive,
  }
}

/** 首次打开时按数据集的完整样例版本播种快照；已有快照不重建，保证持久一致。 */
export function ensureChartSnapshotsSeeded(): void {
  const rows = chartRows()
  for (const row of rows) {
    const chartId = Number(row.id)
    const snapshots = allChartSnapshots().filter((snapshot) => snapshot.chartId === chartId)
    if (snapshots.length > 0) {
      if (!snapshots.some((snapshot) => snapshot.status === 'active')) {
        const latest = [...snapshots].sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0]
        const at = nowIso()
        saveChartSnapshots(
          demoteOtherActive(allChartSnapshots(), chartId, latest.id, at).map((snapshot) =>
            snapshot.id === latest.id
              ? { ...snapshot, status: 'active' as const, activatedAt: at, supersededAt: undefined }
              : snapshot,
          ),
        )
      }
      continue
    }
    const dataset = datasetForRow(row)
    if (!dataset) {
      continue
    }
    // 播种只读完整发布过的版本，绝不读取当前可能正在发布中的源版本。
    refreshChartSnapshot(row, { revisionId: dataset.seedRevision })
  }
}

export function getActiveChartSnapshot(reference: ChartReference): ChartDataSnapshot | null {
  ensureChartSnapshotsSeeded()
  const row = resolveChart(reference)
  return row ? activeSnapshotFor(Number(row.id)) : null
}

export function listChartSnapshots(reference: ChartReference): ChartDataSnapshot[] {
  ensureChartSnapshotsSeeded()
  const row = resolveChart(reference)
  if (!row) {
    return []
  }
  return allChartSnapshots()
    .filter((snapshot) => snapshot.chartId === Number(row.id))
    .sort((a, b) => snapshotVersionNumber(b) - snapshotVersionNumber(a))
}

function isChartDataSnapshot(value: unknown): value is ChartDataSnapshot {
  return typeof value === 'object' && value !== null && Array.isArray((value as ChartDataSnapshot).points)
}

/** 图表数据核对：坐标点必须带着坐标字段、数据集版本，数量与生成时一致。 */
export function verifyChartSnapshot(
  reference: ChartReference | ChartDataSnapshot,
): ChartSnapshotVerification {
  let snapshot: ChartDataSnapshot | null
  let row: EntryRow | null
  if (isChartDataSnapshot(reference)) {
    snapshot = reference
    row = resolveChart(reference.chartNo)
  } else {
    row = resolveChart(reference)
    snapshot = row ? activeSnapshotFor(Number(row.id)) : null
  }
  if (!snapshot) {
    return {
      ok: false,
      configMatches: false,
      missingAxes: [FIELD_X, FIELD_Y],
      pointCount: 0,
      messages: ['没有可核对的图表数据快照'],
    }
  }
  const missingAxes: string[] = []
  const messages: string[] = []
  if (!snapshot.xField) {
    missingAxes.push(FIELD_X)
  }
  if (!snapshot.yField) {
    missingAxes.push(FIELD_Y)
  }
  const coordinates = new Set<string>()
  for (const point of snapshot.points) {
    if (!point.xField) {
      missingAxes.push(`坐标点 ${point.x} 的 ${FIELD_X}`)
    }
    if (!point.yField) {
      missingAxes.push(`坐标点 ${point.x} 的 ${FIELD_Y}`)
    }
    if (typeof point.y !== 'number' || !Number.isFinite(point.y)) {
      messages.push(`坐标点 ${point.x} 的 Y 值不可用`)
    }
    if (!point.sourceVersion) {
      messages.push(`坐标点 ${point.x} 缺少数据集版本`)
    }
    if (coordinates.has(point.x)) {
      messages.push(`坐标点 ${point.x} 重复出现`)
    }
    coordinates.add(point.x)
    if (point.conflict && point.alternatives.length === 0) {
      messages.push(`坐标点 ${point.x} 标记为口径冲突但没有保留备选结果`)
    }
  }
  if (snapshot.points.length !== snapshot.expectedCoordinateCount) {
    messages.push(
      `坐标点数量 ${snapshot.points.length} 与生成时记录的 ${snapshot.expectedCoordinateCount} 不一致`,
    )
  }
  const configMatches = row
    ? String(row[FIELD_X] ?? '').trim() === snapshot.config.xField &&
      String(row[FIELD_Y] ?? '').trim() === snapshot.config.yField &&
      String(row[FIELD_DATA_SOURCE] ?? '').trim() === snapshot.config.datasetId
    : false
  return {
    ok: missingAxes.length === 0 && messages.length === 0,
    configMatches,
    missingAxes,
    pointCount: snapshot.points.length,
    messages,
  }
}

export function getChartDataDetail(reference: ChartReference): ChartDataDetail | null {
  ensureChartSnapshotsSeeded()
  const row = resolveChart(reference)
  if (!row) {
    return null
  }
  const snapshot = activeSnapshotFor(Number(row.id))
  return {
    chart: row,
    snapshot,
    verification: verifyChartSnapshot(snapshot ?? row),
    pointRows: snapshot ? snapshotToDetailRows(snapshot) : [],
  }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出当前生效快照；文件内容与页面明细逐行一致，文件名带着同一个快照版本。 */
export function exportChartData(reference: ChartReference): ChartSnapshotExport {
  const detail = getChartDataDetail(reference)
  if (!detail) {
    return {
      ok: false,
      message: `没有找到图表配置 ${String(reference)}`,
      filename: '',
      content: '',
      snapshot: null,
    }
  }
  if (!detail.snapshot) {
    return {
      ok: false,
      message: '当前图表还没有生效的图表数据快照，请先生成图表数据',
      filename: '',
      content: '',
      snapshot: null,
    }
  }
  const lines = [EXPORT_HEADER.map(csvCell).join(',')]
  for (const row of detail.pointRows) {
    lines.push(
      [
        row.snapshotVersion,
        row.coordinate,
        row.xField,
        row.y,
        row.yField,
        row.datasetVersion,
        row.sourceXField,
        row.sourceYField,
        row.rowCount,
        row.conflictNote,
        row.alternatives,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return {
    ok: true,
    message: `已导出快照 ${detail.snapshot.id} 的 ${detail.pointRows.length} 个坐标点`,
    filename: `${detail.snapshot.chartNo}-${detail.snapshot.version}-图表数据.csv`,
    content: `﻿${lines.join('\n')}`,
    snapshot: detail.snapshot,
  }
}

export function downloadChartData(reference: ChartReference): ChartSnapshotExport {
  const payload = exportChartData(reference)
  if (!payload.ok) {
    return payload
  }
  const blob = new Blob([payload.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payload.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return payload
}

/** 报告模板里登记的图表按编号解析；预览只读快照，不重新读源数据。 */
export function previewReportCharts(templateReference: number | string | EntryRow): ReportChartPreview {
  ensureChartSnapshotsSeeded()
  const templates = listRows('reportgen')
  const template =
    typeof templateReference === 'object'
      ? templates.find((row) => Number(row.id) === Number(templateReference.id)) ?? null
      : templates.find(
          (row) =>
            Number(row.id) === Number(templateReference) ||
            String(row['模板编号'] ?? '').trim() === String(templateReference).trim(),
        ) ?? null
  if (!template) {
    return {
      charts: [],
      missing: [],
      complete: false,
      message: `没有找到报告模板 ${String(templateReference)}`,
    }
  }
  const raw = String(template['包含图表'] ?? '').trim()
  const tokens = raw.split(/[\s,，;；]+/).filter(Boolean)
  const charts: ReportChartPreviewItem[] = []
  const missing: string[] = []
  for (const token of tokens) {
    const row = resolveChart(token)
    if (!row) {
      missing.push(token)
      charts.push({
        chartNo: token,
        chartId: null,
        chartName: token,
        snapshot: null,
        pointRows: [],
        xField: '',
        yField: '',
        complete: false,
        messages: [`未找到图表配置 ${token}`],
      })
      continue
    }
    const snapshot = activeSnapshotFor(Number(row.id))
    const verification = verifyChartSnapshot(snapshot ?? row)
    if (!snapshot) {
      missing.push(token)
    }
    charts.push({
      chartNo: String(row[FIELD_CHART_NO] ?? token),
      chartId: Number(row.id),
      chartName: String(row[FIELD_CHART_NAME] ?? token),
      snapshot,
      pointRows: snapshot ? snapshotToDetailRows(snapshot) : [],
      xField: snapshot?.xField ?? '',
      yField: snapshot?.yField ?? '',
      complete: Boolean(snapshot) && verification.ok,
      messages: verification.messages,
    })
  }
  const complete = charts.length > 0 && missing.length === 0 && charts.every((item) => item.complete)
  return {
    charts,
    missing,
    complete,
    message: complete
      ? `报告预览完整，${charts.length} 张图表均按生效快照读取坐标点与坐标字段`
      : `报告预览不完整：${missing.length > 0 ? `缺少图表快照 ${missing.join('、')}` : '存在缺失坐标轴或未核对通过的图表'}`,
  }
}

/** 显式回退：把上一份完整快照重新置为对下游可见，用于人工纠错。 */
export function restorePreviousChartSnapshot(reference: ChartReference): ChartSnapshotBuildResult {
  const row = resolveChart(reference)
  if (!row) {
    return fail(`没有找到图表配置 ${String(reference)}`)
  }
  const chartId = Number(row.id)
  const current = activeSnapshotFor(chartId)
  const previous = previousSnapshotFor(chartId)
  if (!previous) {
    return fail('没有可恢复的上一份图表数据快照', current)
  }
  const verification = verifyChartSnapshot(previous)
  if (!verification.ok) {
    return fail(`上一份快照 ${previous.id} 未通过核对，不能恢复`, current)
  }
  const at = nowIso()
  const next = demoteOtherActive(allChartSnapshots(), chartId, previous.id, at).map((snapshot) =>
    snapshot.id === previous.id
      ? { ...snapshot, status: 'active' as const, activatedAt: at, supersededAt: undefined }
      : snapshot,
  )
  saveChartSnapshots(next)
  return {
    ok: true,
    message: `已恢复图表数据快照 ${previous.id}，${previous.points.length} 个坐标点`,
    snapshot: { ...previous, status: 'active', activatedAt: at, supersededAt: undefined },
    previous: current,
  }
}
