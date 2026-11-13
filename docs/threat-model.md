# SafeIP 威胁模型与安全设计说明

SafeIP 是纯前端工具：所有检测请求由访客的浏览器直接发往第三方服务，站点本身没有后端，不收集、不中转任何数据。本文记录安全上的关键取舍，供代码审阅者与自行部署者参考。

## 攻击面与缓解

### 1. 第三方内容注入（XSS via JSONP / scriptvar）

检测源里有一部分依赖 JSONP（`<script>` 回调）与全局变量脚本（`scriptvar`），这些域必须进入 CSP 的 `script-src` 白名单：

- `ipservice.ws.126.net`（网易）、`whois.pconline.com.cn`（太平洋电脑网）、`opendata.baidu.com`（百度）、`vv.video.qq.com`（腾讯视频）
- 分流测试的国内探针另有两条：`*.dns-detect.alicdn.com`（阿里 DNS 探测接口，按随机子域区分探测点）、`r.inews.qq.com`（腾讯新闻 IP 接口）

**风险**：若这些域自身的响应被攻击者控制（域名劫持、CDN 污染、接口被改造返回任意脚本），等同于在页面执行任意代码。

**缓解与残余风险**：

- 页面不处理任何用户敏感输入，脚本注入者最多能**展示伪造的检测结果**（误导）或把访客的后续探测请求引向别处；页面没有账号、Cookie、支付等高价值目标。
- JSONP 回调名带随机后缀（`__safeip_cb_<时间戳36进制>_<序号>`），不可预测；回调在超时或完成后立即置空函数并延迟删除，防迟到回调报错。
- `scriptvar` 按变量名串行排队，读取后立刻删除全局变量。
- 请求统一 `credentials: 'omit'` + `referrerPolicy: 'no-referrer'`，不携带 Cookie、不泄露来源页。
- **接受残余风险的理由**：这些是国内服务 IP 归属地的少数可用跨域接口，收益（国内视角的出口检测）大于敞口（无敏感数据的展示层被误导）。

### 2. CSP 策略

```
default-src 'none'
script-src  'self' + 6 个 JSONP 白名单域（含阿里 DNS 探测、腾讯新闻接口）
style-src   'self'
connect-src https:（原 http://ip-api.com 白名单已随该 HTTP-only 源移除，全站不再有明文 HTTP 请求）
img-src     'self' https://cdn.jsdelivr.net data: blob:
base-uri 'none'; form-action 'none'
```

- `default-src 'none'` 收口：未显式放行的一律禁止（含 `frame-src`，页面不可能被 iframe 嵌第三方内容）。
- `connect-src https:` 是有意放宽：探测端点数量多且随版本增减，fetch 的响应只进解析器、不进 DOM，放宽不构成脚本注入面。
- 不含 `unsafe-inline`、`unsafe-eval`：内联事件处理器会被静默拦截，代码中所有事件均用 `addEventListener` / 捕获阶段委托（如旗图加载失败回退），禁止内联 `style` 属性，尺寸经 CSSOM（`applySizes`）设置。
- CSP 以 `<meta>` 形式下发，使工具保持零构建、file:// 双击可用的形态（无需 HTTP 头）。

### 3. 隐私

- **对本站**：无后端、无统计、无 Cookie；`localStorage` 仅存主题偏好（`safeip-theme`）。
- **对第三方**：探测的本意就是让第三方服务看到访客出口 IP，这是功能而非泄露；请求一律不带 Referer、不带凭据、`cache: 'no-store'`。
- **DNS 泄露检测**用随机子域名（32/40 位）触发解析，随机性来自 `crypto.getRandomValues`，不依赖时间戳，不可被第三方预先撞库关联。
- 「隐藏 IP」开关与 URL 参数 `?mask` 只做展示层打码（IPv4 留前两段 / IPv6 留前两组），用于截图分享。

### 4. 供应链

- 零依赖、零构建：仓库内 35 个 JS 即全部运行时代码，无 `node_modules`，无 CDN 运行时脚本；`npm test` 只在开发期使用。
- 唯一运行时外部资源是冷门国家码的旗图（jsDelivr 的 `hatscripts/circle-flags`，MIT），仅 `img-src`，加载失败回退为文字徽标。
- 常用 43 国旗图自托管于 `assets/flags/`，减少对外部 CDN 的依赖。

## 自行部署者的注意事项

1. 替换 `index.html` 中的 `canonical` / `og:url` / `og:image` / JSON-LD `url` 为自己的地址（`tests/html.test.js` 会校验一致性）。
2. 若新增 JSONP 型检测源，必须同步加入 CSP `script-src` 白名单；新增外链图片须放行 `img-src`——CSP 违规是静默失败，控制台才有日志。
3. 若引入 iframe 能力（当前被 `default-src 'none'` 禁死），需显式加 `frame-src` 并重新评估本文件。

## 更新记录

- 2026-11-13：初版（aunger01/safeIP fork 整理，基于上游 2026-10 设计文档 `docs/superpowers/specs/`）。
