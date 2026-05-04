# Zhutero 🐽

> [中文版 ↓](#中文)

AI-powered reading framework for [Zotero 7](https://www.zotero.org/) — turn any PDF or EPUB into an interactive, navigable outline that lives as a Zotero note, with your manual highlights auto-attached to the matching section.

---

## What it does

- **Generate** a hierarchical reading framework (chapters → arguments → sub-points) for any PDF or EPUB attachment using Claude or GPT.
- **Tree view** in Zotero's right sidebar. Click a node and the reader jumps to that section — by precise text rect for PDFs, by EPUB CFI for EPUBs.
- **Auto-attach highlights**: any highlight you make in the PDF/EPUB reader is automatically attached to the matching framework node (using position for PDFs, CFI parsing for EPUBs). Right-click a highlight in the tree to delete it.
- **Storage as a Zotero note**: the framework lives as a Zhutero-managed child note (visible HTML rendering + a hidden JSON block). Syncs natively with Zotero, no separate data file.
- **Smart Regenerate**: when partial chapters fail (rate limits, parse errors), the button becomes "Retry Failed (N)" and only re-runs the failed ones. Your notes and highlights survive a regenerate.
- **Import / Export JSON**: hand-craft frameworks externally and import them, or share frameworks across libraries.

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/chrisyangqn/zotero-zhutero/releases).
2. In Zotero: **Tools → Add-ons → ⚙️ → Install Add-on From File…** → pick the `.xpi`.
3. Restart Zotero.

Auto-update is set up via `update.json`, so future versions will install on Zotero's normal update check.

## Setup

1. **Tools → Add-ons → Zhutero → Preferences** (or **Edit → Preferences → Zhutero**)
2. Pick a provider: **Anthropic** (Claude), **OpenAI** (GPT), or a custom OpenAI-compatible endpoint.
3. Paste your API key.
4. Pick a model (defaults to Claude Sonnet 4).

## Usage

1. Select any PDF or EPUB item in your library.
2. The **Zhutero** tab appears in the right item pane (🐽 icon).
3. Click **Generate** — for long EPUBs the LLM call is automatically split per chapter to stay under context / rate limits, and the framework is saved incrementally so a late failure never wipes out hours of work.
4. The tree appears. Click any chapter or subsection to jump there in the reader.
5. Highlight passages in the reader — they appear under the matching section in the tree, color-coded.

## Action bar

| Button | What it does |
|---|---|
| **Generate / Regenerate / Retry Failed (N)** | Run the LLM. The label adapts to current state. |
| **Create Annotations** | (PDF only) Create gray highlight annotations on the PDF for every framework node. |
| **Clean Annotations** | Remove all `[Zhutero]`-prefixed annotations from the PDF. |
| **Export JSON** | Save the framework + your notes as a JSON file. |
| **Import JSON** | Load a framework from a JSON file (replaces the current one). |

## Build from source

```bash
npm install      # only adm-zip + esbuild for build script
node build.js    # produces build/zhutero-VERSION.xpi
```

To install the dev build, drop the produced `.xpi` into Zotero via Install From File.

## Stack

- Vanilla JS, no framework. Loaded via `Services.scriptloader.loadSubScript` from `bootstrap.js`.
- Storage: a Zotero note per item, with a hidden `<div data-zhutero-framework>` JSON block.
- LLM: Anthropic Messages API or OpenAI Chat Completions API.
- EPUB parsing: Zotero's built-in `chrome://zotero/content/EPUB.mjs`.
- PDF text extraction + char-level positions: `Zotero.PDFWorker._query("getFullText", …)`.

## Credits

Pig-nose icon: [Twemoji](https://github.com/jdecked/twemoji) by Twitter, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

---

# 中文

[English ↑](#zhutero-)

为 [Zotero 7](https://www.zotero.org/) 提供 AI 驱动的阅读框架插件 —— 把 PDF 或 EPUB 自动转成一份可交互、可跳转的层级大纲，作为 Zotero note 存储；你在原文里手动加的 highlight 会自动归到对应章节。

## 它做什么

- **Generate（生成）** — 用 Claude 或 GPT 给任意 PDF / EPUB 生成层级阅读框架（章节 → 论点 → 子要点）。
- **Tree view** 在 Zotero 右侧边栏。点节点跳转到对应位置 —— PDF 用精确文字坐标，EPUB 用 CFI。
- **自动归集 highlight**：你在 PDF/EPUB reader 里手动画的高亮，会按位置（PDF）或 CFI 解析（EPUB）自动挂到对应的 framework 节点下。在 tree 里**右键** highlight 可以直接删除。
- **存储即 note**：framework 存为一个 Zhutero 管理的子 note（人类可读的 HTML + 隐藏的 JSON 块）。原生跟随 Zotero 同步，不需要额外的本地数据文件。
- **智能 Regenerate**：当部分章节失败（rate limit、解析错误等），按钮变成 "Retry Failed (N)"，只重跑失败的章节。你已加的 notes 和 highlights 会被保留。
- **Import / Export JSON**：可以在外部手工编辑 framework 再导入，或在不同 library 间分享。

## 安装

1. 从 [Releases](https://github.com/chrisyangqn/zotero-zhutero/releases) 下载最新 `.xpi`。
2. Zotero 里：**Tools → Add-ons → ⚙️ → Install Add-on From File…** → 选 `.xpi`。
3. 重启 Zotero。

通过 `update.json` 配置了自动更新，之后 Zotero 的正常更新检查会自动安装新版本。

## 配置

1. **Tools → Add-ons → Zhutero → Preferences**（或 **Edit → Preferences → Zhutero**）
2. 选一个 provider：**Anthropic**（Claude）、**OpenAI**（GPT），或自定义 OpenAI 兼容 endpoint。
3. 填入 API key。
4. 选模型（默认 Claude Sonnet 4）。

## 使用

1. 在 Library 里选任意 PDF 或 EPUB item。
2. 右侧 item pane 会出现 **Zhutero** tab（🐽 图标）。
3. 点 **Generate** —— 对长 EPUB 会自动按章节拆分调用，避免超 context / rate limit；并且每生成完一章就增量存一次，避免最后失败损失整个跑过的内容。
4. Tree 显示出来后，点任何章节或子节就能跳到 reader 对应位置。
5. 在 reader 里画 highlight —— 会自动按颜色出现在 tree 对应章节下。

## 操作栏

| 按钮 | 作用 |
|---|---|
| **Generate / Regenerate / Retry Failed (N)** | 跑 LLM。按钮文字根据当前状态变化。 |
| **Create Annotations** | （仅 PDF）为 framework 每个节点在 PDF 上创建灰色高亮注释。 |
| **Clean Annotations** | 删除 PDF 上所有 `[Zhutero]` 前缀的注释。 |
| **Export JSON** | 把 framework + 笔记导出为 JSON 文件。 |
| **Import JSON** | 从 JSON 文件加载 framework（覆盖当前）。 |

## 从源码构建

```bash
npm install      # 只装 adm-zip + esbuild（build script 需要）
node build.js    # 生成 build/zhutero-VERSION.xpi
```

装方法和 release 版本一样：Install Add-on From File 选生成的 `.xpi`。

## 技术栈

- 原生 JS，无框架。`bootstrap.js` 通过 `Services.scriptloader.loadSubScript` 加载各模块。
- 存储：每个 item 一个 Zotero note，里面带隐藏 `<div data-zhutero-framework>` JSON 块。
- LLM：Anthropic Messages API 或 OpenAI Chat Completions API。
- EPUB 解析：Zotero 自带的 `chrome://zotero/content/EPUB.mjs`。
- PDF 文字提取 + 字符级坐标：`Zotero.PDFWorker._query("getFullText", …)`。

## 致谢

🐽 图标来自 [Twemoji](https://github.com/jdecked/twemoji)，Twitter 出品，[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) 协议。
