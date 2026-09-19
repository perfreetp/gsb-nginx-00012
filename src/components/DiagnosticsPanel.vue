<script setup lang="ts">
import type { Diagnostic } from '../nginx/diagnostics'

defineProps<{ diagnostics: Diagnostic[] }>()
const emit = defineEmits<{ (e: 'hover', ids: number[]): void }>()

const sevText: Record<string, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
}
</script>

<template>
  <div>
    <div v-if="diagnostics.length === 0" class="diag-empty">✓ 未发现问题，配置看起来很健康</div>
    <div
      v-for="(diag, i) in diagnostics"
      :key="i"
      class="diag-item"
      @mouseenter="emit('hover', diag.locationIds)"
      @mouseleave="emit('hover', [])"
    >
      <span class="sev" :class="diag.severity">{{ sevText[diag.severity] }}</span>
      <div>
        <div class="diag-title">
          {{ diag.title }} <span class="diag-line">第 {{ diag.line }} 行</span>
        </div>
        <div class="diag-detail">{{ diag.detail }}</div>
      </div>
    </div>
  </div>
</template>
