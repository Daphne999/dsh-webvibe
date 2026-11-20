# dsh-webvibe

把 DeepSeek 分享链接里的对话提炼成一份「对话偏好」，写进 `AGENTS.md` 的托管区块。作为 DSH skill 分发。

## 安装

解压到 DSH 的 skills 目录即可（DSH 自动发现 `<root>/<name>/SKILL.md`）：

```bash
# 用户级
unzip dsh-webvibe-<ver>.zip -d ~/.dsh/skills/
# 或项目级
unzip dsh-webvibe-<ver>.zip -d <project>/.dsh/skills/
```

重启 DSH 后，新会话里 `dsh-webvibe` 会出现在可用 skill 列表中，触发词命中即启动。

## 使用

1. 给 agent 贴一个 DeepSeek 分享链接（`https://chat.deepseek.com/share/<id>`）；
2. agent 抓取并展示整张偏好卡（含证据引文，供核对）；
3. 回一条标注：`1y 2n 3改:网络安全 4y`（y=采纳、n=不采纳、改=改后采纳、未提及不写入）；
4. agent 出写块内容；确认后加 `--write` 写入 `$DSH_HOME/AGENTS.md`；
5. 写完提示：**已写入，下一次对话即生效（无需 /new）**。

离线自测：`node scripts/run.mjs check`。

## 隐私红线

- 抓取不带 Cookie / 登录态 / API key；不枚举、不猜 id、不换 UA 绕过；
- 原始链接 / share_id 不进日志、错误、中间产物；一律脱敏 `share/***`；
- 分享对话内容与提炼结果只在本机，不上传。

## 已知限制

- **Playwright 兜底的风控场景未实测**：直连主路径已多链验证；若直连被 403/非 JSON 拦截，Playwright 兜底是设计路径但尚未在真实风控页面上验证。遇到异常请先用直连报错定位。
- **分发版不含真实对话 fixture**：`test/fixtures/` 只带合成件；用真实分享链接校准请本地自备（不进仓库）。
- **测试需 `--test-isolation=none`**：本机 `node --test` 默认隔离模式拉子进程会 `spawn EPERM`，属环境已知问题，非代码问题。

## 测试

```bash
node --test --test-isolation=none test/parse.test.mjs test/preferences.test.mjs test/card-block.test.mjs test/e2e.test.mjs
```

## License

MIT
