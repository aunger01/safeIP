const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/splittest.js');
require('../js/logos.js');

const { splittest, logos } = globalThis.SafeIP;

test('品牌图标：内嵌 SVG，零外部引用（不越 CSP img-src）', () => {
  const hosts = Object.keys(logos.byHost);
  assert.ok(hosts.length >= 30, `品牌数量应不少于 30，实际 ${hosts.length}`);
  for (const [host, svg] of Object.entries(logos.byHost)) {
    assert.match(svg, /^<svg[\s>]/, `${host} 的图标不是内联 SVG`);
    assert.doesNotMatch(svg, /<image|href=["']https?:|src=["']https?:/, `${host} 的图标引用了外部资源`);
  }
});

test('品牌图标：按 host 大小写不敏感命中，未知名返回 null', () => {
  assert.ok(logos.get('chatgpt.com'));
  assert.ok(logos.get('ChatGPT.com'));
  assert.equal(logos.get('unknown-not-in-list.example'), null);
  assert.equal(logos.get(''), null);
});

test('分流站点：分流站迁入的站点已按本站四组归类', () => {
  const EXPECT = {
    ai: ['sora.com'],
    dev: ['testingcf.jsdelivr.net', 'cloudflaremirrors.com', 'kali.download', 'nodejs.org'],
    social: ['gateway.discord.gg', 'e-hentai.org', 'missav.ws', 'missav.ai', 'missav.live',
      'hanime1.me', 'hanimeone.me', 'hanime1.com', 'javchu.com', 'av.jkforum.net', 'javdb.com'],
    other: ['www.visa.com', 'www.okx.com', 'nav.l1n2.com'],
  };
  const byId = new Map(splittest.CATEGORIES.map((c) => [c.id, c.hosts]));
  for (const [id, hosts] of Object.entries(EXPECT)) {
    assert.ok(byId.has(id), `缺少分类 ${id}`);
    for (const h of hosts) assert.ok(byId.get(id).includes(h), `${h} 未归入 ${id}`);
  }
});

test('分流站点：全局无重复 host（同一站点不重复测）', () => {
  const all = splittest.CATEGORIES.flatMap((c) => c.hosts);
  const dup = all.filter((h, i) => all.indexOf(h) !== i);
  assert.deepEqual(dup, [], `重复站点：${dup.join('、')}`);
});

test('分流站点：主域无 trace 的站点不入清单（discord.com 实测 403）', () => {
  const all = splittest.CATEGORIES.flatMap((c) => c.hosts);
  assert.ok(!all.includes('discord.com'));
});
