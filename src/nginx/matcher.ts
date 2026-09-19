import type {
  LocationNode,
  MatchResult,
  MatchStep,
  NginxConfig,
  ServerBlock,
  UpstreamBlock,
} from './types'

function label(loc: LocationNode): string {
  if (loc.modifier === '@') return `location ${loc.pattern}`
  const m = loc.modifier ? loc.modifier + ' ' : ''
  return `location ${m}${loc.pattern}`
}

function compileRegex(loc: LocationNode): RegExp | null {
  try {
    return new RegExp(loc.pattern, loc.modifier === '~*' ? 'i' : '')
  } catch {
    return null
  }
}

/**
 * 在某一层的 location 列表中执行真实 Nginx 匹配算法：
 * 1. 精确匹配 `=`：命中即终止
 * 2. 前缀匹配：记录最长匹配；若最长者带 `^~` 则直接采用，跳过正则
 * 3. 正则匹配 `~` / `~*`：按配置书写顺序，第一个命中者胜出
 * 4. 无正则命中时采用最长前缀
 * 命中带嵌套 location 的块时，在其子层级递归执行同一算法。
 */
function matchLevel(
  locations: LocationNode[],
  uri: string,
  steps: MatchStep[],
  depth: number,
): LocationNode | null {
  const indent = '  '.repeat(depth)
  steps.push({
    kind: 'level',
    depth,
    message: `${indent}进入第 ${depth + 1} 层匹配（共 ${locations.length} 个 location 规则）`,
  })

  // 1. 精确匹配
  const exacts = locations.filter((l) => l.modifier === '=')
  for (const loc of exacts) {
    const hit = loc.pattern === uri
    steps.push({
      kind: 'exact-check',
      depth,
      locationId: loc.id,
      result: hit ? 'hit' : 'miss',
      message: hit
        ? `${indent}精确匹配 ${label(loc)}：URI 与 "${loc.pattern}" 完全相等 ✓`
        : `${indent}精确匹配 ${label(loc)}：URI ≠ "${loc.pattern}" ✗`,
    })
    if (hit) return loc
  }

  // 2. 前缀匹配（普通前缀与 ^~ 共同参与，取最长）
  let best: LocationNode | null = null
  const prefixes = locations.filter((l) => l.modifier === '' || l.modifier === '^~')
  for (const loc of prefixes) {
    const hit = uri.startsWith(loc.pattern)
    let note: string
    if (hit) {
      const isLonger = !best || loc.pattern.length > best.pattern.length
      if (isLonger) best = loc
      note = isLonger
        ? `前缀命中，成为当前最长前缀（长度 ${loc.pattern.length}）`
        : `前缀命中，但短于当前最长前缀，丢弃`
    } else {
      note = `URI 不以 "${loc.pattern}" 开头 ✗`
    }
    steps.push({
      kind: 'prefix-scan',
      depth,
      locationId: loc.id,
      result: hit ? (best === loc ? 'win' : 'hit') : 'miss',
      message: `${indent}前缀检查 ${label(loc)}：${note}`,
    })
  }

  // 3. 最长前缀带 ^~ → 跳过正则
  if (best && best.modifier === '^~') {
    steps.push({
      kind: 'regex-skip',
      depth,
      locationId: best.id,
      result: 'win',
      message: `${indent}最长前缀 ${label(best)} 带有 ^~ 修饰符：跳过本层所有正则检查，直接采用`,
    })
    return best
  }

  // 4. 正则按书写顺序检查
  const regexes = locations.filter((l) => l.modifier === '~' || l.modifier === '~*')
  for (const loc of regexes) {
    const re = compileRegex(loc)
    let hit = false
    if (re) {
      try {
        hit = re.test(uri)
      } catch {
        hit = false
      }
    }
    steps.push({
      kind: 'regex-check',
      depth,
      locationId: loc.id,
      result: hit ? 'hit' : 'miss',
      message: hit
        ? `${indent}正则检查 ${label(loc)}：URI 匹配正则 "${loc.pattern}"${loc.modifier === '~*' ? '（不区分大小写）' : ''} ✓，正则命中立即终止本层搜索`
        : `${indent}正则检查 ${label(loc)}：URI 不匹配正则 "${loc.pattern}" ✗`,
    })
    if (hit) return loc
  }

  // 5. 无正则命中 → 采用最长前缀
  if (best) {
    steps.push({
      kind: 'info',
      depth,
      locationId: best.id,
      result: 'win',
      message: `${indent}本层无正则命中，采用最长前缀 ${label(best)}`,
    })
    return best
  }

  steps.push({
    kind: 'miss',
    depth,
    message: `${indent}本层没有任何 location 命中`,
  })
  return null
}

