<script setup lang="ts">
import { computed } from 'vue'
import type { LocationNode } from '../nginx/types'

const props = defineProps<{
  node: LocationNode
  visitedIds: Set<number>
  finalId: number | null
  diagIds: Set<number>
}>()

const badgeClass = computed(() => {
  switch (props.node.modifier) {
    case '=':
      return 'exact'
    case '^~':
      return 'caret'
    case '~':
    case '~*':
      return 'regex'
    case '@':
      return 'named'
    default:
      return 'prefix'
  }
})

const badgeText = computed(() => {
  switch (props.node.modifier) {
    case '=':
      return '='
    case '^~':
      return '^~'
    case '~':
      return '~'
    case '~*':
      return '~*'
    case '@':
      return '@'
    default:
      return '前缀'
  }
})

const rowClass = computed(() => ({
  'hl-final': props.finalId === props.node.id,
  'hl-visited': props.finalId !== props.node.id && props.visitedIds.has(props.node.id),
  'hl-diag': props.diagIds.has(props.node.id),
}))
</script>

<template>
  <div class="loc-node">
    <div class="loc-row" :class="rowClass">
      <span class="badge" :class="badgeClass">{{ badgeText }}</span>
      <span class="pattern">{{ node.pattern }}</span>
      <span v-if="node.proxyPass" class="proxy">→ {{ node.proxyPass }}</span>
      <span v-if="node.regexError" class="proxy" style="color: var(--red)">正则无效</span>
      <span class="line-no">L{{ node.line }}</span>
    </div>
    <div v-if="node.children.length" class="loc-children">
      <LocationTreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :visited-ids="visitedIds"
        :final-id="finalId"
        :diag-ids="diagIds"
      />
    </div>
  </div>
</template>
