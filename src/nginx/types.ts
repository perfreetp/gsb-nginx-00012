// ---------- 通用 AST ----------
export interface NginxDirective {
  kind: 'directive'
  name: string
  args: string[]
  line: number
}

export interface NginxBlock {
  kind: 'block'
  name: string
  args: string[]
  line: number
  children: NginxNode[]
}

export type NginxNode = NginxDirective | NginxBlock

// ---------- 语义模型 ----------
export type LocationModifier = '' | '=' | '^~' | '~' | '~*' | '@'

let nextId = 1
export function genId(): number {
  return nextId++
}
export function resetIds(): void {
  nextId = 1
}

export interface LocationNode {
  id: number
  modifier: LocationModifier
  pattern: string
  line: number
  proxyPass?: string
  proxyPassLine?: number
  children: LocationNode[]
  parent: LocationNode | null
  /** 正则编译错误（仅正则 location） */
  regexError?: string
}

export interface ServerBlock {
  id: number
  line: number
  listens: string[]
  serverNames: string[]
  locations: LocationNode[]
  proxyPass?: string
  proxyPassLine?: number
}

export interface UpstreamServer {
  id: number
  line: number
  address: string
  params: string[]
}

export interface UpstreamBlock {
  id: number
  line: number
  name: string
  servers: UpstreamServer[]
}

export interface ParseError {
  line: number
  message: string
}

export interface NginxConfig {
  servers: ServerBlock[]
  upstreams: UpstreamBlock[]
  errors: ParseError[]
}

// ---------- 匹配结果 ----------
export type StepKind =
  | 'level'
  | 'exact-check'
  | 'prefix-scan'
  | 'regex-check'
  | 'regex-skip'
  | 'descend'
  | 'hit'
  | 'miss'
  | 'info'

export interface MatchStep {
  kind: StepKind
  depth: number
  locationId?: number
  message: string
  /** 该步涉及 location 的判定结果 */
  result?: 'hit' | 'miss' | 'win' | 'skip'
}

export interface MatchResult {
  url: string
  path: string
  steps: MatchStep[]
  /** 最终命中的 location 链（从 server 层到最深） */
  chain: LocationNode[]
  /** 最终生效的 proxy_pass（沿链向上继承） */
  effectiveProxyPass?: string
  /** proxy_pass 指向的 upstream（若有） */
  upstream?: UpstreamBlock
}
