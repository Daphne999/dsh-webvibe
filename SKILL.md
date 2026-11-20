---
name: dsh-webvibe
description: 用户粘贴 DeepSeek 分享链接（https://chat.deepseek.com/share/<id>）或裸 share_id 时启动。流程：抓链接 → 解析 share@1 → 提炼 preference-card → 展示卡片批量确认 → 写 AGENTS.md 托管区块。触发词：分享链接、share_id、chat.deepseek.com/share、网页版迁移、偏好卡、webvibe、对话偏好、托管区块。
---

# dsh-webvibe —— 分享链接 → AGENTS.md 对话偏好托管区块

用户输入一个 DeepSeek 分享链接（或裸 share_id）即启动本流程。顺序执行五步，任一步失败**原样报错、不降级、不跳过**。

## 运行方式（单一入口）

代码在 `<skill-base>/scripts/`，用 `run.mjs` 单一入口：

1. `node <skill-base>/scripts/run.mjs from <链接>` → fetch→parse→extract→render，输出偏好卡并保存 `card.json`；
2. 把**整张卡**展示给用户，等用户一条消息标注（`1y 2n 3改:…`）；
3. `node <skill-base>/scripts/run.mjs --card card.json --confirm '<标注>'` → 套确认，出写块内容（不写盘）；
4. 用户确认后加 `--write` 才写盘。

> 离线自测：`node <skill-base>/scripts/run.mjs check`。

## 隐私红线（全程不变，违者即失败）

1. 抓取不带 Cookie / 登录态 / API key；不枚举、不猜 id、不换 UA 绕过验证；
2. 原始链接与 share_id 不进任何日志 / 错误 / 中间产物 / 交付物，一律用脱敏形式 `share/***`；
3. 分享对话内容与提炼结果只在本机流转，**不上传**。

## 流程五步

### ① 抓链接
- 复用 `fetchShareContent(input)` 直连 `/api/v0/share/content` 抓取（已实测；更快更省、隐私约束已用测试钉死）；直连遇 403/非 JSON 才用 Playwright 兜底；
- 先 `extractShareId(input)` 校验链接形状（`^[a-z0-9]{10,32}$`，非官方域名报 `BAD_SHARE_ID`）；
- 禁止 Cookie/登录态/API key、禁止枚举、禁止绕过验证。

### ② 出 share@1
- `parseShareContent(raw)` → `webvibe/share@1`；
- 结构变化时抛错（`SCHEMA_MISMATCH` / `UNSUPPORTED_FRAGMENT` / `UNSUPPORTED_BRANCHING`），不猜不补。

### ③ 生成 preference-card
- `extractPreferences(conv, { caveats, provenance })` → `webvibe/preference-card@1`；
- 六字段：称呼/语气、回复长度、格式化、话题领域、被纠正过的点、对思考过程的态度；每字段带 `value` + `confidence` + `evidence`。

### ④ 展示卡片，批量确认（未确认不写入）
- `renderCardMarkdown(card)` 渲染**整张卡**给用户看（含证据引文，供核对）；
- 用户**一条消息**回复标注，如「`1y 2n 3改：把『学习考试』改成『网络安全』`」；
- `y`=采纳、`n`=不采纳、`改：<新结论>`=按修改采纳（**「改」没给文本 → 按 `n` 处理**）、不提及的字段=不写入；
- 只有被 `y` 或 `改` 确认的字段才进下一步；**全部未确认则到此为止，不写**。

### ⑤ 写 AGENTS.md 托管区块 + 生效提示
- `planWrite(existingText, card)` 出写块内容给用户看 → `applyBlock(...)` 写 `$DSH_HOME/AGENTS.md`；
- 区块标记 `<!-- dsh-webvibe:begin v1 -->` / `<!-- dsh-webvibe:end -->`；内容**只带六结论字段 + 置信度，零引文**；幂等可重入（同内容重复写文件不变）；
- 写完后提示用户：**「已写入，下一次对话即生效（无需 /new）」**（快路重注 ~80ms + 变更重注双保险；新会话仍是最稳路径）。

## 幂等与可重入

- 同内容重复写入 → 文件不变（`planWrite` 幂等）；
- 写入前对整份文件做 sha256，写后记录 `afterWriteHash` + 全文快照；
- 撤销时当前 hash ≠ `afterWriteHash` → 拒绝自动撤销，给逐行 diff 交用户决定。

## 组件映射（scripts/，复用现有模块）

| 步骤 | 复用函数 | 文件 |
|---|---|---|
| ① 抓链接 | extractShareId / redactShareId / fetchShareContent | scripts/fetch-share.mjs |
| ② 解析 | parseShareContent | scripts/parse-share.mjs |
| ③ 提炼 | extractPreferences | scripts/preferences.mjs |
| ④ 展示/确认 | renderCardMarkdown / parseAnnotations / applyConfirmation | scripts/render-card.mjs / scripts/confirm.mjs |
| ⑤ 写块 | renderBlockContent / planWrite / applyBlock | scripts/card-block.mjs |
