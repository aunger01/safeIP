/* SafeIP · scripts/health-check.cjs — 检测源健康巡检（GitHub Actions 每日定时跑）
 *
 * 判定口径（巡检机在海外，视角与访客不同，故分两档避免误报）：
 *   ok   — 拿到响应且 parse 出合法 IP
 *   soft — 超时/网络层失败（重试一次仍失败。可能是巡检机被墙或网络抖动，不代表端点真死）
 *   hard — 拿到响应但 HTTP ≥400 / DNS 不存在 / 解析不出 IP（端点大概率真死）
 * 只有 hard 才开 Issue；soft 仅列在报告里。IPv6 组跳过（Actions 机器无 IPv6）。
 *
 * 防误报熔断：若 hard 失败占比过高（>60%），判定为巡检机自身网络异常，
 * 降级为 soft 处理、不开 Issue（标准输出里会提示）。
 * Issue 策略：固定标题的单个 Issue——有 hard 失败且签名变化时创建/更新；全部恢复时评论后关闭。
 *
 * 本地演练：DRY_RUN=1 node scripts/health-check.cjs（只探测不碰 Issue API）
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

require(path.join(__dirname, '..', 'js', 'util.js'));
// js/sources.js 与 js/splittest.js 都是无 DOM 依赖的 IIFE，可直接 require 取清单
require(path.join(__dirname, '..', 'js', 'splittest.js'));
const { util, sources, splittest } = globalThis.SafeIP;

const TIMEOUT = 15000;
const RETRY_DELAY = 3000;
const CONCURRENCY = 4;
const CB = 'safeip_health';
const TITLE = '🩺 检测源健康巡检报告';

// ---------------- 探测目标 ----------------

// 只巡检 cf 类站点：国内站（阿里/腾讯/网易/字节）靠浏览器端 JSONP 与响应头借道，
// 海外 runner 既拿不到正确结果也读不到 CORS 头，纳进来只会天天误报。
const traceHosts = splittest.PROBES.filter((p) => p.echo === 'cf').map((p) => ({ id: p.id, name: p.name, host: p.host }));

const ipTargets = sources.list.filter((s) => s.group !== 'v6'); // Actions 无 IPv6
// trace 站点复用 fromTrace 的解析（只取 ip 字段验证）
const TRACE_PARSE = (text) => {
  const t = util.parseTrace(text);
  return { ip: t.ip };
};
const traceTargets = traceHosts.map(({ id, name, host }) => ({ id: `trace:${id}`, name, host, trace: true, method: 'text', parse: TRACE_PARSE }));

// ---------------- 取数与判定 ----------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'safeip-health/1.0 (+https://github.com/tsix2019/safeIP)' },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 按检测源的方法从响应文本里解出喂给 parse 的数据 */
function payloadFor(source, text) {
  if (source.method === 'json') return JSON.parse(text);
  if (source.method === 'text') return text;
  if (source.method === 'jsonp') {
    const marker = `${CB}(`;
    const i = text.lastIndexOf(marker);
    const end = text.lastIndexOf(')');
    if (i < 0 || end <= i + marker.length) throw hardErr('parse');
    return JSON.parse(text.slice(i + marker.length, end));
  }
  if (source.method === 'scriptvar') {
    const m = /=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text);
    if (!m) throw hardErr('parse');
    return JSON.parse(m[1]);
  }
  throw hardErr('parse');
}

function hardErr(code) {
  const e = new Error(code);
  e.hard = true;
  return e;
}

/** 网络层错误分类：超时=soft，其余（DNS 不存在/拒绝/TLS）=hard */
function classifyNetError(e) {
  if (e && e.name === 'AbortError') return { soft: '超时' };
  const code = (e && e.cause && e.cause.code) || (e && e.code) || 'network';
  return { hard: code === 'ENOTFOUND' ? '域名不存在' : `网络错误 ${code}` };
}

/** 探测单个 URL：成功返回 IP，失败抛错（hard.hard=true / soft.soft=原因） */
async function probeURL(source, url) {
  const u = source.method === 'jsonp' ? url.replace('{cb}', CB) : url;
  let res;
  try {
    res = await fetchText(u);
  } catch (e) {
    const c = classifyNetError(e);
    const err = new Error(c.soft || c.hard);
    if (c.soft) err.soft = c.soft;
    else err.hard = true;
    throw err;
  }
  if (res.status >= 400) throw hardErr(`HTTP ${res.status}`);
  const parsed = source.parse(payloadFor(source, res.text)) || {};
  const ip = typeof parsed.ip === 'string' ? parsed.ip.trim() : '';
  if (!util.ipFamily(ip)) throw hardErr('解析不出 IP');
  return ip;
}

