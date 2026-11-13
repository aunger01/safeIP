/* SafeIP · 分流测试：多源 IP 检测 + Cloudflare 站点出口测试 + 自定义域名 */
(function (root) {
  'use strict';
  const S = root.SafeIP;
  const { ui, core, util, analyze, sources, splittest } = S;
  const { esc, icon } = ui;

  const page = {
    custom: [], // 自定义域名测试记录：{ host, result }
    traces: new Map(), // host → 结果
    running: false,

    mount(el) {
      el.innerHTML = `
        ${ui.pageHead({
          icon: 'route', title: '分流测试',
          desc: '同一时刻，国内服务、国外服务和常见网站各自看到的 IP。卡片顶部的颜色与字母对应首页的出口；不同网站走了不同出口，说明分流规则在生效。',
          actions: `<button type="button" class="btn" data-act="retest">${icon('refresh')}<span>重测站点</span></button>`,
        })}
        <div data-r="sources"></div>
        <section class="section">
          ${ui.subhead('常见网站出口测试', '', '读取网站的 Cloudflare 诊断页，看它实际收到的 IP；超时通常说明该域名没有走代理且被阻断')}
          <div data-r="sites"></div>
        </section>
        <section class="section">
          ${ui.subhead('测试自定义域名', '', '仅支持使用 Cloudflare 的网站')}
          <form class="search-bar" data-r="form">
            <input name="q" placeholder="例如 discord.com、openai.com" autocomplete="off" spellcheck="false" aria-label="域名">
            <button class="btn btn-primary" type="submit">${icon('search')}<span>测试</span></button>
          </form>
          <div class="grid" data-r="custom"></div>
        </section>`;
      this.el = el;
      el.querySelector('[data-act="retest"]').addEventListener('click', () => this.runSites(true));
      el.querySelector('[data-r="form"]').addEventListener('submit', (e) => {
        e.preventDefault();
        this.testCustom(e.target.q.value);
        e.target.q.value = '';
      });
      // 失败项单个重试：检测源走 core.rerunSource；trace 站点清缓存后单独重测
      el.addEventListener('click', (e) => {
        const src = e.target.closest('[data-retry]');
        if (src) {
          core.rerunSource(src.dataset.retry);
          return;
        }
        const traceBtn = e.target.closest('[data-retry-host]');
        if (traceBtn) this.retestHost(traceBtn.dataset.retryHost);
      });
      this.runSites(false);
      this.update();
    },

    async runSites(fresh) {
      if (this.running) return;
      this.running = true;
      if (fresh) this.traces.clear();
      const items = splittest.CATEGORIES.flatMap((c) => c.items);
      await util.pool(items, 6, async (id) => {
        const r = await splittest.trace(id, { fresh });
        if (r.ok) core.ensureGeo(r.ip);
        this.traces.set(id, r);
        S.router.refresh();
      });
      this.running = false;
      S.router.refresh();
    },

    async testCustom(input) {
      const host = util.normalizeHost(input);
      if (!host || util.ipFamily(host)) {
        ui.toast('请输入有效的域名');
        return;
      }
      const item = { host, result: null };
      this.custom = [item, ...this.custom.filter((x) => x.host !== host)].slice(0, 12);
      S.router.refresh();
      item.result = await splittest.traceHost(host, { fresh: true });
      if (item.result.ok) core.ensureGeo(item.result.ip);
      S.router.refresh();
    },

    /** 单独重测一个站点（卡片回骨架，防止连点：清缓存期间再点直接返回） */
    async retestHost(id) {
      if (!this.traces.has(id)) return;
      this.traces.delete(id);
      S.router.refresh();
      const r = await splittest.trace(id, { fresh: true });
      if (r.ok) core.ensureGeo(r.ip);
      this.traces.set(id, r);
      S.router.refresh();
    },

    update() {
      const v = core.view();
      const q = (k) => this.el.querySelector(`[data-r="${k}"]`);

      q('sources').innerHTML = Object.entries(sources.GROUPS).map(([gid, g]) => {
        const rows = v.rows.filter((x) => x.meta.group === gid);
        const okN = rows.filter((x) => x.result && x.result.ok).length;
        const doneN = rows.filter((x) => x.result).length;
        const body = gid === 'v6' && doneN === rows.length && okN === 0
          ? '<div class="empty">未检测到 IPv6 出口：你的网络可能没有 IPv6，或者 IPv6 已被禁用。</div>'
          : `<div class="grid">${rows.map((x) => sourceCard(v, x)).join('')}</div>`;
        return ui.subhead(g.title, `${okN}/${rows.length} 成功`, g.desc) + body;
      }).join('');

      q('sites').innerHTML = splittest.CATEGORIES.map((c) => {
        const done = c.items.filter((id) => this.traces.has(id));
        const okN = done.filter((id) => this.traces.get(id).ok).length;
        const block = ui.subhead(c.title, done.length ? `${okN}/${c.items.length} 可读取` : '测试中', c.desc)
          + `<div class="grid compact">${c.items.map((id) => traceCard(v, splittest.BY_ID.get(id), this.traces.get(id))).join('')}</div>`;
        // 成人内容单独置底：加虚线分隔并压低标题色，免得与常规站点混作一团
        return c.id === 'nsfw' ? `<div class="cat-nsfw"><div class="cat-sep" aria-hidden="true"></div>${block}</div>` : block;
      }).join('');

      q('custom').innerHTML = this.custom.map((x) => traceCard(v, { name: x.host, host: x.host, hint: '自定义域名' }, x.result)).join('');
    },
  };

  const RETRY_BTN = (attrs) => `<button type="button" class="icon-btn" ${attrs} aria-label="重试" title="重试">${icon('refresh')}</button>`;

  function sourceCard(v, { meta, result: r }) {
    if (!r) return `<article class="item">${ui.itemHead(meta.name, meta.host)}${ui.SKELETON}</article>`;
    if (!r.ok) {
      return `<article class="item is-err">${ui.itemHead(meta.name, meta.host, RETRY_BTN(`data-retry="${meta.id}"`))}<div class="item-ip">✕ ${esc(util.errorText(r.error))}</div></article>`;
    }
    const e = v.exitByIP.get(r.ip);
    const g = core.geoOf(r.ip);
    const x = r.extra || {};
    let extra = '';
    if (x.loc) {
      const warp = x.warp && x.warp !== 'off' ? ' · WARP' : '';
      extra = `<div class="item-note">网站判定 <b>${esc(util.countryName(x.loc))}</b>${x.colo ? ` · ${esc(x.colo)} 节点` : ''}${warp}</div>`;
      if (meta.ai && analyze.aiRegionRestricted(x.loc)) extra += `<div class="warn-chip">${ui.statusIcon('warning')}该地区可能不受支持</div>`;
    }
    const loc = (g && g.location) || r.location;
    const isp = [(g && g.isp) || r.isp, g && g.asn ? `AS${g.asn}` : ''].filter(Boolean).join(' · ');
    return `<article class="item${e ? ` has-exit ${ui.exitClass(e)}` : ''}">
      ${ui.itemHead(meta.name, meta.host, e ? ui.exitTag(e) : '')}
      <div class="item-ip">${ui.ipText(r.ip)}${ui.copyBtn(r.ip)}</div>
      <div class="item-loc">${ui.ccBadge((g && g.cc) || r.cc)}<span>${loc ? esc(loc) : g ? '未知地区' : '<span class="skel w60"></span>'}</span></div>
      ${extra}
      <div class="item-foot"><span>${esc(isp || '—')}</span><span class="ms">${icon('clock')}${ui.fmtMs(r.ms)}</span></div>
    </article>`;
  }

  function traceCard(v, p, r) {
    const sub = p.host || p.hint || '';
    if (!r) return `<article class="item mini">${ui.itemHead(p.name, sub)}<span class="skel w60"></span></article>`;
    if (!r.ok) {
      return `<article class="item mini is-err">${ui.itemHead(p.name, util.errorText(r.error), RETRY_BTN(`data-retry-host="${esc(p.id)}"`))}</article>`;
    }
    const e = v.exitByIP.get(r.ip);
    const g = core.geoOf(r.ip);
    const right = e ? ui.exitTag(e) : '<span class="chip" title="首页的检测源没有看到这个 IP">新出口</span>';
    const restricted = p.ai && r.loc && analyze.aiRegionRestricted(r.loc);
    const where = r.colo ? `${util.countryName(r.loc)} · ${r.colo} 节点` : (r.geo || p.hint || sub);
    return `<article class="item mini${e ? ` has-exit ${ui.exitClass(e)}` : ''}">
      ${ui.itemHead(p.name, where, right)}
      <div class="item-ip">${ui.ipText(r.ip)}</div>
      <div class="item-foot"><span>${ui.ccBadge(r.loc)} ${esc((g && g.isp) || '')}</span><span class="ms">${icon('clock')}${ui.fmtMs(r.ms)}</span></div>
      ${restricted ? `<div class="warn-chip">${ui.statusIcon('warning')}该地区可能不受支持</div>` : ''}
    </article>`;
  }

  S.pages.split = page;
})(window);
