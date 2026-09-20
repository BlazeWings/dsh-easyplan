# dsh-easyplan

> 让 agent 把成果摊开给你看；挑方案点一下，改初稿也点一下。

DSH（DeepSeek Harness）插件。**fork 自 [dsh-showme-html](https://github.com/liceses/dsh-showme-html)**，
在它"展示 HTML 页 + 回执反馈"的基础上，新增了参照 [OpenDesign](https://github.com/nexu-io/open-design)
预览交互实现的**元素点选**：宿主把每个展示页发出去之前，自动注入一段点选脚本——
用户悬停即可看到任何元素的名字，点击即可对它表态，回执一行一条回到 agent 手里。

## 两阶段工作流

```
第 1 阶段 · 挑方向（还没有初稿）
  agent 用模板摆出一排候选，每个候选有名字（hero-v3、f2）
  → 你整项表态：同意 / 不要 / 要它的风格
  → agent 按你的选择做出初稿

第 2 阶段 · 改初稿（初稿已展示）—— 本插件新增
  宿主自动注入点选脚本，agent 什么都不用多写
  → 你直接点页面上的元素：这个标题"字太小"、那张图"换一张"
  → 回执带着元素编号（path-x-y-z 或 AI 起的名字）回到 agent，精确定位修改
```

两个阶段共用同一种回执格式（一行一条）：

```
hero-v3 同意
path-0-2 要改：字太小，改成 24px
path-1-0 不要：和主题不搭
```

## 第 2 阶段怎么运作（注入机制）

1. agent 写完初稿 HTML，调 `easyplan_show({ path })`；
2. 卡片里的 iframe 请求镜像路由 `GET /api/easyplan/raw/<sessionId>/<路径>`；
3. **宿主读文件后不直接发，先在 `</body>` 前注入 `lib/picker.browser.js`**（磁盘上的文件不变）；
4. 页面在沙箱 iframe 里运行，picker 开始工作：
   - **悬停**：高亮框 + 显示元素名字（`data-id` 等 AI 起过的名字优先，否则按 DOM 位置生成 `path-x-y-z`）；
   - **点击**：弹出气泡 → 判定词（同意 / 要改 / 不要 / 要这个风格）+ 备注；
   - 落在链接、按钮、输入框等交互元素上的点击**不拦截**（模板页自己的控件照常工作）；
   - 每次表态变化都 `postMessage` 给卡片 → 卡片出现「填入输入框」按钮；页面底部同时有一个可复制的回执文本框兜底；
   - 底部工具条可整体开关点选模式，Esc 关闭气泡。
5. 你点「填入输入框」→ 回执追加进对话 → agent 收到后按编号定位元素、逐项修改。

安全约束与上游一致：picker 只用 DOM 事件和 postMessage，不碰本地存储 / 网络请求 / 剪贴板
（沙箱的不透明源里这三样都会坏）；路由只服务本机回环地址，路径穿越一律 403。

## 安装（Windows）

```powershell
# 从 GitHub 安装
dsh plugin --profile web add "github:BlazeWings/dsh-easyplan"

# 开发时从本地目录安装（改源码用）
dsh plugin --profile web add "link:<本目录绝对路径>"

# 两种方式都需要重启 dsh web 才生效
```

skill 用目录联接挂入（热发现，不用重启）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\skills\easyplan-report" `
         -Target "<本目录绝对路径>\skill\easyplan-report"
```

## 仓库结构

```
lib/index.js            宿主半区：easyplan_show 工具 + 镜像路由 + 点选注入 + 反馈落盘
lib/client.js           浏览器半区：对话卡片 + 画面内全屏 + 输入框镜像
lib/picker.browser.js   【新增】点选脚本：编号 / 悬停高亮 / 表态气泡 / 回执拼文本
styles/                 四套预设皮肤（soft / swiss / brutal / blueprint）
templates/              三份模板骨架 + core.js（第 1 阶段用）
skill/easyplan-report/  给 agent 的说明书：两阶段工作流 + 回执契约 + 沙箱坑
test/                   离线验收：路由 / 点选注入 / 客户端 / 预设 / 模板 / 页面 六组
examples/               示例页
```

## 开发

```
npm test                 # 213+ 项离线断言（含新增的点选注入测试）

# 改了什么 → 怎么生效：
#   skill/easyplan-report/**  热发现，什么都不用做
#   lib/index.js              重启 dsh web
#   lib/client.js             重启后浏览器 F5
#   lib/picker.browser.js     重启 dsh web（宿主缓存了注入源码）
```

picker 可以脱离 DSH 单独调试：写一个普通 HTML，把 `lib/picker.browser.js` 用
`<script src>` 引进来，浏览器直接打开就能测高亮、气泡和回执拼接。

## 与上游的差异

| | dsh-showme-html（上游） | dsh-easyplan（本仓库） |
|---|---|---|
| 元素点名 | 页面自己给条目起 id | **宿主自动注入点选脚本，任何结构元素都能被点名** |
| 第 2 阶段改初稿 | 靠 agent 手写回执块 | **零页面代码，自动编号 path-x-y-z** |
| 回执体检 | 缺 id / 缺 postMessage 都提醒 | 只在候选缺有意义的名字时提醒（通道已自动兜底） |
| 路由 / 工具 / 消息类型 | `/api/showme`、`show_html`、`dsh-showme-feedback` | `/api/easyplan`、`easyplan_show`、`easyplan-feedback`（可与上游并存） |

## 致谢与许可

- 本体 fork 自 [dsh-showme-html](https://github.com/liceses/dsh-showme-html)（MIT © 2026 liceses），
  架构、安全模型、模板与皮肤均为上游作品；
- 元素点选的交互思路参照 [OpenDesign](https://github.com/nexu-io/open-design)（Apache-2.0），
  本仓库的 picker 为独立实现，未复制其源码。

MIT License
