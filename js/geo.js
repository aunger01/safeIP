/* SafeIP · geo.js — IP 归属地 / 属性查询：多源合并，按 IP 缓存 */
(function (root) {
  'use strict';
  const SafeIP = (root.SafeIP = root.SafeIP || {});
  const { util } = SafeIP;
  const { place } = util;

  const parseAS = (s) => {
    const m = /^AS(\d+)\s*(.*)$/i.exec(String(s || '').trim());
    return m ? { asn: Number(m[1]), asnName: m[2] } : { asn: null, asnName: '' };
  };

  const enc = encodeURIComponent;

  /** 中文地名 → 国家码。海外源不给 cc、或给错时，用中文源的地名兜底，
   *  保证「地名说中国、旗子挂美国」这种自相矛盾不出现 */
  const CN_PROVINCE_RE = /^(中国|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/;
  function ccFromCnText(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (/香港/.test(s)) return 'HK';
    if (/澳门/.test(s)) return 'MO';
    if (/台湾/.test(s)) return 'TW';
    if (CN_PROVINCE_RE.test(s)) return 'CN';
    return '';
  }

  /** 各提供方：返回统一字段 { cc, location, locationEn, isp, asn, asnName } 的子集。
   *  原 ip-api（仅 HTTP，HTTPS 页面被浏览器拦截）已于 2026-11 移除；DNS EDNS 用的 edns.ip-api.com 走 HTTPS，与此无关 */
  const providers = {
    async zxinc(ip) {
      const { data } = await util.request(`https://ip.zxinc.org/api.php?type=json&ip=${enc(ip)}`);
      const x = (data && data.data) || {};
      if (data.code !== 0 || !x.country) throw util.makeError('parse');
      const countryText = String(x.country);
      return {
        cc: ccFromCnText(countryText),
        location: place(...countryText.split('–')),
        isp: util.clean(x.local),
      };
    },
    async baidu(ip) {
      const { data } = await util.jsonp(
        `https://opendata.baidu.com/api.php?query=${enc(ip)}&resource_id=6006&oe=utf8&format=json&cb={cb}`
      );
      const item = data && data.data && data.data[0];
      if (!item || !item.location) throw util.makeError('parse');
      const [loc, isp] = String(item.location).trim().split(/\s+/);
      return { cc: ccFromCnText(loc), location: loc, isp };
    },
    async ipsb(ip) {
      const { data } = await util.request(`https://api.ip.sb/geoip/${enc(ip)}`);
      if (!data || !data.country_code) throw util.makeError('parse');
      return {
        cc: data.country_code,
        locationEn: place(data.country, data.region, data.city),
        isp: data.isp || data.organization,
        asn: data.asn || null,
        asnName: data.asn_organization || '',
      };
    },
    async ipwhois(ip) {
      const { data } = await util.request(`https://ipwho.is/${enc(ip)}`);
      if (!data || data.success === false) throw util.makeError('parse');
      const c = data.connection || {};
      return {
        cc: data.country_code,
        locationEn: place(data.country, data.region, data.city),
        isp: c.isp,
        asn: c.asn || null,
        asnName: c.org || '',
      };
    },
    async ipinfo(ip) {
      const { data } = await util.request(`https://ipinfo.io/${enc(ip)}/json`);
      if (!data || data.bogon) throw util.makeError('parse');
      return { cc: data.country, locationEn: place(data.country, data.region, data.city), ...parseAS(data.org) };
    },
  };

  const SOURCE_NAME = {
    zxinc: 'ZXInc', baidu: '百度', ipsb: 'IP.SB', ipwhois: 'ipwho.is', ipinfo: 'ipinfo',
  };

  /** 每个字段按优先级取第一个非空值。cc 与 location 同源优先：
   *  中文源能判定中国（含港台澳）时以它为准，避免「地名中国 + 旗子别国」 */
  const PRIORITY = {
    location: ['zxinc', 'baidu'],
    locationEn: ['ipsb', 'ipwhois', 'ipinfo'],
    isp: ['zxinc', 'baidu', 'ipsb', 'ipwhois'],
    cc: ['zxinc', 'baidu', 'ipsb', 'ipwhois', 'ipinfo'],
    asn: ['ipsb', 'ipwhois', 'ipinfo'],
  };

  function pick(got, field) {
    for (const name of PRIORITY[field]) {
      const r = got[name];
      if (r && r[field] != null && r[field] !== '') return { value: r[field], from: name };
    }
    return null;
  }

  /** 纯函数：把各提供方的结果合并为 GeoInfo */
  function merge(ip, got) {
    const loc = pick(got, 'location') || pick(got, 'locationEn');
    const isp = pick(got, 'isp');
    const cc = pick(got, 'cc');
    const asn = pick(got, 'asn');
    // 一致性守卫：地名能明确判定为中国（含港台澳）时，旗子必须跟着地名走
    const ccFromLoc = ccFromCnText(loc ? loc.value : '');
    let ccValue = cc ? String(cc.value).toUpperCase() : '';
    if (ccFromLoc) ccValue = ccFromLoc;
    return {
      ip,
      cc: ccValue,
      location: loc ? loc.value : '',
      isp: isp ? isp.value : '',
      asn: asn ? asn.value : null,
      asnName: asn ? got[asn.from].asnName || '' : '',
      from: {
        location: loc ? SOURCE_NAME[loc.from] : '',
        asn: asn ? SOURCE_NAME[asn.from] : '',
      },
    };
  }

  async function doLookup(ip) {
    const got = {};
    const attempt = async (name) => {
      try {
        got[name] = await providers[name](ip);
      } catch (e) {
        got[name] = null;
      }
    };
    const first = ['zxinc', 'ipsb'];
    await Promise.all(first.map(attempt));
    if (!pick(got, 'location')) await attempt('baidu');
    if (!pick(got, 'asn') || !pick(got, 'cc')) await attempt('ipwhois');
    if (!pick(got, 'asn') || !pick(got, 'cc')) await attempt('ipinfo');
    return merge(ip, got);
  }

  // 同时查询的 IP 数上限：一次性并发太多时 IP.SB 等接口会返回 429
  const MAX_CONCURRENT = 3;
  let active = 0;
  const waiting = [];

  function limited(task) {
    return new Promise((resolve) => {
      const go = () => {
        active++;
        task()
          .catch(() => null)
          .then((value) => {
            active--;
            if (waiting.length) waiting.shift()();
            resolve(value);
          });
      };
      if (active < MAX_CONCURRENT) go();
      else waiting.push(go);
    });
  }

  const cache = new Map();

  /** 查询 IP 归属地，同一 IP 只查一次（缓存 Promise，永不 reject） */
  function lookup(ip) {
    if (!cache.has(ip)) cache.set(ip, limited(() => doLookup(ip)).then((g) => g || merge(ip, {})));
    return cache.get(ip);
  }

  const COMPARE_ORDER = ['zxinc', 'baidu', 'ipsb', 'ipwhois', 'ipinfo'];
  const compareCache = new Map();

  /** 多数据库对比：返回每个提供方各自的结果 */
  function compare(ip) {
    if (!compareCache.has(ip)) {
      compareCache.set(ip, limited(() => Promise.all(COMPARE_ORDER.map(async (id) => {
        const base = { id, name: SOURCE_NAME[id] };
        try {
          const r = await providers[id](ip);
          return { ...base, ok: true, ...r, location: r.location || r.locationEn || '' };
        } catch (e) {
          return { ...base, ok: false, error: typeof e.code === 'string' ? e.code : 'network' };
        }
      }))));
    }
    return compareCache.get(ip);
  }

  SafeIP.geo = { lookup, compare, merge };
})(typeof window !== 'undefined' ? window : globalThis);
