import type { LocationNode, NginxConfig } from './types'

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  severity: Severity
  line: number
  title: string
  detail: string
  locationIds: number[]
}

function locLabel(loc: LocationNode): string {
  const m = loc.modifier && loc.modifier !== '@' ? loc.modifier + ' ' : ''
  return loc.modifier === '@' ? `location ${loc.pattern}` : `location ${m}${loc.pattern}`
}

function checkLocationLevel(locations: LocationNode[], diags: Diagnostic[]): void {
  // 1. 重复 location（同一层级、相同修饰符 + 模式）—— Nginx 会直接报错拒绝启动
  const seen = new Map<string, LocationNode>()
  for (const loc of locations) {
    const key = `${loc.modifier}|${loc.pattern}`
    const prev = seen.get(key)
    if (prev) {
      diags.push({
        severity: 'error',
        line: loc.line,
        title: '重复 location 定义',
        detail: `${locLabel(loc)}（第 ${loc.line} 行）与第 ${prev.line} 行的定义完全重复，Nginx 会报 "duplicate location" 错误并拒绝启动。`,
        locationIds: [prev.id, loc.id],
      })
    } else {
      seen.set(key, loc)
    }
  }

  // 2. 精确匹配遮蔽前缀：= /foo 与 /foo 同时存在时，对 URI /foo 前缀规则永远不会生效
  const exacts = locations.filter((l) => l.modifier === '=')
  const prefixes = locations.filter((l) => l.modifier === '' || l.modifier === '^~')
  for (const exact of exacts) {
    for (const prefix of prefixes) {
      if (prefix.pattern === exact.pattern) {
        diags.push({
          severity: 'warning',
          line: prefix.line,
          title: '前缀规则被精确匹配遮蔽',
          detail: `${locLabel(exact)}（第 ${exact.line} 行）会优先命中 URI "${exact.pattern}"，${locLabel(prefix)}（第 ${prefix.line} 行）对该 URI 永远不会生效（仅对更长的子路径有效）。`,
          locationIds: [exact.id, prefix.id],
        })
      }
    }
  }

  // 3. ^~ / 使同层所有正则不可达
  const catchAllCaret = prefixes.find((l) => l.modifier === '^~' && l.pattern === '/')
  if (catchAllCaret) {
    for (const loc of locations) {
      if (loc.modifier === '~' || loc.modifier === '~*') {
        diags.push({
          severity: 'warning',
          line: loc.line,
          title: '正则规则不可达',
          detail: `${locLabel(catchAllCaret)}（第 ${catchAllCaret.line} 行）能匹配所有 URI 且带 ^~ 修饰符，会跳过正则检查，因此 ${locLabel(loc)}（第 ${loc.line} 行）永远不会被命中。`,
          locationIds: [catchAllCaret.id, loc.id],
        })
      }
    }
  }

  // 4. 正则语法错误
  for (const loc of locations) {
    if (loc.regexError) {
      diags.push({
        severity: 'error',
        line: loc.line,
        title: '正则表达式无效',
        detail: `${locLabel(loc)} 的正则 "${loc.pattern}" 无法编译：${loc.regexError}`,
        locationIds: [loc.id],
      })
    }
  }

  // 5. 嵌套 location 不可达：子前缀模式不以父前缀开头时，父命中后子规则永远匹配不到
  for (const parent of locations) {
    if (parent.modifier === '~' || parent.modifier === '~*' || parent.modifier === '@') continue
    for (const child of parent.children) {
      if (child.modifier === '' || child.modifier === '^~' || child.modifier === '=') {
        const parentPrefix = parent.pattern
        if (parentPrefix !== '/' && !child.pattern.startsWith(parentPrefix)) {
          diags.push({
            severity: 'warning',
            line: child.line,
            title: '嵌套 location 不可达',
            detail: `${locLabel(child)}（第 ${child.line} 行）嵌套在 ${locLabel(parent)}（第 ${parent.line} 行）内，但其模式 "${child.pattern}" 不以父级前缀 "${parentPrefix}" 开头，父级命中后该子规则永远无法匹配。`,
            locationIds: [parent.id, child.id],
          })
        }
      }
    }
  }

  // 递归检查子层级
  for (const loc of locations) {
    if (loc.children.length > 0) checkLocationLevel(loc.children, diags)
  }
}

export function analyzeConfig(config: NginxConfig): Diagnostic[] {
  const diags: Diagnostic[] = []

  // 语法错误
  for (const err of config.errors) {
    diags.push({
      severity: 'error',
      line: err.line,
      title: '配置语法错误',
      detail: err.message,
      locationIds: [],
    })
  }

  // server 块检查
  for (const server of config.servers) {
    checkLocationLevel(server.locations, diags)
  }

  // upstream 检查
  const upstreamSeen = new Map<string, number>()
  for (const upstream of config.upstreams) {
    const prevLine = upstreamSeen.get(upstream.name)
    if (prevLine !== undefined) {
      diags.push({
        severity: 'error',
        line: upstream.line,
        title: '重复 upstream 定义',
        detail: `upstream "${upstream.name}"（第 ${upstream.line} 行）与第 ${prevLine} 行的定义重名，Nginx 会报 "duplicate upstream" 错误。`,
        locationIds: [],
      })
    } else {
      upstreamSeen.set(upstream.name, upstream.line)
    }
    if (upstream.servers.length === 0) {
      diags.push({
        severity: 'warning',
        line: upstream.line,
        title: '空 upstream',
        detail: `upstream "${upstream.name}" 没有定义任何 server 节点，代理到该 upstream 的请求会返回 502。`,
        locationIds: [],
      })
    }
    const addrSeen = new Map<string, number>()
    for (const srv of upstream.servers) {
      const prev = addrSeen.get(srv.address)
      if (prev !== undefined) {
        diags.push({
          severity: 'info',
          line: srv.line,
          title: '重复的后端节点',
          detail: `upstream "${upstream.name}" 中 ${srv.address}（第 ${srv.line} 行）与第 ${prev} 行重复，该节点会获得双倍权重。`,
          locationIds: [],
        })
      } else {
        addrSeen.set(srv.address, srv.line)
      }
    }
  }

  // proxy_pass 引用不存在的 upstream
  const checkProxyPass = (value: string, line: number, locIds: number[]): void => {
    const m = value.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)
    if (!m) return
    const host = m[1]
    // 含变量或是 IP/域名的跳过；仅当与某 upstream 命名风格一致时才提示？—— 只要存在 upstream 定义且 host 不是 IP 就检查
    if (host.includes('$')) return
    if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)) return
    if (config.upstreams.length === 0) return
    if (!config.upstreams.some((u) => u.name === host) && !host.includes('.')) {
      diags.push({
        severity: 'warning',
        line,
        title: 'proxy_pass 引用未定义的 upstream',
        detail: `proxy_pass 指向 "${host}"，但配置中没有名为 "${host}" 的 upstream 块，Nginx 会尝试将其当作域名解析，可能启动失败。`,
        locationIds: locIds,
      })
    }
  }

  const walkLocations = (locs: LocationNode[]): void => {
    for (const loc of locs) {
      if (loc.proxyPass) checkProxyPass(loc.proxyPass, loc.proxyPassLine ?? loc.line, [loc.id])
      walkLocations(loc.children)
    }
  }
  for (const server of config.servers) {
    if (server.proxyPass) checkProxyPass(server.proxyPass, server.proxyPassLine ?? server.line, [])
    walkLocations(server.locations)
  }

  // 排序：错误在前，按行号
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  diags.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line)
  return diags
}
