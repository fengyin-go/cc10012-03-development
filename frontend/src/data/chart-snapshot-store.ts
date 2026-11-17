import type { ChartDataSnapshot } from './types'

/**
 * 图表数据快照的本地持久化。
 *
 * 和业务条目分开存：快照是「某一版图表配置 + 某一版源数据」的不可变结果，
 * 关掉浏览器再打开必须还是同一份，不能跟着列表页的临时状态一起丢。
 */
const STORAGE_KEY = 'data-explore-studio:chart-snapshots'

type ChartSnapshotState = {
  snapshots: ChartDataSnapshot[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): ChartSnapshotState {
  return { snapshots: [] }
}

function readStorage(): ChartSnapshotState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as ChartSnapshotState
    return Array.isArray(parsed.snapshots) ? { snapshots: parsed.snapshots } : emptyState()
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return emptyState()
  }
}

let cache: ChartSnapshotState | null = null

export function allChartSnapshots(): ChartDataSnapshot[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.snapshots
}

export function saveChartSnapshots(snapshots: ChartDataSnapshot[]): void {
  const next = { snapshots: clone(snapshots) }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetChartSnapshots(): void {
  cache = emptyState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}
