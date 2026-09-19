import { parseNginxConfig } from '../src/nginx/parser'
import { matchUrl } from '../src/nginx/matcher'
import { analyzeConfig } from '../src/nginx/diagnostics'

const config = `
upstream backend_api {
    server 10.0.0.11:8080 weight=3;
    server 10.0.0.12:8080;
}
upstream static_cdn {
    server 10.0.1.5:80;
}
http {
    server {
        listen 80;
        server_name example.com;

        location = /healthz {
            proxy_pass http://backend_api;
        }
        location / {
            proxy_pass http://backend_api;
        }
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
        location ^~ /static/ {
            proxy_pass http://static_cdn;
        }
        location ~ \\.(gif|jpg|png)$ {
            proxy_pass http://static_cdn;
        }
        location ~* /download/ {
            proxy_pass http://backend_api;
        }
    }
}
`

const cfg = parseNginxConfig(config)

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
  }
}

function finalPattern(url: string): string | null {
  const r = matchUrl(cfg, url)
  if (r.chain.length === 0) return null
  const last = r.chain[r.chain.length - 1]
  return `${last.modifier} ${last.pattern}`
}
function proxy(url: string): string | undefined {
  return matchUrl(cfg, url).effectiveProxyPass
}

console.log('匹配优先级测试：')
check('精确匹配 = 优先于一切', finalPattern('http://example.com/healthz'), '= /healthz')
check('精确匹配不受 query 影响', finalPattern('http://example.com/healthz?a=1'), '= /healthz')
check('无 host 的纯路径', finalPattern('/healthz'), '= /healthz')
check('根路径命中前缀 /', finalPattern('http://example.com/'), ' /')
check('普通页面命中前缀 /', finalPattern('http://example.com/index.html'), ' /')
check('图片命中正则（覆盖最长前缀 /）', finalPattern('http://example.com/pic.jpg'), '~ \\.(gif|jpg|png)$')
check('^~ 前缀跳过正则（.jpg 在 /static/ 下）', finalPattern('http://example.com/static/a.jpg'), '^~ /static/')
check('^~ 普通命中', finalPattern('http://example.com/static/a.css'), '^~ /static/')
check('~* 不区分大小写', finalPattern('http://example.com/DOWNLOAD/file'), '~* /download/')
check('嵌套：/api/ 命中', finalPattern('http://example.com/api/users'), ' /api/')
check('嵌套：/api/admin/ 深入一层', finalPattern('http://example.com/api/admin/users'), ' /api/admin/')
check('嵌套：深层精确匹配', finalPattern('http://example.com/api/admin/status'), '= /api/admin/status')
check('嵌套：父级正则对 /api/ 下生效', finalPattern('http://example.com/api/x.php'), '~* \\.php$')
check('嵌套：父级正则大小写不敏感', finalPattern('http://example.com/api/X.PHP'), '~* \\.php$')
check('嵌套：父级正则不越过 ^~ 边界（/static/x.php 走 ^~）', finalPattern('http://example.com/static/x.php'), '^~ /static/')

console.log('proxy_pass 继承测试：')
check('命中链向上继承 proxy_pass', proxy('http://example.com/api/admin/status'), 'http://10.0.9.2:9000')
check('嵌套命中使用自身 proxy_pass', proxy('http://example.com/api/admin/users'), 'http://10.0.9.1:9000')
check('upstream 解析', matchUrl(cfg, 'http://example.com/healthz').upstream?.name, 'backend_api')
check('upstream 节点数', matchUrl(cfg, 'http://example.com/healthz').upstream?.servers.length, 2)

console.log('诊断测试：')
const badCfg = parseNginxConfig(`
upstream dup { server 1.1.1.1:80; }
upstream dup { server 2.2.2.2:80; }
upstream empty_up {}
upstream backend_api { server 10.0.0.1:80; server 10.0.0.1:80; }
server {
    listen 80;
    location / { proxy_pass http://backend_api; }
    location / { proxy_pass http://backend_api; }
    location = /exact { proxy_pass http://backend_api; }
    location /exact { proxy_pass http://backend_api; }
    location ^~ / { proxy_pass http://backend_api; }
    location ~ \\.jpg$ { proxy_pass http://backend_api; }
    location /parent/ {
        location /other/ { proxy_pass http://backend_api; }
    }
    location ~ (bad { proxy_pass http://backend_api; }
    location /x/ { proxy_pass http://undefined_up; }
}
`)
const diags = analyzeConfig(badCfg)
const titles = diags.map((d) => d.title)
check('检出重复 location', titles.filter((t) => t === '重复 location 定义').length, 1)
check('检出精确遮蔽前缀', titles.filter((t) => t === '前缀规则被精确匹配遮蔽').length, 1)
check('检出 ^~/ 导致正则不可达（含无效正则共 2 条）', titles.filter((t) => t === '正则规则不可达').length, 2)
check('检出嵌套不可达', titles.filter((t) => t === '嵌套 location 不可达').length, 1)
check('检出重复 upstream', titles.filter((t) => t === '重复 upstream 定义').length, 1)
check('检出空 upstream', titles.filter((t) => t === '空 upstream').length, 1)
check('检出重复后端节点', titles.filter((t) => t === '重复的后端节点').length, 1)
check('检出无效正则', titles.filter((t) => t === '正则表达式无效').length, 1)
check('检出未定义 upstream 引用', titles.filter((t) => t === 'proxy_pass 引用未定义的 upstream').length, 1)
check('语法错误为 0', badCfg.errors.length, 0)

const syntaxBad = parseNginxConfig('server { listen 80; location / { proxy_pass http://x; }')
check('缺少闭合括号产生语法错误', syntaxBad.errors.length > 0, true)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
