const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/splittest.js');
require('../js/logos.js');

const { splittest, logos } = globalThis.SafeIP;

test('品牌图标：内嵌 SVG，零外部引用（不越 CSP img-src；data: 内嵌图除外）', () => {
  const all = [...Object.entries(logos.byHost), ...Object.entries(logos.byName)];
  assert.ok(all.length >= 60, `图标条目应不少于 60，实际 ${all.length}`);
  for (const [key, svg] of all) {
    assert.match(svg, /^<svg[\s>]/, `${key} 的图标不是内联 SVG`);
    assert.doesNotMatch(svg, /href=["']https?:|src=["']https?:/, `${key} 的图标引用了外部资源`);
    for (const m of svg.matchAll(/<image[^>]*href="([^"]*)"/g)) {
      assert.match(m[1], /^data:/, `${key} 的 image 引用了非 data: 资源`);
    }
  }
  assert.ok(logos.get('nav.l1n2.com'), '安杰导航站缺少品牌图标');
});

test('品牌图标：host 不分大小写、名称索引可命中，未知返回 null', () => {
  assert.ok(logos.get('chatgpt.com'));
  assert.ok(logos.get('ChatGPT.com'));
  assert.ok(logos.get('', 'ChatGPT'));
  assert.equal(logos.get('unknown-not-in-list.example'), null);
  assert.equal(logos.get(''), null);
});

test('品牌图标：国内品牌（阿里/腾讯/网易/字节/高通/CF 中国）按名称命中', () => {
  for (const name of ['阿里巴巴', '腾讯', '网易', '字节跳动', 'Cloudflare 中国网络', '高通中国']) {
    assert.ok(logos.get('', name), `${name} 缺少品牌图标`);
  }
});

test('品牌图标：国内检测源站全有标（含子品牌别名复用母品牌）', () => {
  for (const name of ['腾讯视频', 'DNSPod', 'DNSPod（国内）', 'IPIP.net', '又拍云', '太平洋电脑网']) {
    assert.ok(logos.get('', name), `${name} 缺少品牌图标`);
  }
  assert.equal(logos.get('', '腾讯视频'), logos.get('', '腾讯'), '腾讯视频应复用腾讯标');
});

test('分流站点：国内站单列一组，四大国内品牌在内', () => {
  const domestic = splittest.CATEGORIES.find((c) => c.id === 'domestic');
  assert.ok(domestic, '缺少「国内站点」分类');
  const names = domestic.items.map((id) => splittest.BY_ID.get(id).name);
  for (const n of ['阿里巴巴', '腾讯', '网易', '字节跳动']) assert.ok(names.includes(n), `${n} 未归入国内站点`);
});

test('分流站点：分类齐全（国内/AI/国际/开发/加密/社交/工具/NSFW）', () => {
  const ids = splittest.CATEGORIES.map((c) => c.id);
  for (const id of ['domestic', 'ai', 'intl', 'dev', 'crypto', 'social', 'tools', 'nsfw']) {
    assert.ok(ids.includes(id), `缺少分类 ${id}`);
  }
});

test('分流站点：每个条目都在探针表内，且全局无重复', () => {
  const all = splittest.CATEGORIES.flatMap((c) => c.items);
  for (const id of all) assert.ok(splittest.BY_ID.has(id), `未知探针 ${id}`);
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual(dup, [], `重复站点：${dup.join('、')}`);
});

test('分流探针：四类取数方式齐备，非 cf 的带齐接入参数', () => {
  const echos = new Set(splittest.PROBES.map((p) => p.echo));
  for (const e of ['cf', 'ali', 'qq', 'header']) assert.ok(echos.has(e), `缺少 ${e} 类探针`);
  for (const p of splittest.PROBES) {
    if (p.echo === 'cf') assert.ok(p.host, `${p.id} 缺 host`);
    if (p.echo === 'header') assert.ok(p.url && p.header, `${p.id} 缺 url/header`);
  }
});

test('分流站点：主域无 trace 的站点不入清单（discord.com 实测 403）', () => {
  assert.ok(!splittest.PROBES.some((p) => p.host === 'discord.com'));
  assert.ok(splittest.PROBES.some((p) => p.host === 'gateway.discord.gg'));
});
