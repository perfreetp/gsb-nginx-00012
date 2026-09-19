import type {
  Directive,
  LocationModifier,
  LocationNode,
  NginxConfig,
  ServerBlock,
  UpstreamBlock,
} from './types'

interface Token {
  value: string
  line: number
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
      continue
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '{' || ch === '}' || ch === ';') {
      tokens.push({ value: ch, line })
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      let j = i + 1
      let word = ''
      while (j < n && source[j] !== quote) {
        if (source[j] === '\n') line++
        word += source[j]
        j++
      }
      tokens.push({ value: word, line: startLine })
      i = j + 1
      continue
    }
    let word = ''
    const startLine = line
    while (i < n && !' \t\r\n{};#'.includes(source[i])) {
      word += source[i]
      i++
    }
    tokens.push({ value: word, line: startLine })
  }
  return tokens
}

let idSeq = 0
function nextId(prefix: string): string {
  return `${prefix}-${++idSeq}`
}

class Parser {
  private tokens: Token[]
  private pos = 0
  private config: NginxConfig = { servers: [], upstreams: [], directives: [], errors: [] }

  constructor(source: string) {
    this.tokens = tokenize(source)
  }

  parse(): NginxConfig {
    while (!this.eof()) {
      const tok = this.peek()
      if (tok.value === '}') {
        this.error(tok.line, `多余的 "}"`)
        this.pos++
        continue
      }
      this.pos++
      if (tok.value === 'server') {
        this.parseServer(tok.line)
      } else if (tok.value === 'upstream') {
        this.parseUpstream(tok.line)
      } else if (tok.value === 'events' || tok.value === 'http') {
        this.skipBlock()
      } else {
        this.parseDirectiveInto(this.config.directives, tok)
      }
    }
    return this.config
  }

  private eof(): boolean {
    return this.pos >= this.tokens.length
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private error(line: number, message: string) {
    this.config.errors.push({ line, message })
  }

  /** 跳过当前位置开始的 { ... } 块（如 events/http） */
  private skipBlock() {
    // 跳过直到 '{'，然后跳过配对块
    while (!this.eof() && this.peek().value !== '{' && this.peek().value !== ';') this.pos++
    if (this.eof() || this.peek().value === ';') {
      if (!this.eof()) this.pos++
      return
    }
    this.pos++ // consume '{'
    let depth = 1
    while (!this.eof() && depth > 0) {
      const v = this.peek().value
      if (v === '{') depth++
      else if (v === '}') depth--
      this.pos++
    }
  }

  /** 读取指令参数直到 ';'，存入 target */
  private parseDirectiveInto(target: Directive[], nameToken: Token) {
    const args: string[] = []
    while (!this.eof() && this.peek().value !== ';' && this.peek().value !== '{' && this.peek().value !== '}') {
      args.push(this.peek().value)
      this.pos++
    }
    if (!this.eof() && this.peek().value === ';') {
      this.pos++
    } else if (!this.eof() && this.peek().value === '{') {
      // 未知块级指令，跳过
      target.push({ name: nameToken.value, args, line: nameToken.line })
      this.skipBlock()
      return
    } else {
      this.error(nameToken.line, `指令 "${nameToken.value}" 缺少结尾 ";"`)
    }
    target.push({ name: nameToken.value, args, line: nameToken.line })
  }

  private expectOpenBrace(context: string, line: number): boolean {
    if (this.eof() || this.peek().value !== '{') {
      this.error(line, `${context} 缺少 "{"`)
      return false
    }
    this.pos++
    return true
  }

  private parseServer(line: number) {
    const server: ServerBlock = {
      id: nextId('server'),
      line,
      listen: [],
      serverNames: [],
      directives: [],
      locations: [],
    }
    if (!this.expectOpenBrace('server 块', line)) return
    while (!this.eof() && this.peek().value !== '}') {
      const tok = this.peek()
      this.pos++
      if (tok.value === 'location') {
        const loc = this.parseLocation(tok.line)
        if (loc) server.locations.push(loc)
      } else {
        const before = server.directives.length
        this.parseDirectiveInto(server.directives, tok)
        const dir = server.directives[server.directives.length - 1]
        if (dir && server.directives.length > before) {
          if (dir.name === 'listen') server.listen.push(...dir.args)
          if (dir.name === 'server_name') server.serverNames.push(...dir.args)
        }
      }
    }
    if (this.eof()) this.error(line, 'server 块缺少闭合 "}"')
    else this.pos++ // consume '}'
    this.config.servers.push(server)
  }

  private parseLocation(line: number): LocationNode | null {
    let modifier: LocationModifier = 'prefix'
    let pattern = ''
    if (this.eof()) {
      this.error(line, 'location 缺少匹配模式')
      return null
    }
    let tok = this.peek()
    if (tok.value === '=' || tok.value === '^~' || tok.value === '~' || tok.value === '~*') {
      modifier = tok.value as LocationModifier
      this.pos++
      if (this.eof()) {
        this.error(line, `location ${modifier} 缺少匹配模式`)
        return null
      }
      tok = this.peek()
      pattern = tok.value
      this.pos++
    } else if (tok.value.startsWith('@')) {
      modifier = 'named'
      pattern = tok.value
      this.pos++
    } else if (tok.value === '{') {
      this.error(line, 'location 缺少匹配模式')
      pattern = ''
    } else {
      pattern = tok.value
      this.pos++
    }

    const loc: LocationNode = {
      id: nextId('loc'),
      modifier,
      pattern,
      line,
      directives: [],
      children: [],
    }

    if (modifier === '~' || modifier === '~*') {
      try {
        new RegExp(pattern)
      } catch {
        this.error(line, `正则表达式无效: ${pattern}`)
      }
    }

    if (!this.expectOpenBrace(`location "${pattern}"`, line)) return loc
    while (!this.eof() && this.peek().value !== '}') {
      const t = this.peek()
      this.pos++
      if (t.value === 'location') {
        const child = this.parseLocation(t.line)
        if (child) loc.children.push(child)
      } else {
        const before = loc.directives.length
        this.parseDirectiveInto(loc.directives, t)
        const dir = loc.directives[loc.directives.length - 1]
        if (dir && loc.directives.length > before && dir.name === 'proxy_pass') {
          loc.proxyPass = dir.args[0] ?? ''
        }
      }
    }
    if (this.eof()) this.error(line, `location "${pattern}" 缺少闭合 "}"`)
    else this.pos++
    return loc
  }

  private parseUpstream(line: number) {
    let name = ''
    if (!this.eof() && this.peek().value !== '{') {
      name = this.peek().value
      this.pos++
    } else {
      this.error(line, 'upstream 缺少名称')
    }
    const upstream: UpstreamBlock = {
      id: nextId('upstream'),
      name,
      line,
      servers: [],
      directives: [],
    }
    if (!this.expectOpenBrace(`upstream "${name}"`, line)) return
    while (!this.eof() && this.peek().value !== '}') {
      const tok = this.peek()
      this.pos++
      const before = upstream.directives.length
      this.parseDirectiveInto(upstream.directives, tok)
      const dir = upstream.directives[upstream.directives.length - 1]
      if (dir && upstream.directives.length > before && dir.name === 'server' && dir.args.length > 0) {
        upstream.servers.push({ addr: dir.args[0], params: dir.args.slice(1), line: dir.line })
      }
    }
    if (this.eof()) this.error(line, `upstream "${name}" 缺少闭合 "}"`)
    else this.pos++
    this.config.upstreams.push(upstream)
  }
}

export function parseNginxConfig(source: string): NginxConfig {
  idSeq = 0
  return new Parser(source).parse()
}
