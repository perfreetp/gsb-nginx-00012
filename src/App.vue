<script setup lang="ts">
import { computed, ref } from 'vue'
import { parseNginxConfig } from './nginx/parser'
import { matchUrl } from './nginx/matcher'
import { analyzeConfig } from './nginx/diagnostics'
import LocationTreeNode from './components/LocationTreeNode.vue'
import MatchTrace from './components/MatchTrace.vue'
import DiagnosticsPanel from './components/DiagnosticsPanel.vue'

const SAMPLE = `# Nginx 配置示例：覆盖 = / 前缀 / ^~ / 正则 / 嵌套 location
upstream backend_api {
    server 10.0.0.11:8080 weight=3;
    server 10.0.0.12:8080;
    server 10.0.0.13:8080 backup;
}

upstream static_cdn {
    server 10.0.1.5:80;
}

http {
    server {
        listen 80;
        server_name example.com;

        # 精确匹配：优先级最高
        location = /healthz {
            proxy_pass http://backend_api;
        }

        # 普通前缀匹配
        location / {
            proxy_pass http://backend_api;
        }

        # 嵌套 location
        location /api/ {
            proxy_pass http://backend_api;

            location /api/admin/ {
                proxy_pass http://10.0.9.1:9000;

                location = /api/admin/status {
                    proxy_pass http://10.0.9.2:9000;
                }
            }

            location ~* \\.php$ {
                proxy_pass http://10.0.9.3:9000;
            }
        }

        # ^~ 前缀：命中后跳过正则检查
        location ^~ /static/ {
            proxy_pass http://static_cdn;
        }

        # 正则匹配：按书写顺序
        location ~ \\.(gif|jpg|png)$ {
            proxy_pass http://static_cdn;
        }

        location ~* /download/ {
            proxy_pass http://backend_api;
        }
    }
}
`

const configText = ref(SAMPLE)
const urlText = ref('http://example.com/api/admin/status')

const config = computed(() => parseNginxConfig(configText.value))
const diagnostics = computed(() => analyzeConfig(config.value))
const match = computed(() => matchUrl(config.value, urlText.value))

const hoveredDiagIds = ref<Set<number>>(new Set())

const visitedIds = computed(() => {
  const ids = new Set<number>()
  for (const step of match.value.steps) {
    if (step.locationId !== undefined) ids.add(step.locationId)
  }
  return ids
})

const finalId = computed(() => {
  const chain = match.value.chain
  return chain.length > 0 ? chain[chain.length - 1].id : null
})

const diagIds = computed(() => {
  const ids = new Set<number>(hoveredDiagIds.value)
  return ids
})

function locLabel(modifier: string, pattern: string): string {
  if (modifier === '@') return pattern
  return modifier ? `${modifier} ${pattern}` : pattern
}

function onDiagHover(ids: number[]): void {
  hoveredDiagIds.value = new Set(ids)
}

function loadSample(): void {
  configText.value = SAMPLE
}
</script>

<template>
  <header class="app-header">
    <h1>Nginx 配置可视化分析器</h1>
    <span class="sub">解析 server / location / upstream / proxy_pass · 真实 location 匹配优先级 · 冲突与不可达规则检测</span>
  </header>

  <div class="layout">
    <!-- 左：配置编辑器 -->
    <div class="panel">
      <div class="panel-title">
        <span>Nginx 配置</span>
        <span style="flex: 1"></span>
        <button class="btn ghost" @click="loadSample">载入示例</button>
      </div>
      <textarea
        v-model="configText"
        class="config-editor"
        spellcheck="false"
        placeholder="在此粘贴 nginx.conf 内容…"
      ></textarea>
    </div>

    <!-- 右：分析结果 -->
    <div class="right-col">
      <!-- URL 匹配测试 -->
      <div class="panel">
        <div class="panel-title">URL 匹配测试</div>
        <div class="panel-body">
          <div class="url-bar">
            <input v-model="urlText" placeholder="输入任意 URL，如 http://example.com/api/admin/status" spellcheck="false" />
          </div>

          <div class="match-summary">
            <div class="kv">
              <span class="k">匹配路径</span>
              <span class="v">{{ match.path }}</span>
            </div>
            <div class="kv">
              <span class="k">命中链</span>
              <span class="v" v-if="match.chain.length">
                <span
                  v-for="(loc, i) in match.chain"
                  :key="loc.id"
                  class="chain-chip"
                  :class="{ final: i === match.chain.length - 1 }"
                >{{ locLabel(loc.modifier, loc.pattern) }}</span>
              </span>
              <span class="v" v-else style="color: var(--red)">无命中（使用 server 默认处理）</span>
            </div>
            <div class="kv" v-if="match.effectiveProxyPass">
              <span class="k">生效 proxy_pass</span>
              <span class="v" style="color: var(--green)">{{ match.effectiveProxyPass }}</span>
            </div>
            <div class="kv" v-if="match.upstream">
              <span class="k">upstream 节点</span>
              <span class="v">
                <span v-for="srv in match.upstream.servers" :key="srv.id" class="chain-chip">
                  {{ srv.address }}{{ srv.params.length ? ' (' + srv.params.join(' ') + ')' : '' }}
                </span>
              </span>
            </div>
          </div>

          <div style="margin-top: 12px">
            <MatchTrace :steps="match.steps" />
          </div>
        </div>
      </div>

      <!-- 结构树 -->
      <div class="panel">
        <div class="panel-title">
          <span>路由结构</span>
          <span style="flex: 1"></span>
          <span class="legend">
            <span class="badge exact">=</span>精确
            <span class="badge prefix">前缀</span>普通
            <span class="badge caret">^~</span>跳正则
            <span class="badge regex">~</span>正则
          </span>
        </div>
        <div class="panel-body">
          <div v-if="config.servers.length === 0 && config.upstreams.length === 0" class="diag-empty">
            未解析到 server / upstream 块，请检查配置
          </div>

          <div v-for="server in config.servers" :key="server.id" class="server-block">
            <div class="blk-head">
              <span class="tag">server</span>
              <span v-if="server.listens.length" class="meta">listen: {{ server.listens.join(', ') }}</span>
              <span v-if="server.serverNames.length" class="meta">server_name: {{ server.serverNames.join(' ') }}</span>
              <span class="meta">L{{ server.line }}</span>
            </div>
            <div class="blk-body">
              <div v-if="server.locations.length === 0" class="diag-empty">（无 location）</div>
              <LocationTreeNode
                v-for="loc in server.locations"
                :key="loc.id"
                :node="loc"
                :visited-ids="visitedIds"
                :final-id="finalId"
                :diag-ids="diagIds"
              />
            </div>
          </div>

          <div v-for="up in config.upstreams" :key="up.id" class="upstream-block">
            <div class="blk-head">
              <span class="tag">upstream</span>
              <span>{{ up.name }}</span>
              <span class="meta">L{{ up.line }}</span>
            </div>
            <div class="blk-body">
              <div v-if="up.servers.length === 0" class="diag-empty">（空 upstream）</div>
              <div v-for="srv in up.servers" :key="srv.id" class="upstream-server">
                {{ srv.address }}
                <span v-if="srv.params.length" class="params">{{ srv.params.join(' ') }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 诊断 -->
      <div class="panel">
        <div class="panel-title">
          <span>配置诊断</span>
          <span style="flex: 1"></span>
          <span style="color: var(--muted); font-weight: 400">{{ diagnostics.length }} 项</span>
        </div>
        <div class="panel-body">
          <DiagnosticsPanel :diagnostics="diagnostics" @hover="onDiagHover" />
        </div>
      </div>
    </div>
  </div>
</template>
