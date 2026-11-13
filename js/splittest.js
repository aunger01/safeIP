/* SafeIP · splittest.js — 分流测试：看每个站点实际收到哪个出口 IP
 *
 * 探针四类（与 ip.skk.moe/split-tunnel 同思路）：
 *   cf     → 该域名在 Cloudflare 上，读 https://<host>/cdn-cgi/trace
 *   ali    → 借道 dns-detect.alicdn.com JSONP（阿里 DNS 探测接口，返回国内运营商视角 IP）
 *   qq     → 借道 r.inews.qq.com/api/ip2city JSONP（腾讯新闻接口）
 *   header → fetch 资源后读响应头（网易 cdn-user-ip / 字节 x-request-ip），靠 CDN 暴露 Access-Control-Expose-Headers
 *
 * 国内品牌（阿里 / 腾讯 / 网易 / 字节 / 高通 / CF 中国网络）不在 Cloudflare 上或 trace 不对外，
 * 只能用上面后三种借道法——这也是「国内站点」单列一组的由来。
 */
(function (root) {
  'use strict';
  const SafeIP = (root.SafeIP = root.SafeIP || {});
  const { util } = SafeIP;

  const rand = (n) => {
    const cs = 'useandom2619834075pxbfghjklqvwyzrict';
    let s = '';
    for (let i = 0; i < n; i++) s += cs[(Math.random() * cs.length) | 0];
    return s;
  };
  // 阿里接口按子域区分探测点，随机子域 + 时间戳避免命中缓存
  const ALI_URL = () => `https://${Date.now()}-${rand(16)}.dns-detect.alicdn.com/api/detect/DescribeDNSLookup?cb={cb}`;
  const QQ_URL = 'https://r.inews.qq.com/api/ip2city?otype=jsonp&callback={cb}';

  /** 探针清单。cf 类带 host；其余带 url/header 或走固定接口 */
  const PROBES = [
    // —— 国内站点 ——
    { id: 'alibaba', name: '阿里巴巴', echo: 'ali', hint: '阿里 DNS 探测接口' },
    { id: 'tencent', name: '腾讯', echo: 'qq', hint: '腾讯新闻 IP 接口' },
    {
      id: 'netease', name: '网易', echo: 'header', hint: '网易易盾 CDN 响应头',
      url: 'https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png', header: 'cdn-user-ip',
    },
    {
      id: 'bytedance', name: '字节跳动', echo: 'header', hint: '字节测速 CDN 响应头',
      url: 'https://perfops1.byteperf.com/500b-bench.jpg', header: 'x-request-ip',
    },
    { id: 'cf-cn', name: 'Cloudflare 中国网络', echo: 'cf', host: 'perfops.cloudflareperf.com' },
    { id: 'qualcomm-cn', name: '高通中国', echo: 'cf', host: 'www.qualcomm.cn' },

    // —— AI 服务 ——
    { id: 'chatgpt', name: 'ChatGPT', echo: 'cf', host: 'chatgpt.com', ai: true },
    { id: 'sora', name: 'Sora', echo: 'cf', host: 'sora.com', ai: true },
    { id: 'openai', name: 'OpenAI', echo: 'cf', host: 'api.openai.com', ai: true },
    { id: 'claude', name: 'Claude', echo: 'cf', host: 'claude.ai', ai: true },
    { id: 'anthropic', name: 'Anthropic', echo: 'cf', host: 'api.anthropic.com', ai: true },
    { id: 'anthropic-web', name: 'Anthropic 官网', echo: 'cf', host: 'www.anthropic.com', ai: true },
    { id: 'grok', name: 'Grok', echo: 'cf', host: 'grok.com', ai: true },
    { id: 'xai', name: 'xAI', echo: 'cf', host: 'x.ai', ai: true },
    { id: 'perplexity', name: 'Perplexity', echo: 'cf', host: 'www.perplexity.ai', ai: true },
    { id: 'poe', name: 'Poe', echo: 'cf', host: 'poe.com', ai: true },
    { id: 'character', name: 'Character.AI', echo: 'cf', host: 'character.ai', ai: true },

    // —— 国际站点 ——
    { id: 'cloudflare', name: 'Cloudflare', echo: 'cf', host: 'www.cloudflare.com' },
    { id: 'discord', name: 'Discord', echo: 'cf', host: 'gateway.discord.gg' },
    { id: 'visa', name: 'Visa', echo: 'cf', host: 'www.visa.com' },
    { id: 'x', name: 'X', echo: 'cf', host: 'x.com' },
    { id: 'medium', name: 'Medium', echo: 'cf', host: 'medium.com' },
    { id: 'nodejs', name: 'Node.js', echo: 'cf', host: 'nodejs.org' },
    { id: 'crunchyroll', name: 'Crunchyroll', echo: 'cf', host: 'www.crunchyroll.com' },

    // —— 开发者与静态资源 ——
    { id: 'npm', name: 'npm', echo: 'cf', host: 'www.npmjs.com' },
    { id: 'npm-registry', name: 'npm registry', echo: 'cf', host: 'registry.npmjs.org' },
    { id: 'unpkg', name: 'unpkg', echo: 'cf', host: 'unpkg.com' },
    { id: 'cdnjs', name: 'cdnjs', echo: 'cf', host: 'cdnjs.cloudflare.com' },
    { id: 'jsdelivr', name: 'jsDelivr', echo: 'cf', host: 'testingcf.jsdelivr.net' },
    { id: 'cf-mirrors', name: 'Cloudflare Mirrors', echo: 'cf', host: 'cloudflaremirrors.com' },
    { id: 'kali', name: 'Kali 镜像', echo: 'cf', host: 'kali.download' },
    { id: 'gitlab', name: 'GitLab', echo: 'cf', host: 'gitlab.com' },
    { id: 'docker', name: 'Docker Hub', echo: 'cf', host: 'hub.docker.com' },
    { id: 'cf-dash', name: 'Cloudflare 控制台', echo: 'cf', host: 'dash.cloudflare.com' },

    // —— 加密货币 ——
    { id: 'coinbase', name: 'Coinbase', echo: 'cf', host: 'www.coinbase.com' },
    { id: 'okx', name: 'OKX', echo: 'cf', host: 'www.okx.com' },

    // —— 社交与内容 ——
    { id: 'stackoverflow', name: 'Stack Overflow', echo: 'cf', host: 'stackoverflow.com' },
    { id: 'quora', name: 'Quora', echo: 'cf', host: 'www.quora.com' },
    { id: 'pixiv', name: 'Pixiv', echo: 'cf', host: 'www.pixiv.net' },
    { id: 'v2ex', name: 'V2EX', echo: 'cf', host: 'www.v2ex.com' },
    { id: 'linuxdo', name: 'LINUX DO', echo: 'cf', host: 'linux.do' },

    // —— 工具与购物 ——
    { id: 'notion', name: 'Notion', echo: 'cf', host: 'www.notion.so' },
    { id: 'canva', name: 'Canva', echo: 'cf', host: 'www.canva.com' },
    { id: 'udemy', name: 'Udemy', echo: 'cf', host: 'www.udemy.com' },
    { id: 'shopify', name: 'Shopify', echo: 'cf', host: 'www.shopify.com' },
    { id: 'indeed', name: 'Indeed', echo: 'cf', host: 'www.indeed.com' },
    { id: 'nav', name: '安杰导航站', echo: 'cf', host: 'nav.l1n2.com' },

    // —— 成人内容（NSFW）——
    { id: 'ehentai', name: 'E-Hentai', echo: 'cf', host: 'e-hentai.org' },
    { id: 'missav-ws', name: 'MissAV', echo: 'cf', host: 'missav.ws' },
    { id: 'missav-ai', name: 'MissAV (ai)', echo: 'cf', host: 'missav.ai' },
    { id: 'missav-live', name: 'MissAV (live)', echo: 'cf', host: 'missav.live' },
    { id: 'hanime1', name: 'Hanime1', echo: 'cf', host: 'hanime1.me' },
    { id: 'hanimeone', name: 'HanimeOne', echo: 'cf', host: 'hanimeone.me' },
    { id: 'hanime1com', name: 'Hanime1.com', echo: 'cf', host: 'hanime1.com' },
    { id: 'javchu', name: 'JavChu', echo: 'cf', host: 'javchu.com' },
    { id: 'jkforum', name: 'JKForum', echo: 'cf', host: 'av.jkforum.net' },
    { id: 'javdb', name: 'JavDB', echo: 'cf', host: 'javdb.com' },
  ];

  const BY_ID = new Map(PROBES.map((p) => [p.id, p]));

  /** 分类：国内站单列，其余按用途分，避免所有站点挤在四个大筐里 */
  const CATEGORIES = [
    { id: 'domestic', title: '国内站点', desc: '阿里 / 腾讯 / 网易等国内服务看到的 IP（借道其接口，非 trace）', items: ['alibaba', 'tencent', 'netease', 'bytedance', 'cf-cn', 'qualcomm-cn'] },
    { id: 'ai', title: 'AI 服务', desc: '地区限制最严的一类，出口不对会直接被拒', items: ['chatgpt', 'sora', 'openai', 'claude', 'anthropic', 'anthropic-web', 'grok', 'xai', 'perplexity', 'poe', 'character'] },
    { id: 'intl', title: '国际站点', desc: '常用海外服务', items: ['cloudflare', 'discord', 'visa', 'x', 'medium', 'nodejs', 'crunchyroll'] },
    { id: 'dev', title: '开发者与静态资源', desc: '包管理、CDN 与镜像站', items: ['npm', 'npm-registry', 'unpkg', 'cdnjs', 'jsdelivr', 'cf-mirrors', 'kali', 'gitlab', 'docker', 'cf-dash'] },
    { id: 'crypto', title: '加密货币', desc: '交易所对出口地区敏感', items: ['coinbase', 'okx'] },
    { id: 'social', title: '社交与内容', desc: '社区、问答与图站', items: ['stackoverflow', 'quora', 'pixiv', 'v2ex', 'linuxdo'] },
    { id: 'tools', title: '工具与购物', desc: '生产力、学习与电商', items: ['notion', 'canva', 'udemy', 'shopify', 'indeed', 'nav'] },
    { id: 'nsfw', title: '成人内容（NSFW）', desc: '仅做出口一致性对照，点到为止', items: ['ehentai', 'missav-ws', 'missav-ai', 'missav-live', 'hanime1', 'hanimeone', 'hanime1com', 'javchu', 'jkforum', 'javdb'] },
  ];

  /** Cloudflare trace：主域失败时可带 alt（同品牌备用域，别名不换尺子） */
  async function traceOnce(host) {
    const { data, ms } = await util.request(`https://${host}/cdn-cgi/trace`, { as: 'text', timeout: 10000 });
    const t = util.parseTrace(data);
    const family = util.ipFamily(t.ip);
    if (!family) throw util.makeError('notcf');
    return { ip: t.ip, family, loc: (t.loc || '').toLowerCase(), colo: t.colo || '', warp: t.warp || '', ms };
  }

  async function echoCf(p) {
    try {
      return await traceOnce(p.host);
    } catch (e) {
      if (!p.alt || !p.alt.length) throw e;
      // 同品牌备用域并行竞速，谁先回 IP 用谁
      const settled = await Promise.allSettled(p.alt.map(traceOnce));
      const hit = settled.find((s) => s.status === 'fulfilled');
      if (hit) return hit.value;
      throw e;
    }
  }

  async function echoAli() {
    const { data, ms } = await util.jsonp(ALI_URL(), { timeout: 10000 });
    const c = data && data.content;
    if (!c || !c.localIp) throw util.makeError('parse');
    const cc = String(c.ipCountry || '').toLowerCase();
    const geo = [cc === 'cn' ? '中国' : c.ipCountry, c.ipProvince, c.ipOperator].filter(Boolean).join(' ');
    return { ip: c.localIp, family: util.ipFamily(c.localIp), loc: cc, geo, ms };
  }

  async function echoQq() {
    const { data, ms } = await util.jsonp(QQ_URL, { timeout: 10000 });
    if (!data || data.ret !== 0 || !data.ip) throw util.makeError('parse');
    const cc = data.country === '中国' ? 'cn' : '';
    const geo = [data.country, data.province, data.city].filter(Boolean).join(' ');
    return { ip: data.ip, family: util.ipFamily(data.ip), loc: cc, geo, ms };
  }

  async function echoHeader(p) {
    const t0 = performance.now();
    const r = await fetch(p.url, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const ip = (r.headers.get(p.header) || '').trim();
    if (!r.ok || !util.ipFamily(ip)) throw util.makeError('parse');
    return { ip, family: util.ipFamily(ip), loc: '', ms: Math.round(performance.now() - t0) };
  }

  async function doProbe(p) {
    try {
      const r = p.echo === 'ali' ? await echoAli()
        : p.echo === 'qq' ? await echoQq()
          : p.echo === 'header' ? await echoHeader(p)
            : await echoCf(p);
      return { id: p.id, ok: true, ...r, ms: r.ms };
    } catch (e) {
      const code = e && e.status === 404 ? 'notcf' : (e && typeof e.code === 'string') ? e.code : 'network';
      return { id: p.id, ok: false, error: code };
    }
  }

  const cache = new Map();
  /** 读取某个探针的结果（同一会话缓存，fresh 为 true 时重新请求）
   *  兼容旧入参：传的不是探针 id 时按域名走 cf trace */
  function trace(key, { fresh = false } = {}) {
    if (!BY_ID.has(key)) return traceHost(key, { fresh });
    if (fresh || !cache.has(key)) cache.set(key, doProbe(BY_ID.get(key)));
    return cache.get(key);
  }

  /** 自定义域名：优先 cf trace，失败时按非 CF 处理 */
  function traceHost(host, { fresh = true } = {}) {
    const key = `host:${host}`;
    if (fresh || !cache.has(key)) {
      cache.set(key, (async () => {
        try {
          const r = await traceOnce(host);
          return { id: key, host, ok: true, ...r };
        } catch (e) {
          return { id: key, host, ok: false, error: e && e.status === 404 ? 'notcf' : 'network' };
        }
      })());
    }
    return cache.get(key);
  }

  SafeIP.splittest = { PROBES, BY_ID, CATEGORIES, trace, traceHost };
})(typeof window !== 'undefined' ? window : globalThis);