/** 探测一个检测源：主端点 → alt 端点逐个试；soft 重试一次 */
async function checkTarget(target) {
  const urls = target.trace ? [`https://${target.host}/cdn-cgi/trace`] : [target.url, ...(target.alt || [])];
  let lastErr = null;
  for (const url of urls) {
    let err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ip = await probeURL(target, url);
        const via = url === urls[0] ? '' : `（经备用端点 ${new URL(url).host}）`;
        return { target, ok: true, ip, via };
      } catch (e) {
        err = e;
        if (e.soft && attempt === 0) {
          await sleep(RETRY_DELAY); // soft 重试一次再下结论
          continue;
        }
      }
      break;
    }
    lastErr = err;
    if (lastErr && lastErr.soft) break; // soft 不再换 alt：换尺子也量不出墙
  }
  return { target, ok: false, hard: lastErr && lastErr.hard ? lastErr.message : '', soft: lastErr && lastErr.soft ? lastErr.soft : '' };
}

/** trace 站点（splittest）单独判定：404/403 视为"不在 CF 或被挑战"，不算端点死亡 */
function judgeTrace(r) {
  if (r.ok) return r;
  if (/HTTP 40[34]/.test(r.hard)) return { ...r, hard: '', notcf: true };
  return r;
}

// ---------------- 报告 ----------------

function buildReport(results) {
  const bad = results.filter((r) => !r.ok && !r.notcf);
  const notcf = results.filter((r) => r.notcf);
  const okN = results.length - bad.length - notcf.length;
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' 北京时间';
  const rows = bad.map((r) => {
    const kind = r.target.trace ? '站点 trace' : r.target.group === 'cn' ? '国内源' : r.target.group === 'site' ? '网站视角' : '检测源';
    return `| ${r.target.name} | ${kind} | ❌ ${r.hard || `⚠️ ${r.soft}`} | ${r.target.url || r.target.host} |`;
  });
  const softNote = bad.some((r) => r.soft)
    ? '\n> ⚠️ 标「超时/网络」的条目可能是巡检机视角问题（如被目标站地域屏蔽），未必真死；连续多日出现再警惕。\n'
    : '';
  const lines = [
    `生成于 ${stamp}`,
    '',
    `汇总：${okN}/${results.length} 正常${notcf.length ? `，${notcf.length} 个站点已不回 trace（${notcf.map((r) => r.target.name).join('、')}）` : ''}`,
    '',
    bad.length ? '| 端点 | 类型 | 状态 | URL |' : '✅ 全部正常。',
    bad.length ? '|---|---|---|---|' : '',
    ...rows,
    softNote,
    '<!--health-check 自动维护，勿手改-->',
  ];
  const sig = crypto.createHash('sha1').update(rows.join('|') + notcf.map((r) => r.target.name).join('|')).digest('hex').slice(0, 10);
  return { body: lines.filter((l) => l !== '').join('\n'), bad, sig, okN, total: results.length };
}

// ---------------- GitHub Issue（Actions 内生效） ----------------

async function api(method, url, payload) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'safeip-health',
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function syncIssue({ body, bad, sig }) {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = `https://api.github.com/repos/${repo}`;
  const issues = await api('GET', `${base}/issues?state=open&per_page=100`);
  const mine = issues.find((x) => x.title === TITLE && !x.pull_request);

  if (!bad.length) {
    if (mine) {
      await api('POST', `${base}/issues/${mine.number}/comments`, { body: '✅ 全部恢复正常，自动关闭。' });
      await api('PATCH', `${base}/issues/${mine.number}`, { state: 'closed' });
      console.log('无异常；已关闭旧巡检 Issue #' + mine.number);
    } else {
      console.log('无异常。');
    }
    return;
  }

  if (mine) {
    if ((mine.body || '').includes(`sig:${sig}`)) {
      console.log(`异常与上次相同（sig:${sig}），不重复更新。`);
      return;
    }
    await api('PATCH', `${base}/issues/${mine.number}`, { body: `${body}\n<!--sig:${sig}-->` });
    console.log(`已更新巡检 Issue #${mine.number}（sig:${sig}）`);
  } else {
    const created = await api('POST', `${base}/issues`, { title: TITLE, body: `${body}\n<!--sig:${sig}-->` });
    console.log(`已创建巡检 Issue #${created.number}`);
  }
}

// ---------------- 主流程 ----------------

async function main() {
  console.log(`巡检开始：${ipTargets.length} 个 IP 检测源 + ${traceTargets.length} 个 trace 站点`);
  const results = (await util.pool([...ipTargets, ...traceTargets], CONCURRENCY, async (t) => {
    const r = await checkTarget(t);
    return t.trace ? judgeTrace(r) : r;
  })).filter(Boolean);

  const report = buildReport(results);
  console.log(`汇总：${report.okN}/${report.total} 正常，${report.bad.length} 异常`);

  // 熔断：hard 面过高说明多半是巡检机自身断网，降级不开 Issue
  const hardN = report.bad.filter((r) => r.hard).length;
  if (hardN > report.total * 0.6) {
    console.error(`⚠️ ${hardN}/${report.total} 为 hard 失败，超过熔断线，判定巡检机网络异常，跳过 Issue。`);
    return;
  }

  if (process.env.DRY_RUN) {
    console.log('--- DRY_RUN 报告 ---\n' + report.body);
    return;
  }
  await syncIssue(report);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
