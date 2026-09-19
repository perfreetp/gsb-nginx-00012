<script setup lang="ts">
import { computed, ref } from 'vue'
import { parseNginxConfig } from './core/parser'
import { matchUrl } from './core/matcher'
import { analyzeConfig } from './core/analyzer'
import type { LocationNode, ServerBlock } from './core/types'
import LocationTree from './components/LocationTree.vue'

const SAMPLE = `upstream backend {
    server 127.0.0.1:8080 weight=3;
    server 127.0.0.1:8081;
}

server {
    listen 80;
    server_name example.com www.example.com;

    location = / {
        proxy_pass http://backend;
    }

    location / {
        proxy_pass http://backend;
    }

    location /api/ {
        proxy_pass http://backend;

        location /api/v1/ {
            proxy_pass http://127.0.0.1:9000;
        }

        location ~ \\.php$ {
            proxy_pass http://127.0.0.1:9001;
        }
    }

    location ^~ /static/ {
        root /var/www;
    }

    location ~* \\.(gif|jpg|png)$ {
        root /data/images;
    }
}
`

const source = ref(SAMPLE)
const url = ref('http://example.com/api/v1/users')
const activeTab = ref<'match' | 'tree' | 'diag'>('match')
const focusId = ref<string | undefined>(undefined)

const config = computed(() => parseNginxConfig(source.value))
const diagnostics = computed(() => analyzeConfig(config.value))
const matchResult = computed(() => matchUrl(config.value, url.value))

const issueIds = computed(() => {
  const set = new Set<string>()
  for (const d of diagnostics.value) if (d.locationId) set.add(d.locationId)
  return set
})

/** 计算最终命中 location 的祖先链（用于高亮整个匹配路径） */
const matchedPathIds = computed(() => {
  const set = new Set<string>()
  const target = matchResult.value.location
  if (!target) return set
  const dfs = (locs: LocationNode[], trail: LocationNode[]): boolean => {
    for (const loc of locs) {
      if (loc.id === target.id) {
        for (const n of trail) set.add(n.id)
        set.add(loc.id)
        return true
      }
      if (dfs(loc.children, [...trail, loc])) return true
    }
    return false
  }
  for (const server of config.value.servers) dfs(server.locations, [])
  return set
})

const matchedId = computed(() => matchResult.value.location?.id)

const diagCount = computed(() => diagnostics.value.filter((d) => d.level !== 'info').length)

function serverLabel(server: ServerBlock, index: number): string {
  const names = server.serverNames.length ? server.serverNames.join(' ') : '_'
  const listen = server.listen.length ? server.listen.join(', ') : '(未配置 listen)'
  return `server #${index + 1}  listen ${listen}  server_name ${names}`
}

function loadSample() {
  source.value = SAMPLE
}
</script>

<template>
  <header class="app-header">
    <h1>Nginx 配置可视化分析器</h1>
    <span>解析 server / location / upstream / proxy_pass，按真实 Nginx 优先级模拟匹配</span>
  </header>

  <div class="layout">
    <div class="panel">
      <div class="panel-title">
        <span>nginx.conf</span>
        <button class="btn" @click="loadSample">载入示例</button>
      </div>
      <textarea v-model="source" class="editor" spellcheck="false" placeholder="在此粘贴 Nginx 配置..."></textarea>
    </div>

    <div class="panel">
      <div class="tabs">
        <button :class="{ active: activeTab === 'match' }" @click="activeTab = 'match'">URL 匹配</button>
        <button :class="{ active: activeTab === 'tree' }" @click="activeTab = 'tree'">结构化视图</button>
        <button :class="{ active: activeTab === 'diag' }" @click="activeTab = 'diag'">
          诊断<span v-if="diagCount" class="badge">{{ diagCount }}</span>
        </button>
      </div>

      <div class="tab-body" v-if="activeTab === 'match'">
        <div class="match-bar">
          <input v-model="url" placeholder="输入完整 URL 或路径，如 http://example.com/api/v1/users" />
        </div>

        <div class="result-banner" :class="matchResult.matched ? 'hit' : 'miss'">
          <template v-if="matchResult.matched && matchResult.location">
            最终命中：
            <code>
              location
              {{ matchResult.location.modifier === 'prefix' ? '' : matchResult.location.modifier + ' ' }}
              {{ matchResult.location.pattern }}
            </code>
            （第 {{ matchResult.location.line }} 行）
            <template v-if="matchResult.proxyPass">
              ，代理到 <code>{{ matchResult.proxyPass }}</code>
            </template>
          </template>
          <template v-else>未命中任何 location，请求将由 server 级配置处理</template>
        </div>

        <div class="steps">
          <div
            v-for="(step, i) in matchResult.steps"
            :key="i"
            class="step"
            :class="step.outcome"
            :style="{ marginLeft: step.depth * 14 + 'px' }"
            @mouseenter="focusId = step.locationId"
            @mouseleave="focusId = undefined"
          >
            <span class="dot"></span>
            <span>{{ step.text }}</span>
          </div>
        </div>
      </div>

      <div class="tab-body" v-else-if="activeTab === 'tree'">
        <div v-if="config.upstreams.length" style="margin-bottom: 14px">
          <div v-for="up in config.upstreams" :key="up.id" class="tree-node">
            <div class="node-row">
              <span class="tag upstream">upstream</span>
              <span>{{ up.name }}</span>
              <span class="node-meta">L{{ up.line }}</span>
            </div>
            <div class="node-children">
              <div v-for="(s, i) in up.servers" :key="i" class="node-row">
                <span class="node-meta">server {{ s.addr }} {{ s.params.join(' ') }}</span>
              </div>
              <div v-if="!up.servers.length" class="node-row">
                <span class="node-meta">（无后端 server）</span>
              </div>
            </div>
          </div>
        </div>

        <div v-for="(server, i) in config.servers" :key="server.id" class="tree-node" style="margin-bottom: 14px">
          <div class="node-row">
            <span class="tag server">server</span>
            <span class="node-meta">{{ serverLabel(server, i) }}</span>
          </div>
          <div class="node-children">
            <LocationTree
              :locations="server.locations"
              :matched-id="matchedId"
              :path-ids="matchedPathIds"
              :focus-id="focusId"
              :issue-ids="issueIds"
            />
            <div v-if="!server.locations.length" class="node-row">
              <span class="node-meta">（无 location）</span>
            </div>
          </div>
        </div>

        <div v-if="!config.servers.length && !config.upstreams.length" class="empty">
          未解析到 server 或 upstream 块，请在左侧输入配置
        </div>
      </div>

      <div class="tab-body" v-else>
        <div v-if="!diagnostics.length" class="empty">未发现问题 ✓</div>
        <div v-for="(d, i) in diagnostics" :key="i" class="diag" :class="d.level">
          <span class="level">{{ d.level === 'error' ? '错误' : d.level === 'warning' ? '警告' : '提示' }}</span>
          <span class="line">L{{ d.line }}</span>
          <span>{{ d.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
