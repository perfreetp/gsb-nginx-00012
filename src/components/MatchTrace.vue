<script setup lang="ts">
import type { MatchStep } from '../nginx/types'

defineProps<{ steps: MatchStep[] }>()

function stepClass(step: MatchStep): string {
  const classes = ['trace-step', `kind-${step.kind}`]
  if (step.result) classes.push(`r-${step.result}`)
  return classes.join(' ')
}
</script>

<template>
  <div class="trace-list">
    <div v-for="(step, i) in steps" :key="i" :class="stepClass(step)">
      {{ step.message }}
    </div>
  </div>
</template>
