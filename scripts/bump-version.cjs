#!/usr/bin/env node
'use strict';

/**
 * 静态资源版本戳工具（safeIP 无构建流程，用查询串破缓存）
 *
 *   node scripts/bump-version.cjs            # 生成新版本号并写入 index.html
 *   node scripts/bump-version.cjs 202611131530  # 指定版本号
 *   node scripts/bump-version.cjs --check    # 只校验：所有本地 js/css/manifest 都带同一版本号
 *
 * 为什么需要：GitHub Pages 对静态文件回 cache-control: max-age=600，前置 CDN 还会再缓存一层。
 * 只改 js 而名不变时，用户浏览器里旧脚本能顶住新 HTML，表现为「按钮点了没反应」「新功能没出现」。
 * 资源带 ?v= 后，每次发布换新地址，浏览器与 CDN 都会重新取。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

// 只处理本站本地资源（js/ 下全部脚本、样式表、manifest）
const REF = /(src|href)="((?:js\/[\w./-]+\.js|css\/style\.css|assets\/manifest\.webmanifest))(?:\?v=[^"]*)?"/g;
// 页脚可见版本号，便于一眼判断线上是不是最新版
const BADGE = /(id="build-ver"[^>]*>)v([A-Za-z0-9._-]+)(<)/;

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function refs(html) {
  return [...html.matchAll(REF)].map((m) => ({ attr: m[1], file: m[2], whole: m[0] }));
}

function check(html) {
  const list = refs(html);
  const issues = [];
  for (const r of list) {
    const tag = new RegExp(`\\s${r.attr}="${r.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?v=([^"]*))?"`).exec(html);
    const ver = tag && tag[2];
    if (!ver) issues.push(`${r.file} 缺少 ?v=`);
    else if (!/^[A-Za-z0-9._-]{4,40}$/.test(ver)) issues.push(`${r.file} 版本号格式异常: ${ver}`);
  }
  // 同一版本号必须全局一致，避免 js/css 不同步
  const versions = new Set(
    [...html.matchAll(/"(?:js\/[\w./-]+\.js|css\/style\.css|assets\/manifest\.webmanifest)\?v=([^"]*)"/g)].map((m) => m[1])
  );
  if (versions.size > 1) issues.push(`版本号不统一: ${[...versions].join(', ')}`);
  const badge = BADGE.exec(html);
  if (!badge) issues.push('页脚缺少 #build-ver 版本号');
  else if (versions.size === 1 && badge[2] !== [...versions][0]) {
    issues.push(`页脚版本号与资源版本不一致: v${badge[2]} ≠ v${[...versions][0]}`);
  }
  return { issues, versions: [...versions] };
}

function main() {
  const arg = process.argv[2];
  const html = fs.readFileSync(INDEX, 'utf8');

  if (arg === '--check') {
    const { issues, versions } = check(html);
    if (issues.length) {
      console.error('✗ 静态资源版本戳校验未通过：\n  - ' + issues.join('\n  - '));
      console.error('  → 运行 node scripts/bump-version.cjs 修复');
      process.exit(1);
    }
    console.log(`✓ 版本戳统一为 ${versions[0]}，共 ${refs(html).length} 处引用`);
    return;
  }

  const ver = arg || stamp();
  if (!/^[A-Za-z0-9._-]{4,40}$/.test(ver)) {
    console.error(`✗ 版本号非法: ${ver}`);
    process.exit(1);
  }

  let n = 0;
  let next = html.replace(REF, (whole, attr, file) => {
    n++;
    return `${attr}="${file}?v=${ver}"`;
  });
  next = next.replace(BADGE, `$1v${ver}$3`);

  if (n === 0) {
    console.error('✗ 未匹配到任何本地资源引用，检查 index.html 结构');
    process.exit(1);
  }

  fs.writeFileSync(INDEX, next);
  console.log(`✓ ${n} 处资源已打版本戳 ?v=${ver}`);
}

main();
