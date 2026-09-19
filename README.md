# Nginx 配置可视化分析器

基于 Vue 3 + TypeScript + Vite 的 Nginx 配置分析工具。

## 功能

- **配置解析**：解析 `server` / `location` / `upstream` / `proxy_pass`（含 `http` 包裹或裸写），以结构化树展示路由关系
- **真实匹配算法**：输入任意 URL，按真实 Nginx location 匹配优先级计算命中规则：
  1. 精确匹配 `=` 命中即终止
  2. 前缀匹配取最长者；最长者带 `^~` 则跳过正则
  3. 正则 `~` / `~*` 按书写顺序，首个命中者胜出
  4. 无正则命中时采用最长前缀
  5. 命中的块含嵌套 location 时递归进入下一层
- **过程高亮**：逐步展示每一层的精确 / 前缀 / 正则检查过程，并在路由结构树中高亮命中链
- **配置诊断**：检测重复 location、精确匹配遮蔽前缀、`^~ /` 导致正则不可达、嵌套不可达、重复 upstream、空 upstream、重复后端节点、无效正则、proxy_pass 引用未定义 upstream、语法错误
- **proxy_pass 解析**：沿命中链向上继承，自动解析引用的 upstream 及其后端节点

## 开发

```bash
npm install
npm run dev      # 启动开发服务器
npm test         # 运行匹配引擎 / 诊断逻辑测试（30 项）
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
src/nginx/parser.ts       配置词法/语法解析 + 语义模型提取
src/nginx/matcher.ts      真实 Nginx location 匹配算法（带过程追踪）
src/nginx/diagnostics.ts  冲突 / 不可达 / 重复配置检测
src/components/           路由树、匹配过程、诊断面板组件
test/match.test.ts        匹配优先级与诊断逻辑测试
```
