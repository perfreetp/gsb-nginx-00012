<script setup lang="ts">
import type { LocationNode } from '../core/types'

defineProps<{
  locations: LocationNode[]
  matchedId?: string
  pathIds: Set<string>
  focusId?: string
  issueIds: Set<string>
}>()

function label(loc: LocationNode): string {
  if (loc.modifier === 'prefix') return loc.pattern
  return `${loc.modifier} ${loc.pattern}`
}
</script>

<template>
  <div class="tree">
    <div v-for="loc in locations" :key="loc.id" class="tree-node">
      <div
        class="node-row"
        :class="{
          matched: loc.id === matchedId,
          'in-path': pathIds.has(loc.id) && loc.id !== matchedId,
          'step-focus': loc.id === focusId,
          'has-issue': issueIds.has(loc.id),
        }"
      >
        <span v-if="loc.modifier !== 'prefix'" class="tag mod">{{ loc.modifier }}</span>
        <span v-else class="tag mod">前缀</span>
        <span>{{ label(loc) }}</span>
        <span class="node-meta">L{{ loc.line }}</span>
        <span v-if="loc.proxyPass" class="tag proxy">proxy_pass → {{ loc.proxyPass }}</span>
        <span v-if="issueIds.has(loc.id)" class="tag issue">!</span>
      </div>
      <div v-if="loc.children.length" class="node-children">
        <LocationTree
          :locations="loc.children"
          :matched-id="matchedId"
          :path-ids="pathIds"
          :focus-id="focusId"
          :issue-ids="issueIds"
        />
      </div>
    </div>
  </div>
</template>
