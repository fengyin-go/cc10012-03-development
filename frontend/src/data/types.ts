/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 图表数据快照：把图表配置里的坐标字段落成可复用、可追溯的数据结果。 */

export type ChartAggregation = 'sum'

export type ChartConflictPolicy = 'prefer-active-version' | 'prefer-previous-version'

export type ChartPointAlternative = {
  y: number
  sourceVersion: string
  sourceXField: string
  sourceYField: string
  rowCount: number
  /** 当前选中的值减去这份备选值，用于人工比较两份都成立的口径。 */
  delta: number
}

export type ChartDataPoint = {
  /** 坐标点值，对应图表 X 轴。 */
  x: string
  /** 按坐标聚合后的 Y 轴值。 */
  y: number
  /** 图表配置里的 X 轴字段。 */
  xField: string
  /** 图表配置里的 Y 轴字段。 */
  yField: string
  /** 这个坐标点实际取自哪个数据集版本。 */
  sourceVersion: string
  /** 该版本实际读取的列名，换版期间可能和配置字段名不同。 */
  sourceXField: string
  sourceYField: string
  rowCount: number
  conflict: boolean
  /** 多版本并存时写清取舍依据，页面明细与导出行共用这句说明。 */
  conflictNote: string
  /** 该坐标点的值取自哪个版本口径。 */
  selectedReason: 'active-version' | 'previous-version'
  alternatives: ChartPointAlternative[]
}

export type ChartSnapshotConfig = {
  chartNo: string
  chartName: string
  chartType: string
  datasetId: string
  datasetName: string
  /** 图表配置里登记的 X 轴字段（坐标字段）。 */
  xField: string
  /** 图表配置里登记的 Y 轴字段（聚合字段）。 */
  yField: string
  /** 数据集发布时的逻辑字段口径，用于确认配置字段确实落在数据集上。 */
  logicalXField: string
  logicalYField: string
  palette: string
  refreshInterval: string
  aggregation: ChartAggregation
}

export type ChartSnapshotStatus = 'active' | 'superseded'

export type ChartSnapshotResolution = {
  coordinateCount: number
  conflictCount: number
  fallbackCount: number
  policy: ChartConflictPolicy
  note: string
}

export type ChartDataSnapshot = {
  id: string
  version: string
  chartId: number
  chartNo: string
  chartName: string
  chartType: string
  datasetId: string
  datasetName: string
  xField: string
  yField: string
  aggregation: ChartAggregation
  conflictPolicy: ChartConflictPolicy
  datasetVersions: string[]
  sourceRevision: string
  configHash: string
  /** 同一份配置 + 同一份源数据只对应一个快照，用于重复提交去重。 */
  buildKey: string
  /** 生成快照时的坐标点总数，缺一个坐标点就不算完整。 */
  expectedCoordinateCount: number
  status: ChartSnapshotStatus
  points: ChartDataPoint[]
  createdAt: string
  activatedAt: string
  supersededAt?: string
  config: ChartSnapshotConfig
  resolution: ChartSnapshotResolution
}

export type ChartSnapshotBuildResult = {
  ok: boolean
  message: string
  snapshot?: ChartDataSnapshot
  previous?: ChartDataSnapshot | null
  duplicate?: boolean
  reactivated?: boolean
  created?: boolean
}

export type ChartSnapshotVerification = {
  ok: boolean
  configMatches: boolean
  missingAxes: string[]
  pointCount: number
  messages: string[]
}

export type ChartDataDetailRow = {
  snapshotVersion: string
  coordinate: string
  xField: string
  y: number
  yField: string
  datasetVersion: string
  sourceXField: string
  sourceYField: string
  rowCount: number
  conflictNote: string
  alternatives: string
}

export type ChartDataDetail = {
  chart: EntryRow
  snapshot: ChartDataSnapshot | null
  verification: ChartSnapshotVerification
  pointRows: ChartDataDetailRow[]
}

export type ChartSnapshotExport = {
  ok: boolean
  message: string
  filename: string
  content: string
  snapshot: ChartDataSnapshot | null
}

export type ReportChartPreviewItem = {
  chartNo: string
  chartId: number | null
  chartName: string
  snapshot: ChartDataSnapshot | null
  pointRows: ChartDataDetailRow[]
  xField: string
  yField: string
  complete: boolean
  messages: string[]
}

export type ReportChartPreview = {
  charts: ReportChartPreviewItem[]
  missing: string[]
  complete: boolean
  message: string
}
