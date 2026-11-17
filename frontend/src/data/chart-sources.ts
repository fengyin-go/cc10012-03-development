/**
 * 图表的目标数据集源数据。
 *
 * 这里刻意保留了「数据源换版」的真实形态：同一个版本里同时存在旧列批次和新列批次，
 * 两条记录可以落在同一个坐标点上。图表数据构建不能简单按坐标覆盖，而要保留每个坐标
 * 对应的来源版本与物理列名，供上层比较口径后再取舍。
 */

export type DatasetVersionRow = {
  coordinate: string
  value: number | null
}

export type DatasetVersion = {
  /** 数据集版本号，例如 v2026.09.15。 */
  version: string
  label: string
  xColumn: string
  yColumn: string
  releasedAt: string
  rows: DatasetVersionRow[]
}

/** 同一份数据集快照可能包含多个版本：换版期间新列与旧列并行发布。 */
export type DatasetRevision = {
  revision: string
  status: 'healthy' | 'failed'
  failureReason?: string
  publishedAt: string
  activeVersion: string
  previousVersion?: string
  versions: DatasetVersion[]
}

export type ChartDataset = {
  id: string
  name: string
  /** 图表配置里的逻辑 X/Y 轴字段，对应数据集发布时的字段口径。 */
  logicalXField: string
  logicalYField: string
  aggregation: 'sum'
  /** 首次播种图表数据快照时使用的版本（已完整发布）。 */
  seedRevision: string
  /** 点击刷新时读取的源版本；它可能处于发布不完整状态。 */
  currentRevision: string
  revisions: Record<string, DatasetRevision>
}

const SALES_OLD: DatasetVersion = {
  version: 'v2026.08.01',
  label: '旧列批次（地区 / 销售额）',
  xColumn: '地区',
  yColumn: '销售额',
  releasedAt: '2026-08-01T02:00:00.000Z',
  rows: [
    { coordinate: '华东', value: 700 },
    { coordinate: '华东', value: 500 },
    { coordinate: '华北', value: 980 },
    { coordinate: '华南', value: 1500 },
    { coordinate: '西南', value: 760 },
  ],
}

const SALES_NEW: DatasetVersion = {
  version: 'v2026.09.15',
  label: '新列批次（area_name / gmv）',
  xColumn: 'area_name',
  yColumn: 'gmv',
  releasedAt: '2026-09-15T02:00:00.000Z',
  rows: [
    { coordinate: '华东', value: 800 },
    { coordinate: '华东', value: 520 },
    { coordinate: '华北', value: 1040 },
    { coordinate: '华南', value: 1500 },
    { coordinate: '华中', value: 890 },
  ],
}

const CHANNEL_OLD: DatasetVersion = {
  version: 'v2026.08.20',
  label: '旧列批次（渠道 / 线索数）',
  xColumn: '渠道',
  yColumn: '线索数',
  releasedAt: '2026-08-20T02:00:00.000Z',
  rows: [
    { coordinate: '官网', value: 200 },
    { coordinate: '官网', value: 120 },
    { coordinate: '门店', value: 210 },
    { coordinate: '电话', value: 150 },
  ],
}

const CHANNEL_NEW: DatasetVersion = {
  version: 'v2026.09.12',
  label: '新列批次（channel_name / lead_count）',
  xColumn: 'channel_name',
  yColumn: 'lead_count',
  releasedAt: '2026-09-12T02:00:00.000Z',
  rows: [
    { coordinate: '官网', value: 210 },
    { coordinate: '官网', value: 150 },
    { coordinate: '门店', value: 190 },
    { coordinate: '直播', value: 120 },
  ],
}

const TRAFFIC: DatasetVersion = {
  version: 'v2026.09.20',
  label: '稳定批次（日期 / 访问量）',
  xColumn: '日期',
  yColumn: '访问量',
  releasedAt: '2026-09-20T02:00:00.000Z',
  rows: [
    { coordinate: '2026-09-01', value: 4200 },
    { coordinate: '2026-09-02', value: 3900 },
    { coordinate: '2026-09-03', value: 5100 },
  ],
}

