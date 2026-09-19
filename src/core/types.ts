export type LocationModifier = '=' | '^~' | '~' | '~*' | 'prefix' | 'named'

export interface Directive {
  name: string
  args: string[]
  line: number
}

export interface LocationNode {
  id: string
  modifier: LocationModifier
  /** 匹配模式：前缀 / 精确串 / 正则表达式 / @命名 */
  pattern: string
  line: number
  directives: Directive[]
  children: LocationNode[]
  proxyPass?: string
}

export interface ServerBlock {
  id: string
  line: number
  listen: string[]
  serverNames: string[]
  directives: Directive[]
  locations: LocationNode[]
}

export interface UpstreamServer {
  addr: string
  params: string[]
  line: number
}

export interface UpstreamBlock {
  id: string
  name: string
  line: number
  servers: UpstreamServer[]
  directives: Directive[]
}

export interface ParseIssue {
  line: number
  message: string
}

export interface NginxConfig {
  servers: ServerBlock[]
  upstreams: UpstreamBlock[]
  directives: Directive[]
  errors: ParseIssue[]
}

export type StepOutcome = 'hit' | 'miss' | 'info'

export interface MatchStep {
  depth: number
  locationId?: string
  text: string
  outcome: StepOutcome
}

export interface MatchResult {
  uri: string
  server?: ServerBlock
  location?: LocationNode
  proxyPass?: string
  steps: MatchStep[]
  matched: boolean
}

export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface Diagnostic {
  level: DiagnosticLevel
  line: number
  message: string
  locationId?: string
}