function matchRecursive(
  locations: LocationNode[],
  uri: string,
  steps: MatchStep[],
  depth: number,
  chain: LocationNode[],
): void {
  const hit = matchLevel(locations, uri, steps, depth)
  if (!hit) return
  chain.push(hit)
  if (hit.children.length > 0) {
    steps.push({
      kind: 'descend',
      depth,
      locationId: hit.id,
      message: `${'  '.repeat(depth)}${label(hit)} 含有 ${hit.children.length} 个嵌套 location，进入嵌套层级继续匹配`,
    })
    matchRecursive(hit.children, uri, steps, depth + 1, chain)
  }
}

function extractPath(url: string): string {
  let u = url.trim()
  if (!u) return '/'
  // 去掉协议与 host
  u = u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  // 此时 u 形如 host/path?query 或 /path
  let path: string
  if (u.startsWith('/')) {
    path = u
  } else {
    const idx = u.indexOf('/')
    path = idx === -1 ? '/' : u.slice(idx)
  }
  // 去掉 query 与 fragment
  path = path.split('#')[0].split('?')[0]
  if (!path.startsWith('/')) path = '/' + path
  return path || '/'
}

function findUpstream(config: NginxConfig, proxyPass: string): UpstreamBlock | undefined {
  const m = proxyPass.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)
  if (!m) return undefined
  const host = m[1]
  return config.upstreams.find((u) => u.name === host)
}

export function matchUrl(config: NginxConfig, url: string): MatchResult {
  const path = extractPath(url)
  const steps: MatchStep[] = []
  const chain: LocationNode[] = []

  steps.push({
    kind: 'info',
    depth: 0,
    message: `解析 URL：提取待匹配路径 "${path}"（query 与 fragment 不参与 location 匹配）`,
  })

  const server: ServerBlock | undefined = config.servers[0]
  if (!server) {
    steps.push({ kind: 'miss', depth: 0, message: '配置中不存在 server 块，无法匹配' })
    return { url, path, steps, chain }
  }
  if (config.servers.length > 1) {
    steps.push({
      kind: 'info',
      depth: 0,
      message: `配置包含 ${config.servers.length} 个 server 块，当前使用第一个 server（第 ${server.line} 行）进行匹配`,
    })
  }

  matchRecursive(server.locations, path, steps, 0, chain)

  if (chain.length === 0) {
    steps.push({
      kind: 'miss',
      depth: 0,
      message: '没有任何 location 命中该路径，请求将由 server 级别的默认配置处理',
    })
  } else {
    const last = chain[chain.length - 1]
    steps.push({
      kind: 'hit',
      depth: chain.length - 1,
      locationId: last.id,
      result: 'win',
      message: `最终命中：${label(last)}（第 ${last.line} 行）`,
    })
  }

  // proxy_pass 沿命中链向上继承
  let effectiveProxyPass: string | undefined
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].proxyPass) {
      effectiveProxyPass = chain[i].proxyPass
      break
    }
  }
  if (!effectiveProxyPass && server.proxyPass) effectiveProxyPass = server.proxyPass

  const result: MatchResult = { url, path, steps, chain, effectiveProxyPass }
  if (effectiveProxyPass) {
    result.upstream = findUpstream(config, effectiveProxyPass)
  }
  return result
}
