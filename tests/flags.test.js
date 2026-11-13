const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/flags.js');

const { flags } = globalThis.SafeIP;

test('国旗：常用国家全部内联 SVG，零外部引用（重绘不闪烁的前提）', () => {
  const ccs = Object.keys(flags.byCC);
  assert.ok(ccs.length >= 40, `内联国旗应不少于 40 面，实际 ${ccs.length}`);
  for (const [cc, svg] of Object.entries(flags.byCC)) {
    assert.match(svg, /^<svg[\s>]/, `${cc} 不是内联 SVG`);
    assert.doesNotMatch(svg, /<image|xlink:href=["']https?:|src=["']https?:/, `${cc} 引用了外部图片`);
    assert.doesNotMatch(svg, /url\(["']?https?:/, `${cc} 的滤镜/遮罩引用了外部资源`);
  }
});

test('国旗：常用国家码齐全且大小写不敏感', () => {
  for (const cc of ['cn', 'us', 'hk', 'tw', 'mo', 'jp', 'kr', 'sg', 'gb', 'de']) {
    assert.ok(flags.get(cc), `缺少 ${cc}`);
    assert.equal(flags.get(cc.toUpperCase()), flags.get(cc));
  }
  assert.equal(flags.get('zz'), null);
  assert.equal(flags.get(''), null);
});

test('国旗：内联 id 已按国家码前缀命名，同页多面旗不冲突', () => {
  const seen = new Map();
  for (const [cc, svg] of Object.entries(flags.byCC)) {
    for (const id of svg.match(/id="([^"]+)"/g) || []) {
      const name = id.slice(4, -1);
      assert.ok(name.startsWith(`${cc}-`), `${cc} 的 id「${name}」未加前缀，内联后会与其他国旗冲突`);
      assert.ok(!seen.has(name), `id「${name}」在多面国旗中重复`);
      seen.set(name, cc);
    }
  }
});
