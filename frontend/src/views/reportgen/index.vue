<template>
  <section class="page" data-module="reportgen">
    <header class="page-head">
      <div>
        <h2>报告生成管理</h2>
        <p class="page-desc">维护分析报告模板的输入、执行约束与结果记录，为报告生成提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记报告模板</button>
        <button class="btn" type="button" @click="exportRows">导出报告生成清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无报告生成数据，可先登记报告模板</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条报告生成记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel" data-testid="report-chart-preview">
      <header class="panel-head">
        <div>
          <h3>报告图表预览</h3>
          <p class="panel-desc">
            预览只读图表数据快照，不重新读源数据；每张图表都必须带齐 X/Y 轴坐标点，缺坐标即视为预览不完整。
          </p>
        </div>
        <div class="panel-actions">
          <label class="filter-item">
            <span>报告模板</span>
            <select v-model="selectedTemplateId" @change="loadPreview">
              <option v-for="row in rows" :key="String(row.id)" :value="Number(row.id)">
                {{ row["模板编号"] }} · {{ row["模板名称"] }}
              </option>
            </select>
          </label>
        </div>
      </header>

      <p v-if="preview" class="panel-note" :class="preview.complete ? 'verify-ok' : 'error-text'">
        {{ preview.message }}
      </p>

      <template v-if="preview">
        <article v-for="chart in preview.charts" :key="chart.chartNo" class="report-chart">
          <h4>{{ chart.chartNo }} · {{ chart.chartName }}</h4>
          <p class="panel-desc">
            快照：{{ chart.snapshot ? `${chart.snapshot.id}（${chart.snapshot.status === 'active' ? '生效' : '已替代'}）` : '缺失' }}
            · 坐标字段：{{ chart.xField || '—' }} → {{ chart.yField || '—' }}
          </p>
          <table v-if="chart.pointRows.length" class="data-table">
            <thead>
              <tr>
                <th>坐标点</th>
                <th>X轴字段</th>
                <th>Y值</th>
                <th>Y轴字段</th>
                <th>数据集版本</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="point in chart.pointRows" :key="`${chart.chartNo}-${point.coordinate}`">
                <td>{{ point.coordinate }}</td>
                <td>{{ point.xField }}</td>
                <td>{{ point.y }}</td>
                <td>{{ point.yField }}</td>
                <td>{{ point.datasetVersion }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty-state">该图表没有可预览的坐标点</p>
          <p v-if="chart.messages.length" class="error-text panel-note">{{ chart.messages.join('；') }}</p>
        </article>
      </template>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  previewReportCharts,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, ReportChartPreview } from '@/data/types'

const meta = moduleMeta('reportgen')
const columns = ["模板编号", "模板名称", "包含图表", "报告周期", "导出格式", "推送渠道", "水印开关", "附件压缩"]
const actions = ["提交审核", "生效发布", "停用模板"]
const statuses = ["草稿", "待审核", "已生效", "已停用"]
const stats = [{"label": "报告模板总数", "value": 0}, {"label": "已生效模板", "value": 0}, {"label": "待审核模板", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedTemplateId = ref<number | null>(null)
const preview = ref<ReportChartPreview | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function loadPreview() {
  preview.value =
    selectedTemplateId.value === null ? null : previewReportCharts(selectedTemplateId.value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '报告模板登记入口尚未接入审批流'
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (
      selectedTemplateId.value === null ||
      !rows.value.some((row) => Number(row.id) === selectedTemplateId.value)
    ) {
      // 默认选已生效的模板，报告预览看的应该是下游真正会用到的那份。
      const effective = rows.value.find((row) => String(row.status) === '已生效') ?? rows.value[0]
      selectedTemplateId.value = effective ? Number(effective.id) : null
    }
    loadPreview()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报告生成列表读取失败'
  }
}

onMounted(reload)
</script>
