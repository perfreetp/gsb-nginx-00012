import type {
  NginxBlock,
  NginxConfig,
  NginxNode,
  ParseError,
  ServerBlock,
  UpstreamBlock,
  LocationNode,
  LocationModifier,
} from './types'
import { genId, resetIds } from './types'

// ---------- 词法分析 ----------
interface Token {
  type: 'word' | '{' | '}' | ';'
  value: string
  line: number
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '{' || c === '}' || c === ';') {
      tokens.push({ type: c, value: c, line })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      const startLine = line
      let j = i + 1
      let val = ''
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\n') line++
        val += src[j]
        j++
      }
      tokens.push({ type: 'word', value: val, line: startLine })
      i = j + 1
      continue
    }
    let val = ''
    const startLine = line
    while (i < src.length && !/[\s{};#]/.test(src[i])) {
      val += src[i]
      i++
    }
    tokens.push({ type: 'word', value: val, line: startLine })
  }
  return tokens
}

// ---------- 语法分析（通用指令树） ----------
function parseTokens(tokens: Token[], errors: ParseError[]): NginxBlock {
  const root: NginxBlock = { kind: 'block', name: '', args: [], line: 0, children: [] }
  const stack: NginxBlock[] = [root]
  let i = 0

  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.type === '}') {
      if (stack.length > 1) stack.pop()
      else errors.push({ line: tok.line, message: '多余的 "}"' })
      i++
      continue
    }
    if (tok.type === ';' || tok.type === '{') {
      errors.push({ line: tok.line, message: `意外的 "${tok.value}"` })
      i++
      continue
    }
    // 指令名
    const name = tok.value
    const line = tok.line
    i++
    const args: string[] = []
    let terminated = false
    while (i < tokens.length) {
      const t = tokens[i]
      if (t.type === ';') {
        stack[stack.length - 1].children.push({ kind: 'directive', name, args, line })
        i++
        terminated = true
        break
      }
      if (t.type === '{') {
        const block: NginxBlock = { kind: 'block', name, args, line, children: [] }
        stack[stack.length - 1].children.push(block)
        stack.push(block)
        i++
        terminated = true
        break
      }
      if (t.type === '}') {
        // 未以 ; 结束的指令，容错处理
        stack[stack.length - 1].children.push({ kind: 'directive', name, args, line })
        errors.push({ line: t.line, message: `指令 "${name}" 缺少结尾的 ";"` })
        terminated = true
        break
      }
      args.push(t.value)
      i++
    }
    if (!terminated) {
      stack[stack.length - 1].children.push({ kind: 'directive', name, args, line })
      errors.push({ line, message: `指令 "${name}" 缺少结尾的 ";"` })
    }
  }
  while (stack.length > 1) {
    const b = stack.pop()!
    errors.push({ line: b.line, message: `块 "${b.name}" 缺少闭合的 "}"` })
  }
  return root
}

// ---------- 语义提取 ----------
function findProxyPass(children: NginxNode[]): { value: string; line: number } | undefined {
  for (const child of children) {
    if (child.kind === 'directive' && child.name === 'proxy_pass' && child.args.length > 0) {
      return { value: child.args[0], line: child.line }
    }
  }
  return undefined
}

function parseLocationBlock(block: NginxBlock, parent: LocationNode | null): LocationNode {
  let modifier: LocationModifier = ''
  let pattern = ''
  const args = block.args
  if (args.length === 1) {
    pattern = args[0]
  } else if (args.length >= 2) {
    const m = args[0]
    if (m === '=' || m === '^~' || m === '~' || m === '~*') {
      modifier = m
      pattern = args[1]
    } else if (m.startsWith('@')) {
      modifier = '@'
      pattern = m
    } else {
      pattern = args[args.length - 1]
    }
  }

  const node: LocationNode = {
    id: genId(),
    modifier,
    pattern,
    line: block.line,
    children: [],
    parent,
  }

  const pp = findProxyPass(block.children)
  if (pp) {
    node.proxyPass = pp.value
    node.proxyPassLine = pp.line
  }

  if (modifier === '~' || modifier === '~*') {
    try {
      new RegExp(pattern, modifier === '~*' ? 'i' : '')
    } catch (e) {
      node.regexError = e instanceof Error ? e.message : String(e)
    }
  }

  for (const child of block.children) {
    if (child.kind === 'block' && child.name === 'location') {
      node.children.push(parseLocationBlock(child, node))
    }
  }
  return node
}

function parseServerBlock(block: NginxBlock): ServerBlock {
  const server: ServerBlock = {
    id: genId(),
    line: block.line,
    listens: [],
    serverNames: [],
    locations: [],
  }
  const pp = findProxyPass(block.children)
  if (pp) {
    server.proxyPass = pp.value
    server.proxyPassLine = pp.line
  }
  for (const child of block.children) {
    if (child.kind === 'directive' && child.name === 'listen') {
      server.listens.push(child.args.join(' '))
    } else if (child.kind === 'directive' && child.name === 'server_name') {
      server.serverNames.push(...child.args)
    } else if (child.kind === 'block' && child.name === 'location') {
      server.locations.push(parseLocationBlock(child, null))
    }
  }
  return server
}

function parseUpstreamBlock(block: NginxBlock): UpstreamBlock {
  const upstream: UpstreamBlock = {
    id: genId(),
    line: block.line,
    name: block.args[0] ?? '',
    servers: [],
  }
  for (const child of block.children) {
    if (child.kind === 'directive' && child.name === 'server' && child.args.length > 0) {
      upstream.servers.push({
        id: genId(),
        line: child.line,
        address: child.args[0],
        params: child.args.slice(1),
      })
    }
  }
  return upstream
}

function collectSemantic(root: NginxBlock, config: NginxConfig): void {
  for (const child of root.children) {
    if (child.kind !== 'block') continue
    if (child.name === 'http') {
      collectSemantic(child, config)
    } else if (child.name === 'server') {
      config.servers.push(parseServerBlock(child))
    } else if (child.name === 'upstream') {
      config.upstreams.push(parseUpstreamBlock(child))
    }
  }
}

export function parseNginxConfig(src: string): NginxConfig {
  resetIds()
  const config: NginxConfig = { servers: [], upstreams: [], errors: [] }
  const tokens = tokenize(src)
  const root = parseTokens(tokens, config.errors)
  collectSemantic(root, config)
  return config
}
