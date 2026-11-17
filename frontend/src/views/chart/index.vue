<template>
  <section class="page" data-module="chart">
    <header class="page-head">
      <div>
        <h2>可视化图表管理</h2>
        <p class="page-desc">维护可视化图表配置的输入、执行约束与结果记录，为图表展示提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记图表配置</button>
        <button class="btn" type="button" @click="exportRows">导出可视化图表清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无可视化图表数据，可先登记图表配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条可视化图表记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel snapshot-panel" data-testid="chart-snapshot-panel">
      <header class="panel-head">
        <div>
          <h3>图表数据快照</h3>
          <p class="panel-desc">
            按图表配置的 X 轴坐标聚合 Y 轴值；同一坐标点保留来源数据集版本与物理列名，快照未核对通过不替换生效版本。
          </p>
        </div>
        <div class="panel-actions">
          <label class="filter-item">
            <span>图表配置</span>
            <select v-model="selectedChartId" @change="loadSnapshot">
              <option v-for="row in rows" :key="String(row.id)" :value="Number(row.id)">
                {{ row["图表编号"] }} · {{ row["图表名称"] }}
              </option>
            </select>
          </label>
          <label class="filter-item">
            <span>口径取舍</span>
            <select v-model="refreshPolicy">
              <option value="prefer-active-version">优先新版本</option>
              <option value="prefer-previous-version">优先旧版本</option>
            </select>
          </label>
          <button class="btn primary" type="button" :disabled="selectedChartId === null" @click="refreshSnapshot">
            生成图表数据快照
          </button>
          <button class="btn" type="button" :disabled="!hasPrevious" @click="restoreSnapshot">
            恢复上一份完整快照
          </button>
          <button class="btn" type="button" :disabled="!detail || !detail.snapshot" @click="exportSnapshot">
            导出图表数据（同版本）
          </button>
        </div>
      </header>

      <p v-if="snapshotMessage" class="panel-note" :class="{ 'error-text': !snapshotOk }">
        {{ snapshotMessage }}
      </p>

      <template v-if="detail && detail.snapshot">
        <div class="snapshot-meta">
          <span>快照：{{ detail.snapshot.id }}</span>
          <span>状态：{{ detail.snapshot.status === 'active' ? '生效（下游唯一可见）' : '已替代' }}</span>
          <span>数据集：{{ detail.snapshot.datasetId }} · {{ detail.snapshot.datasetName }}</span>
          <span>坐标字段：{{ detail.snapshot.xField }} → {{ detail.snapshot.yField }}</span>
          <span>聚合方式：{{ detail.snapshot.aggregation === 'sum' ? '按坐标求和' : detail.snapshot.aggregation }}</span>
          <span>源版本：{{ detail.snapshot.sourceRevision }}</span>
          <span>输入版本：{{ detail.snapshot.datasetVersions.join(' / ') }}</span>
          <span>生成时间：{{ formatTime(detail.snapshot.activatedAt) }}</span>
        </div>

        <p class="panel-desc">{{ detail.snapshot.resolution.note }}</p>

        <table class="data-table snapshot-table" data-testid="chart-snapshot-points">
          <thead>
            <tr>
              <th>快照版本</th>
              <th>坐标点</th>
              <th>X轴字段</th>
              <th>Y值</th>
              <th>Y轴字段</th>
              <th>数据集版本</th>
              <th>源X列</th>
              <th>源Y列</th>
              <th>行数</th>
              <th>口径说明</th>
              <th>备选口径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="point in detail.pointRows" :key="`${point.snapshotVersion}-${point.coordinate}`">
              <td>{{ point.snapshotVersion }}</td>
              <td>{{ point.coordinate }}</td>
              <td>{{ point.xField }}</td>
              <td>{{ point.y }}</td>
              <td>{{ point.yField }}</td>
              <td>{{ point.datasetVersion }}</td>
              <td>{{ point.sourceXField }}</td>
              <td>{{ point.sourceYField }}</td>
              <td>{{ point.rowCount }}</td>
              <td>{{ point.conflictNote }}</td>
              <td>{{ point.alternatives }}</td>
            </tr>
            <tr v-if="!detail.pointRows.length">
              <td :colspan="11" class="empty-state">快照没有坐标点</td>
            </tr>
          </tbody>
        </table>

        <p class="verify-line" :class="detail.verification.ok ? 'verify-ok' : 'error-text'">
          {{
            detail.verification.ok
              ? `图表数据核对通过：${detail.verification.pointCount} 个坐标点均带坐标字段与数据集版本`
              : `图表数据核对未通过：${[...detail.verification.missingAxes, ...detail.verification.messages].join('；')}`
          }}
        </p>
      </template>
      <p v-else class="empty-state">该图表还没有生效的图表数据快照，点击「生成图表数据快照」按当前配置生成。</p>

      <div v-if="history.length" class="snapshot-history">
        <span class="history-title">快照记录（仅一份对下游可见）：</span>
        <span
          v-for="item in history"
          :key="item.id"
          class="legend-item"
          :class="item.status === 'active' ? 'history-active' : ''"
        >
          {{ item.id }} · {{ item.status === 'active' ? '生效' : '已替代' }} · {{ item.points.length }} 点 · {{ formatTime(item.activatedAt) }}
        </span>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadChartData,
  downloadEntries,
  getChartDataDetail,
  listChartSnapshots,
  listEntries,
  moduleMeta,
  refreshChartSnapshot,
  restorePreviousChartSnapshot,
  runAction as applyAction,
} from '@/api/local-service'
import type { ChartConflictPolicy, ChartDataDetail, ChartDataSnapshot, EntryRow } from '@/data/types'

