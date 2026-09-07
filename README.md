# Requirement Graph MCP

> 完全本地的个人需求与文档图谱：把 Markdown / TXT / JSON / CSV 导入每项目独立的 SQLite 数据库，
> 通过 MCP 让 Codex 查询需求上下文、追踪关系、分析影响范围；图谱可视化统一使用本地网页。
> **本地优先**：不连接飞书，不上传任何内容到外部服务。

[English](./README.en.md) · [MIT License](./LICENSE)

[![npm version](https://img.shields.io/npm/v/requirement-graph-mcp)](https://www.npmjs.com/package/requirement-graph-mcp)
![Node.js >= 22.5](https://img.shields.io/badge/node-%3E%3D%2022.5-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![No runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-green)

---

## 目录

- [它是什么](#它是什么)
- [核心特性](#核心特性)
- [支持的导入格式](#支持的导入格式)
- [快速开始（本地使用）](#快速开始本地使用)
- [本地网页版](#本地网页版)
- [接入 Codex MCP](#接入-codex-mcp)
- [Codex 网页插件（可选）](#codex-网页插件可选)
- [图谱数据原则](#图谱数据原则)
- [测试](#测试)
- [项目结构](#项目结构)
- [开源与版权](#开源与版权)
- [下一步可扩展](#下一步可扩展)

## 它是什么

Requirement Graph MCP 是一个 **完全本地运行** 的个人需求与文档图谱工具：

- 把你项目里的需求/文档（Markdown、TXT、JSON、CSV）导入 SQLite；
- 从 Frontmatter、明确的行首标签和 Wiki/Markdown 链接中提取结构关系；
- 通过 MCP 协议接入 Codex，让 AI 在问答时自动查询需求上下文、依赖与影响范围；
- 提供一个本地网页（关系地图 + 节点阅读）作为**唯一推荐的图谱可视化入口**。

每个项目使用自己的数据库，**集中存放在用户数据目录**（默认 `~/.requirement-graph`，可用环境变量
`REQUIREMENT_GRAPH_HOME` 覆盖），按项目目录一一对应。项目目录本身不会被写入任何隐藏目录。
切换项目就是切换一个 project id（见下文「多项目与切换」）；不同项目的数据不会混在一起。
除你主动运行的本地网页外，没有任何内容会离开你的机器。

## 核心特性

- **本地优先、零上传**：数据库、网页服务、MCP 服务全部跑在本地，只允许绑定回环地址。
- **零运行时依赖**：需要 Node.js 22.5+，没有运行时 npm 依赖，`npm test` 即可完整自检。
- **多种导入格式**：Markdown / TXT / JSON / CSV，Markdown 支持 Frontmatter 与行首标签关系。
- **确认与提议分级**：明确写出的关系标记为 `confirmed`，语义推断的关系标记为 `proposed` 且置信度 ≤ 0.8，不捏造依赖。
- **Codex 友好**：MCP 服务主动声明“需求/文档/依赖/影响分析请自动使用图谱”，日常只需自然语言提问。
- **网页可视化**：关系地图可缩放、拖拽、搜索、分层展开；节点阅读页展示正文与原文证据。

## 支持的导入格式

| 格式 | 处理方式 |
| --- | --- |
| Markdown | 识别 YAML Frontmatter、一级标题、Wiki 链接和相对 Markdown 链接 |
| TXT | 每个文件成为一张文档节点 |
| JSON | 对象、对象数组，或带 `items` 数组的对象 |
| CSV | 每一行成为一张节点 |

Markdown 的 Frontmatter 可使用以下字段自动建关系：

| 字段 | 图关系 |
| --- | --- |
| `depends_on` | DEPENDS_ON |
| `blocked_by` | BLOCKED_BY |
| `related_to` | RELATED_TO |
| `implements` | IMPLEMENTS |
| `validates` | VALIDATES |
| `parent` | CHILD_OF |
| `derives_from` | DERIVES_FROM |

每个节点最好有稳定的 ID。关系的目标可以是节点 ID、标题、文件名或 Wiki 链接中的名称；
即使目标文件后导入，图谱也会在导入结束后补齐关系。

~~~md
---
id: REQ-AUTH-001
title: 支持短信验证码登录
kind: requirement
depends_on: [REQ-PLATFORM-001]
related_to: [REQ-AUTH-002]
---

# 支持短信验证码登录

登录策略见 [[ADR-001-登录策略]]。
~~~

没有 Frontmatter 的现有 Markdown 也可保留自然的需求写法：行首明确标注的
`父需求：`、`依赖：`、`前置：`、`阻塞于：`、`关联：`、`验证：`、`验收：`、`支撑：`、`实现：`
会从这一行的 Markdown/Wiki 链接中提取为结构关系。它们标记为“文档标签识别”，
不会把正文里的普通提及猜成依赖；普通链接仍是低置信度的文档引用。

> 试玩可直接导入 [`examples/requirements`](./examples/requirements)，仓库内自带一套示例需求文档。

## 快速开始（本地使用）

包已发布到 npm：[requirement-graph-mcp](https://www.npmjs.com/package/requirement-graph-mcp)。
**无需克隆源码**，安装后即可使用。需要 Node.js 22.5 或更高版本，没有运行时依赖。

#### 方式一：全局安装（推荐，日常使用与 Codex MCP 都适用）

~~~powershell
npm install -g requirement-graph-mcp

cd D:\Work\my-app
requirement-graph init
requirement-graph import docs\requirements
requirement-graph status
~~~

#### 方式二：npx 免安装（试用、脚本、临时环境）

~~~powershell
cd D:\Work\my-app
npx requirement-graph-mcp init
npx requirement-graph-mcp import docs\requirements
npx requirement-graph-mcp status
# 等价写法：npx -p requirement-graph-mcp requirement-graph <命令>
~~~

- `init` 会在**用户数据目录**里为当前项目创建对应的数据库（`.db` 按项目目录编码命名）；
  首次 `import` 也会自动创建它。项目目录本身保持干净。
- 命令可传 `--project`（目录路径或已登记的 id）指定项目，或传 `--db` 使用自定义数据库路径。

### 多项目与切换（project id）

任意目录（独立仓库、monorepo 根、某个子目录）都可以登记为一个“项目”，并得到一个人类可读的 id：

~~~powershell
requirement-graph project add D:\Work\repo-a        # id 默认取目录名
requirement-graph project add D:\Work\repo-b
requirement-graph project list                       # 查看 id / root / active
requirement-graph project use repo-b                 # 切换默认项目（影响 CLI 与后续 MCP 会话）
requirement-graph status --project repo-a            # 或每次调用显式指定
~~~

MCP 里同理：会话开始时让 Codex 调用一次 `requirement_graph_use_project`（传入项目目录或 id），
之后所有工具都作用于该项目；`requirement_graph_list_projects` 列出已登记项目。
这样在多个仓库/文件夹之间切换只需要换 id，无需每项目配置 MCP 或设置工作目录。

## 本地网页版

无需打开 Codex，也可以直接在浏览器中查看同一份图谱：

~~~powershell
# 全局安装后：
requirement-graph ui D:\Work\my-app

# 或 npx 免安装：
npx requirement-graph-mcp ui D:\Work\my-app
~~~

命令会打印一个本地地址，例如 `http://127.0.0.1:4747/`。默认从 4747 开始；端口已被
占用时会自动尝试后续端口。这是**唯一推荐的图谱可视化入口**：只读取用户数据目录中
该项目的数据库，提供“关系地图”和“节点阅读”两个视图；
节点阅读页列出需求节点，直接显示节点正文及其已记录的原文证据。

可选参数：

~~~powershell
# 固定端口；--port 0 由系统分配一个空闲端口
requirement-graph ui D:\Work\my-app --port 4750

# 等价命令，适合服务形式启动
requirement-graph serve --web --project D:\Work\my-app
~~~

网页服务只允许绑定 `127.0.0.1`、`::1` 或 `localhost`，不会监听局域网地址；它固定到启动时
指定的项目，不接受网页请求提供其他项目路径。点击“重新识别关系”会写入该项目的数据库，
按 `Ctrl+C` 停止服务。

#### 持久化：网页服务不再随 Codex 会话掉线

通过 Codex（MCP）调用 `requirement_graph_open_web` 打开的网页，是一个**独立的后台守护进程**，
运行状态记录在用户数据目录（`web-ui/<项目编码>.json`）。它不依附于 MCP 的 stdio 进程：关闭 Codex、
结束会话或重启 Codex 都不会让已打开的图谱页掉线；下次会话再次打开时会先探测该记录的健康状态，
若同一项目的服务仍在运行就直接复用同一个地址（返回 `reused: true`），不会端口漂移。

停止某项目持久化的网页服务：

~~~powershell
requirement-graph web stop D:\Work\my-app
# 或
requirement-graph web stop --project D:\Work\my-app
~~~

命令行直接前台运行 `requirement-graph ui`（或 `serve --web`）仍是交互模式，按 `Ctrl+C` 停止；
它与 MCP 打开的持久化服务使用同一套只绑定回环地址的网页实现，互不冲突。

## 接入 Codex MCP

先全局安装一次（提供 `requirement-graph` 命令；无需克隆源码，也无需 npx——MCP 由 Codex 反复拉起，建议用常驻的全局命令）：

~~~powershell
npm install -g requirement-graph-mcp
~~~

再把下面配置加入 `C:\Users\你的用户名\.codex\config.toml`：

~~~toml
[mcp_servers.requirement_graph]
command = "requirement-graph"
args = ["serve", "--mcp"]
~~~

重启 Codex 后，它会显示为可用 MCP。服务会主动告诉 Codex：在需求、文档、依赖和影响分析问题中
自动使用图谱；**会话开始时先调用一次 `requirement_graph_use_project`**（传正在讨论的项目目录），
之后你不需要写 MCP 名称、工具名或任何路径，只需正常提问：

- “把当前项目 D:\Work\my-app 的 docs\requirements 导入需求图谱。”
- “查询 D:\Work\my-app 中 REQ-AUTH-001 的需求上下文与直接依赖。”
- “D:\Work\my-app 的 REQ-AUTH-002 变更会影响什么？”
- “找出 D:\Work\my-app 中没有关联的需求。”
- “切到 repo-b 的需求图。” → Codex 会再次调用 `requirement_graph_use_project`

斜杠命令 `/mcp` 只打开连接状态，不是手工点选工具的面板。日常使用只需自然语言，无需编写任何调用语法。

## Codex 网页插件（可选）

说“显示当前项目的关系图谱”时，Codex 应调用 `requirement_graph_open_web` 并打开它返回的
localhost 地址。关系地图可缩放、拖拽、搜索，点击节点可查看来源文件、类型和可见关系；
“节点阅读”会列出需求节点，显示拆分后的正文，并展示已记录的原文证据摘录。

网页的数据范围固定为：

- **Requirement Graph**：只读取用户数据目录中该项目的数据库；
- 不读取外部代码索引，也不显示代码符号、文件、模块或代码关系图层。

网页默认只显示 `depends_on`、`implements`、`validates`、`parent` 等结构关系。
普通 Markdown/Wiki 链接属于低置信度 `REFERENCES` 引用，不是已确认的需求依赖；
仅当用户明确需要引用层时，选择“包含文档引用”。

若历史图谱只含旧版文档引用，网页会显示“重新识别关系”按钮。它只重新处理已经导入
到当前项目数据库的文档，把明确标签补为结构关系，不会扫描或导入无关文件。

网页始终读取 Requirement Graph 的需求、文档与可追溯关系。层级导航只改变当前展示范围，
不会重新拆分、合并或删除需求数据。“显示层级”可选择 1 层文档、2 层分组（默认）、
3 层需求或全部层级；节点的 ＋/− 可展开下一层或收起分支；搜索会跨层查找并保留匹配项的
祖先路径，清除搜索后恢复先前展开状态。交叉关系默认隐藏，按需点击“显示交叉关系”。

不要用 `file://` 直接打开网页文件——它没有本地图谱 API，会停在“正在读取需求图谱”。
请用上面的 `requirement-graph ui` 启动网页；在 Codex 中则使用 `requirement_graph_open_web`
返回的地址。

### 与 MCP 分离

核心包和 Codex 插件是两个独立部分，先独立注册 MCP，插件只是“提示规则”：

~~~toml
[mcp_servers.requirement_graph]
command = "requirement-graph"
args = ["serve", "--mcp"]
~~~

然后才可选安装 `plugins\project-graph-canvas`（显示名 **Requirement Graph Web**）。它只提供
“何时调用已注册 MCP、何时调用 `requirement_graph_open_web` 并打开 localhost 网页”的提示规则；
不会启动服务、不会重复配置 MCP，也不会持有任何图谱数据。

## 图谱数据原则

### 默认拆分到几层

默认采用最多三层有意义的结构，而不是按句子、字段或校验条件不断增加节点：

| 层级 | 组织含义 | 反馈处理示例 |
| --- | --- | --- |
| L1 | 项目或文档范围 | 反馈处理接口文档 |
| L2 | 业务能力或领域分组 | AI 批量处理 |
| L3 | 可独立交付、内容完整的需求 | 提交 AI 处理作业接口 |

已导入的文档可直接作为 L1，不额外创建一份同名文档节点。通常一个分组包含 3～7 个有业务意义的
子项——这个范围只是可读性参考，不是数量指标；简单材料可以只有一层或两层，只有一个子项且没有
独立意义的分组应折叠。只有用户明确要求，或复杂子能力确实能够独立交付时才增加 L4。
不要为了层数或总节点数补造需求。

一个接口的请求参数、响应字段、权限、幂等、空值、错误码和验收检查，通常保存在同一个需求节点的
正文或 `metadata.acceptance_criteria` 中，而不是分别生成一排子节点。跨接口的公共契约可形成独立的
完整需求。文档目录与标题仅提供定位证据，不自动决定业务拆分边界。

### 所属关系与来源证据

- `CHILD_OF` 方向为“子需求 → 唯一所属父需求”，不得出现多个所属父节点或循环。
- 显示层级时，唯一 `CHILD_OF` 优先于 `DERIVES_FROM` 推导；没有显式所属关系时才使用唯一来源作为回退父节点。
- 每个生成节点（包括子节点）仍应填写映射到的全部 `source_document_ids`，并在 `metadata.source_refs`
  保留路径与原文摘录。
- `DERIVES_FROM` 是来源证据，不会因为需求引用多个来源文档而推翻已有的唯一所属关系。
  没有稳定 ID 的来源只记路径，不编造 ID。
- 导入文件中明确写出的关系标记为 `confirmed`；从语义保守推断的跨需求关系标记为 `proposed`，
  置信度不高于 0.8。不要为了让地图连通而捏造依赖，普通 Markdown 引用仍然只是引用。

### 生成、查看与降低粒度

“打开网页”只调用 `requirement_graph_open_web`，不会顺便导入、同步或重建。导入和同步只索引
源文档及其显式链接。完整生成需要读取所有相关原文到 EOF、语义分析并检查完整图谱，随后一次调用
`requirement_graph_replace`，最后打开网页。

将过细节点合并时，先检查并备份当前生成图谱；把完整细则、验收条件和原文证据并入保留节点，
重映射真实的跨节点关系、去重，并去掉合并导致的自连接。不要丢弃细节、删除导入文档，或把分批的
局部 payload 当作整个生成图谱替换。更新 MCP 描述后，新指令在下一次 MCP 连接初始化时送达；
已连接的服务无需为此强制中断。

## 测试

无第三方依赖的自包含测试（Node 内置 `node:test` 风格脚本，可用 `npm test` 一键运行）：

~~~powershell
npm test
# 等价于：
node test/hierarchy.js && node test/smoke.js && node test/web.js && node test/web-ui.js && node test/web-daemon.js && node test/mcp-web.js
~~~

- `test/smoke.js` — 导入/查询冒烟
- `test/hierarchy.js` — 层级与关系
- `test/web.js` — 网页服务
- `test/web-ui.js` — 网页界面
- `test/web-daemon.js` — 持久化网页守护进程（启动/复用/停止）
- `test/mcp-web.js` — MCP 与网页联动

GitHub Actions 已在 Node 22 上运行整套测试（见 `.github/workflows/test.yml`）。

## 项目结构

~~~text
requirement-graph-mcp/
├── .github/workflows/test.yml   # CI：Node 22 测试
├── examples/requirements/       # 示例需求文档（可导入试玩）
├── plugins/project-graph-canvas # 可选的 Codex 网页工作流插件（不含 .mcp.json）
├── src/                         # CLI + SQLite + MCP + 本地网页
│   ├── index.js                 # 入口：init / import / status / serve / ui
│   ├── db.js                    # SQLite 数据库封装
│   ├── importer.js              # Markdown/TXT/JSON/CSV 导入
│   ├── project.js               # 用户数据目录与中央数据库定位（realpath 规范化）
│   ├── registry.js              # 项目登记表：projectId ↔ 根目录、切换
│   ├── mcp.js                   # MCP 服务（use_project 切换项目）
│   ├── web.js / web-ui.js       # 本地网页服务
│   ├── web-daemon.js            # 持久化网页守护进程（启动/复用/停止）
│   └── requirement-*.js         # 图谱、层级、网页文档与图数据
├── test/                        # 无依赖自包含测试
├── package.json
├── LICENSE                      # MIT
└── README.md / README.en.md
~~~

架构采用“全局 MCP 服务 + 每项目本地索引 + 显式初始化 + 本地优先”的设计。

## 开源与版权

本项目采用 **MIT License**，详见 [LICENSE](./LICENSE)。

Copyright © 2026 Zilv · Steven Qiang

## 自动发布（semantic-release）

推送到 `main` 会触发 GitHub Actions 的 **Release** 工作流，用 [semantic-release](https://semantic-release.gitbook.io)
按 Conventional Commits 自动决定版本并发布：

- `feat:` → minor；`fix:` / `perf:` → patch；`BREAKING CHANGE` 或 `!` → major；只有 `chore:` 之类的提交不会发版。
- 每次发版会：更新 `CHANGELOG.md`、推送版本 tag、创建 GitHub Release，并把包发布到 npm。
- 发布使用 **OIDC `id-token` + npm Trusted Publishing**，生成的包自带 provenance，无需把令牌存为仓库 Secret。

一次性前置条件（npm 侧，需账号所有者操作）：

1. 在 npmjs.com 认领/创建包名 `requirement-graph-mcp`；
2. 在该包的 **Trusted Publishing** 设置中关联仓库 `Zilvren/requirement-graph-mcp` 与本 `Release` 工作流；
3. 之后任何推送到 `main` 的 `feat`/`fix` 提交都会自动发版。

如果不用 OIDC：在仓库 Secrets 添加 `NPM_TOKEN`，并把 `.github/workflows/release.yml` 中的
`NPM_CONFIG_PROVENANCE` 环境变量删掉即可。

## 下一步可扩展

这个 MVP 的导入层可继续增加 DOCX、PDF、HTML、Obsidian、Notion 导出等适配器。
DOCX 与 PDF 的可靠关系抽取需要额外解析器及人工审核机制，因此没有在第一版中假装“自动正确”。
欢迎提交 Issue 与 PR。