export const CHART_DATASETS: ChartDataset[] = [
  {
    id: 'DS-SALES-001',
    name: '区域销售数据集',
    logicalXField: '地区',
    logicalYField: '销售额',
    aggregation: 'sum',
    seedRevision: 'rev-2026.09.15',
    currentRevision: 'rev-2026.09.30',
    revisions: {
      'rev-2026.08.01': {
        revision: 'rev-2026.08.01',
        status: 'healthy',
        publishedAt: '2026-08-01T02:30:00.000Z',
        activeVersion: SALES_OLD.version,
        versions: [SALES_OLD],
      },
      'rev-2026.09.15': {
        revision: 'rev-2026.09.15',
        status: 'healthy',
        publishedAt: '2026-09-15T02:30:00.000Z',
        activeVersion: SALES_NEW.version,
        previousVersion: SALES_OLD.version,
        versions: [SALES_OLD, SALES_NEW],
      },
      // 这次刷新只发布了部分坐标：gmv 有缺失，西南/华中整块没来。
      // 构建时会整体拒绝，上一份完整快照继续对下游可见。
      'rev-2026.09.30': {
        revision: 'rev-2026.09.30',
        status: 'failed',
        failureReason:
          '源版本 rev-2026.09.30 只发布了 3 个坐标点，西南/华中缺失，华北的 gmv 为空值',
        publishedAt: '2026-09-30T02:30:00.000Z',
        activeVersion: 'v2026.09.30',
        previousVersion: SALES_NEW.version,
        versions: [
          {
            version: 'v2026.09.30',
            label: '半次刷新批次（gmv 不完整）',
            xColumn: 'area_name',
            yColumn: 'gmv',
            releasedAt: '2026-09-30T02:00:00.000Z',
            rows: [
              { coordinate: '华东', value: 900 },
              { coordinate: '华东', value: 500 },
              { coordinate: '华北', value: null },
              { coordinate: '华南', value: 1510 },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'DS-CHANNEL-002',
    name: '渠道线索数据集',
    logicalXField: '渠道',
    logicalYField: '线索数',
    aggregation: 'sum',
    seedRevision: 'rev-2026.09.12',
    currentRevision: 'rev-2026.09.12',
    revisions: {
      'rev-2026.08.20': {
        revision: 'rev-2026.08.20',
        status: 'healthy',
        publishedAt: '2026-08-20T02:30:00.000Z',
        activeVersion: CHANNEL_OLD.version,
        versions: [CHANNEL_OLD],
      },
      'rev-2026.09.12': {
        revision: 'rev-2026.09.12',
        status: 'healthy',
        publishedAt: '2026-09-12T02:30:00.000Z',
        activeVersion: CHANNEL_NEW.version,
        previousVersion: CHANNEL_OLD.version,
        versions: [CHANNEL_OLD, CHANNEL_NEW],
      },
    },
  },
  {
    id: 'DS-TRAFFIC-003',
    name: '站点访问数据集',
    logicalXField: '日期',
    logicalYField: '访问量',
    aggregation: 'sum',
    seedRevision: 'rev-2026.09.20',
    currentRevision: 'rev-2026.09.20',
    revisions: {
      'rev-2026.09.20': {
        revision: 'rev-2026.09.20',
        status: 'healthy',
        publishedAt: '2026-09-20T02:30:00.000Z',
        activeVersion: TRAFFIC.version,
        versions: [TRAFFIC],
      },
    },
  },
]

export const CHART_DATASET_BY_ID: Map<string, ChartDataset> = new Map(
  CHART_DATASETS.map((dataset) => [dataset.id, dataset]),
)

export function findChartDataset(datasetId: string): ChartDataset | undefined {
  return CHART_DATASET_BY_ID.get(datasetId)
}

export function findDatasetRevision(
  dataset: ChartDataset,
  revisionId: string,
): DatasetRevision | undefined {
  return dataset.revisions[revisionId]
}

export function findDatasetVersion(
  revision: DatasetRevision,
  versionId: string,
): DatasetVersion | undefined {
  return revision.versions.find((version) => version.version === versionId)
}