const meta = moduleMeta('chart')
const columns = ["图表编号", "图表名称", "图表类型", "数据来源", "X轴字段", "Y轴字段", "配色方案", "刷新间隔秒"]
const actions = ["提交发布", "发布图表", "下线图表"]
const statuses = ["草稿", "待发布", "已发布", "已下线"]
const stats = [{"label": "图表配置总数", "value": 0}, {"label": "已发布图表", "value": 0}, {"label": "待发布图表", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selectedChartId = ref<number | null>(null)
const refreshPolicy = ref<ChartConflictPolicy>('prefer-active-version')
const detail = ref<ChartDataDetail | null>(null)
const history = ref<ChartDataSnapshot[]>([])
const snapshotMessage = ref('')
const snapshotOk = ref(true)

const hasPrevious = computed(() =>
  history.value.some((item) => item.status === 'superseded'),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '图表配置登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function loadSnapshot() {
  if (selectedChartId.value === null) {
    detail.value = null
    history.value = []
    return
  }
  detail.value = getChartDataDetail(selectedChartId.value)
  history.value = listChartSnapshots(selectedChartId.value)
}

function refreshSnapshot() {
  snapshotMessage.value = ''
  if (selectedChartId.value === null) {
    return
  }
  const result = refreshChartSnapshot(selectedChartId.value, { policy: refreshPolicy.value })
  snapshotOk.value = result.ok
  snapshotMessage.value = result.ok
    ? `${result.message}${result.duplicate ? '（重复提交未新增快照）' : ''}`
    : result.message
  loadSnapshot()
}

function restoreSnapshot() {
  snapshotMessage.value = ''
  if (selectedChartId.value === null) {
    return
  }
  const result = restorePreviousChartSnapshot(selectedChartId.value)
  snapshotOk.value = result.ok
  snapshotMessage.value = result.message
  loadSnapshot()
}

function exportSnapshot() {
  snapshotMessage.value = ''
  if (selectedChartId.value === null) {
    return
  }
  const result = downloadChartData(selectedChartId.value)
  snapshotOk.value = result.ok
  snapshotMessage.value = result.ok ? `${result.message}，文件 ${result.filename}` : result.message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selectedChartId.value === null || !rows.value.some((row) => Number(row.id) === selectedChartId.value)) {
      // 默认选已发布的图表，快照面板对着的就是下游正在用的那张。
      const published = rows.value.find((row) => String(row.status) === '已发布') ?? rows.value[0]
      selectedChartId.value = published ? Number(published.id) : null
    }
    loadSnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '可视化图表列表读取失败'
  }
}

onMounted(reload)
</script>
