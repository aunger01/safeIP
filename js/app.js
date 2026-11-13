/* SafeIP · app.js — 启动：主题、隐藏 IP、复制、重新检测、进度条，然后挂载路由并开始检测 */
(function (root) {
  'use strict';
  const S = root.SafeIP;
  const { core, router, ui, analyze, sources } = S;
  const $ = (id) => document.getElementById(id);

  // ---------------- 主题：跟随系统 → 浅色 → 深色 ----------------
  const THEMES = { auto: ['contrast', '主题：跟随系统'], light: ['sun', '主题：浅色'], dark: ['moon', '主题：深色'] };
  const ORDER = ['auto', 'light', 'dark'];
  const store = {
    get(k) {
      try { return root.localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { root.localStorage.setItem(k, v); } catch (e) { /* 隐私模式等无法存储 */ }
    },
  };
  let theme = THEMES[store.get('safeip-theme')] ? store.get('safeip-theme') : 'auto';
  function applyTheme() {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const [ic, label] = THEMES[theme];
    const btn = $('theme');
    btn.innerHTML = ui.icon(ic);
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  $('theme').addEventListener('click', () => {
    theme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    store.set('safeip-theme', theme);
    applyTheme();
    ui.toast(THEMES[theme][1]);
  });
  applyTheme();

  // ---------------- 隐藏 IP ----------------
  $('mask').checked = core.state.mask;
  $('mask').addEventListener('change', (e) => core.setMask(e.target.checked));

  // ---------------- 复制 ----------------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const ok = await ui.copyText(btn.dataset.copy);
    ui.toast(ok ? `已复制 ${btn.dataset.copy}` : '复制失败，请检查浏览器的剪贴板权限');
  });

  $('copy').addEventListener('click', async () => {
    const v = core.view();
    const extra = [];
    const rk = v.route.intlExit && core.riskOf(v.route.intlExit);
    if (rk) {
      const f = rk.result.factors.map((x) => x.label).join('、');
      extra.push(`【IP 评分】国外出口 ${rk.result.score} 分（${rk.result.label}）${f ? `：${f}` : ''}`);
    }
    if (v.fp) extra.push(`【isChinaUser】${v.china.verdict}（${v.china.score} 分）`);
    const text = analyze.report({
      time: new Date(), groups: sources.GROUPS, sources: v.rows, exits: v.exits, route: v.route,
      geoOf: core.geoOf, typeOf: core.typeOf, rtc: v.rtc, rtcVerdict: v.rtcVerdict, dns: v.dns,
      dnsVerdict: v.dnsVerdict, conn: v.conn, fmt: core.fmt, extra,
    });
    const ok = await ui.copyText(text);
    ui.toast(ok ? (core.state.mask ? '已复制检测报告（IP 已打码）' : '已复制检测报告') : '复制失败，请检查浏览器的剪贴板权限');
  });

  // ---------------- 重新检测与进度 ----------------
  // 两段进度：IP 阶段（检测源+WebRTC+DNS）占 80%，连通性占 20%——
  // 连通性要等 IP 检测完才开始，若按条目均分进度条会在后段长时间停滞，观感像卡死
  $('rerun').addEventListener('click', () => core.start());
  core.on((v) => {
    const st = core.state;
    const bar = $('progress-bar');
    const ipPart = st.ipTotal ? Math.min(st.ipDone / st.ipTotal, 1) : 0;
    const connPart = st.connTotal ? st.connDone / st.connTotal : 0;
    bar.style.width = st.total ? `${(ipPart * 0.8 + connPart * 0.2) * 100}%` : '0';
    bar.parentElement.classList.toggle('done', v.finished);
    $('rerun').classList.toggle('is-busy', !v.finished);
  });

  // ---------------- 导出 JSON ----------------
  $('export').addEventListener('click', () => {
    const v = core.view();
    const fmt = core.fmt;
    const row = ({ meta, result: r }) => ({
      name: meta.name, host: meta.host, group: meta.group,
      ok: r ? r.ok : null, ip: r && r.ok ? fmt(r.ip) : null, cc: r && r.ok ? r.cc || null : null,
      location: r && r.ok ? r.location || null : null, isp: r && r.ok ? r.isp || null : null,
      ms: r && r.ok ? r.ms : null, error: r && !r.ok ? r.error : null,
    });
    const data = {
      tool: 'SafeIP', version: 1, time: new Date().toISOString(), masked: core.state.mask,
      route: {
        status: v.route.status, ipv4ExitCount: v.route.count,
        cnExit: v.route.cnExit ? fmt(v.route.cnExit) : null,
        intlExit: v.route.intlExit ? fmt(v.route.intlExit) : null,
        exceptions: v.route.exceptions.map((x) => ({ name: x.name, ip: fmt(x.ip) })),
      },
      exits: v.exits.map((e) => {
        const g = core.geoOf(e.ip);
        return {
          label: e.label, ip: fmt(e.ip), family: e.family,
          cc: (g && g.cc) || null, location: (g && g.location) || null, isp: (g && g.isp) || null,
          asn: g && g.asn ? `AS${g.asn}` : null, type: core.typeOf(e.ip).label,
          sources: e.sources.map((s) => s.name),
        };
      }),
      sources: v.rows.filter((x) => x.result).map(row),
      webrtc: {
        verdict: v.rtcVerdict.status,
        ips: (v.rtcVerdict.ips || []).map(fmt),
        servers: v.rtc.map(({ server, result: r }) => ({
          name: server.name, url: server.url, ok: r ? r.ok : null,
          ips: r && r.ok ? r.publicIPs.map(fmt) : [], error: r && !r.ok ? r.error || null : null,
        })),
      },
      dns: v.dns && {
        verdict: v.dnsVerdict.status,
        resolvers: v.dns.resolvers.map((r) => ({ ip: fmt(r.ip), cc: (core.geoOf(r.ip) || {}).cc || null })),
        errors: v.dns.errors,
      },
      connectivity: v.conn.map(({ site, result: r }) => ({
        name: site.name, host: site.host, group: site.group,
        ok: r ? r.ok : null, ms: r && r.ok ? (r.reuse != null ? r.reuse : r.first) : null,
      })),
      ai: v.ai.status === 'none' ? null : v.ai,
      china: v.fp ? { verdict: v.china.verdict, score: v.china.score, level: v.china.level } : null,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `safeip-report-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ui.toast(core.state.mask ? '已导出检测报告（IP 已打码）' : '已导出检测报告');
  });

  // 点击"更多"菜单以外的地方时收起菜单
  document.addEventListener('click', (e) => {
    const more = $('nav-more');
    if (more && more.open && !more.contains(e.target)) more.open = false;
  });

  /** 等浏览器画完下一帧再执行；后台标签页不触发 requestAnimationFrame，由定时器兜底 */
  function afterPaint(fn) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      fn();
    };
    requestAnimationFrame(() => setTimeout(run, 0));
    setTimeout(run, 200);
  }

  router.init();
  // 先把页面画出来再开始检测：启动检测要同步创建多个 WebRTC 连接，
  // 刚启动的浏览器里可能占用主线程一两秒，放在前面会让页面主体迟迟不出现
  afterPaint(() => core.start());
})(window);
