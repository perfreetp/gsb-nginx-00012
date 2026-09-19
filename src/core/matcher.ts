import type { LocationNode, MatchResult, MatchStep, NginxConfig, ServerBlock } from './types'

function display(loc: LocationNode): string {
  if (loc.modifier === 'prefix') return `location ${loc.pattern}`
  return `location ${loc.modifier} ${loc.pattern}`
}

/**
 * 在某一层级（server 或某个 location 的嵌套层）执行 Nginx 匹配：
 * 1. 精确匹配 `=`，命中即终止；
 * 2. 找出最长前缀匹配（普通前缀与 ^~ 共同参与）；
 * 3. 若最长前缀为 ^~，跳过正则，直接采用；
 * 4. 否则按配置顺序测试正则 location，首个命中者胜出；
 * 5. 正则均未命中则采用最长前缀；
 * 6. 命中块存在嵌套 location 时，在嵌套层递归执行同样流程。
 */
function matchLevel(
  locations: LocationNode[],
  uri: string,
  steps: MatchStep[],
  depth: number,
): LocationNode | null {
  // 1. 精确匹配
  const exacts = locations.filter((l) => l.modifier === '=')
  for (const loc of exacts) {
    const hit = uri === loc.pattern
    steps.push({
      depth,
      locationId: loc.id,
      text: `精确匹配 ${display(loc)}：URI "${uri}" ${hit ? '===' : '!=='} "${loc.pattern}"`,
      outcome: hit ? 'hit' : 'miss',
    })
    if (hit) return loc
  }

  // 2. 最长前缀匹配
  let best: LocationNode | null = null
  const prefixes = locations.filter((l) => l.modifier === 'prefix' || l.modifier === '^~')
  for (const loc of prefixes) {
    const hit = uri.startsWith(loc.pattern)
    const isLonger = hit && (!best || loc.pattern.length > best.pattern.length)
    steps.push({
      depth,
      locationId: loc.id,
      text: `前缀匹配 ${display(loc)}："${uri}" ${hit ? '以' : '不以'} "${loc.pattern}" 开头${
        isLonger ? '，暂记为最长前缀候选' : hit ? '，但短于当前候选' : ''
      }`,
      outcome: hit ? 'hit' : 'miss',
    })
    if (isLonger) best = loc
  }

  // 3. ^~ 优先，跳过正则
  if (best && best.modifier === '^~') {
    steps.push({
      depth,
      locationId: best.id,
      text: `最长前缀为 ^~ 修饰的 ${display(best)}，跳过本层正则匹配`,
      outcome: 'info',
    })
  } else {
    // 4. 按顺序测试正则
    const regexes = locations.filter((l) => l.modifier === '~' || l.modifier === '~*')
    for (const loc of regexes) {
      let hit = false
      let invalid = false
      try {
        const re = new RegExp(loc.pattern, loc.modifier === '~*' ? 'i' : '')
        hit = re.test(uri)
      } catch {
        invalid = true
      }
      steps.push({
        depth,
        locationId: loc.id,
        text: invalid
          ? `正则匹配 ${display(loc)}：表达式无效，跳过`
          : `正则匹配 ${display(loc)}：/${loc.pattern}/${loc.modifier === '~*' ? 'i' : ''} ${
              hit ? '命中' : '未命中'
            } "${uri}"`,
        outcome: hit ? 'hit' : 'miss',
      })
      if (hit) {
        best = loc
        break
      }
    }
  }

  if (!best) return null

  // 6. 嵌套 location 递归
  if (best.children.length > 0) {
    steps.push({
      depth,
      locationId: best.id,
      text: `进入 ${display(best)} 的嵌套 location 继续匹配`,
      outcome: 'info',
    })
    const nested = matchLevel(best.children, uri, steps, depth + 1)
    if (nested) return nested
    steps.push({
      depth,
      locationId: best.id,
      text: `嵌套 location 均未命中，回退到 ${display(best)}`,
      outcome: 'info',
    })
  }
  return best
}

/** 依据 listen / server_name 选择 server 块（简化实现 Nginx 的虚拟主机选择） */
function pickServer(config: NginxConfig, host: string, steps: MatchStep[]): ServerBlock | undefined {
  if (config.servers.length === 0) return undefined
  let chosen: ServerBlock | undefined
  for (const server of config.servers) {
    for (const name of server.serverNames) {
      if (name === host) {
        chosen = server
        steps.push({
          depth: 0,
          text: `server_name "${name}" 与 Host "${host}" 精确一致，选择第 ${config.servers.indexOf(server) + 1} 个 server 块`,
          outcome: 'hit',
        })
        return chosen
      }
      if (name.startsWith('*.')) {
        const suffix = name.slice(1)
        if (host.endsWith(suffix) && host.length > suffix.length) {
          chosen = server
          steps.push({
            depth: 0,
            text: `通配 server_name "${name}" 匹配 Host "${host}"，选择第 ${config.servers.indexOf(server) + 1} 个 server 块`,
            outcome: 'hit',
          })
          return chosen
        }
      }
    }
  }
  chosen = config.servers[0]
  steps.push({
    depth: 0,
    text: `没有 server_name 匹配 Host "${host}"，使用默认 server（第 1 个 server 块）`,
    outcome: 'info',
  })
  return chosen
}

export function matchUrl(config: NginxConfig, rawUrl: string): MatchResult {
  const steps: MatchStep[] = []
  let uri = rawUrl.trim()
  let host = ''

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri)) {
    try {
      const u = new URL(uri)
      host = u.hostname
      uri = u.pathname + u.search
      steps.push({ depth: 0, text: `解析 URL：Host = "${host}"，请求 URI = "${uri}"`, outcome: 'info' })
    } catch {
      steps.push({ depth: 0, text: `URL 无法解析，按原始 URI 处理`, outcome: 'info' })
    }
  } else {
    if (!uri.startsWith('/')) uri = '/' + uri
    steps.push({ depth: 0, text: `请求 URI = "${uri}"（未提供 Host，使用默认 server）`, outcome: 'info' })
  }

  const result: MatchResult = { uri, steps, matched: false }
  const server = pickServer(config, host, steps)
  if (!server) {
    steps.push({ depth: 0, text: '配置中不存在任何 server 块，无法匹配', outcome: 'miss' })
    return result
  }
  result.server = server

  const loc = matchLevel(server.locations, uri, steps, 1)
  if (!loc) {
    steps.push({ depth: 1, text: '没有任何 location 命中，请求将由 server 级配置处理（通常为 404 或默认根目录）', outcome: 'miss' })
    return result
  }

  result.location = loc
  result.proxyPass = loc.proxyPass
  result.matched = true
  steps.push({
    depth: 1,
    locationId: loc.id,
    text: `最终命中 ${display(loc)}${loc.proxyPass ? `，代理到 ${loc.proxyPass}` : ''}`,
    outcome: 'hit',
  })
  return result
}
