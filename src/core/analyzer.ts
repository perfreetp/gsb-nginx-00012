import type { Diagnostic, LocationNode, NginxConfig } from './types'

function display(loc: LocationNode): string {
  if (loc.modifier === 'prefix') return `location ${loc.pattern}`
  return `location ${loc.modifier} ${loc.pattern}`
}

function isMatchAllRegex(pattern: string): boolean {
  const p = pattern.replace(/\s/g, '')
  return p === '.*' || p === '.' || p === '^' || p === '^.*' || p === '^.*$' || p === '.*$' || p === '/'
}

function walkLocations(
  locations: LocationNode[],
  parent: LocationNode | null,
  diagnostics: Diagnostic[],
  upstreamNames: Set<string>,
) {
  const seen = new Map<string, LocationNode>()
  const regexes: LocationNode[] = []

  for (const loc of locations) {
    const key = `${loc.modifier}|${loc.pattern}`
    const prev = seen.get(key)
    if (prev) {
      diagnostics.push({
        level: 'warning',
        line: loc.line,
        locationId: loc.id,
        message: `重复配置：${display(loc)} 与第 ${prev.line} 行的定义完全相同，后者永远不会生效`,
      })
    } else {
      seen.set(key, loc)
    }

    for (const [otherKey, other] of seen) {
      const otherPattern = otherKey.slice(otherKey.indexOf('|') + 1)
      if (other !== loc && otherKey !== key && otherPattern === loc.pattern) {
        diagnostics.push({
          level: 'warning',
          line: loc.line,
          locationId: loc.id,
          message: `冲突：${display(loc)} 与第 ${other.line} 行的 ${display(other)} 模式相同但修饰符不同，可能产生非预期行为`,
        })
      }
    }

    if (parent && (loc.modifier === 'prefix' || loc.modifier === '^~' || loc.modifier === '=')) {
      if (
        (parent.modifier === 'prefix' || parent.modifier === '^~') &&
        parent.pattern &&
        !loc.pattern.startsWith(parent.pattern)
      ) {
        diagnostics.push({
          level: 'warning',
          line: loc.line,
          locationId: loc.id,
          message: `不可达规则：嵌套的 ${display(loc)} 不以父级 "${parent.pattern}" 开头，任何进入父级的请求都无法命中它`,
        })
      }
    }

    if (loc.modifier === '~' || loc.modifier === '~*') {
      for (const prevRe of regexes) {
        if (isMatchAllRegex(prevRe.pattern)) {
          diagnostics.push({
            level: 'warning',
            line: loc.line,
            locationId: loc.id,
            message: `不可达规则：${display(loc)} 位于第 ${prevRe.line} 行可匹配任意 URI 的正则之后，永远不会被命中`,
          })
          break
        }
      }
      regexes.push(loc)
    }

    if (parent && (parent.modifier === '~' || parent.modifier === '~*' || parent.modifier === 'named')) {
      diagnostics.push({
        level: 'warning',
        line: loc.line,
        locationId: loc.id,
        message: `不可达规则：${display(loc)} 嵌套在${parent.modifier === 'named' ? '命名' : '正则'} location 内，Nginx 不会对其进行嵌套匹配`,
      })
    }

    if (loc.proxyPass) {
      const m = loc.proxyPass.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)
      if (m) {
        const target = m[1]
        if (!target.includes('.') && !target.includes(':') && target !== 'localhost' && !upstreamNames.has(target)) {
          diagnostics.push({
            level: 'error',
            line: loc.line,
            locationId: loc.id,
            message: `proxy_pass 引用的 upstream "${target}" 未在配置中定义`,
          })
        }
      }
    }

    walkLocations(loc.children, loc, diagnostics, upstreamNames)
  }
}

export function analyzeConfig(config: NginxConfig): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  for (const err of config.errors) {
    diagnostics.push({ level: 'error', line: err.line, message: `解析错误：${err.message}` })
  }

  const upstreamNames = new Set<string>()
  const upstreamSeen = new Map<string, number>()
  for (const up of config.upstreams) {
    if (upstreamSeen.has(up.name)) {
      diagnostics.push({
        level: 'warning',
        line: up.line,
        message: `重复配置：upstream "${up.name}" 与第 ${upstreamSeen.get(up.name)} 行的定义重名`,
      })
    } else {
      upstreamSeen.set(up.name, up.line)
    }
    upstreamNames.add(up.name)
    if (up.servers.length === 0) {
      diagnostics.push({
        level: 'warning',
        line: up.line,
        message: `upstream "${up.name}" 没有定义任何后端 server`,
      })
    }
  }

  const referenced = new Set<string>()
  const collectProxyRefs = (locs: LocationNode[]) => {
    for (const loc of locs) {
      if (loc.proxyPass) {
        const m = loc.proxyPass.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)
        if (m) referenced.add(m[1])
      }
      collectProxyRefs(loc.children)
    }
  }
  for (const server of config.servers) collectProxyRefs(server.locations)
  for (const up of config.upstreams) {
    if (!referenced.has(up.name)) {
      diagnostics.push({
        level: 'info',
        line: up.line,
        message: `upstream "${up.name}" 已定义但未被任何 proxy_pass 引用`,
      })
    }
  }

  const serverNameSeen = new Map<string, number>()
  for (const server of config.servers) {
    for (const name of server.serverNames) {
      if (serverNameSeen.has(name)) {
        diagnostics.push({
          level: 'warning',
          line: server.line,
          message: `冲突：server_name "${name}" 在多个 server 块中重复（首次出现于第 ${serverNameSeen.get(name)} 行）`,
        })
      } else {
        serverNameSeen.set(name, server.line)
      }
    }
    walkLocations(server.locations, null, diagnostics, upstreamNames)
  }

  return diagnostics.sort((a, b) => a.line - b.line)
}
