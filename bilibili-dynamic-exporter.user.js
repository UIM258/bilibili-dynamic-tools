// ==UserScript==
// @name         B站动态提取导出器
// @name:zh-CN   B站动态提取导出器
// @namespace    https://github.com/UIM258/bilibili-dynamic-tools
// @version      1.4.0
// @description  B站用户空间动态提取导出：按日期范围与内容类型（图文/收藏夹/视频/小视频/转发/纯文字/专栏/卡片）筛选，导出 JSON/CSV/HTML 或 TG式ZIP；视频可选清晰度(360P~1080P+)、本地视频直达、图片/表情/音频可选，含投票抽奖明细，支持分卷与进度续传
// @description:zh-CN  B站用户空间动态提取导出：按日期范围与内容类型（图文/收藏夹/视频/小视频/转发/纯文字/专栏/卡片）筛选，导出 JSON/CSV/HTML 或 TG式ZIP；视频可选清晰度(360P~1080P+)、本地视频直达、图片/表情/音频可选，含投票抽奖明细，支持分卷与进度续传
// @author       UIM258
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @match        https://space.bilibili.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    var TAG = '[B站导出]';
    var m = location.pathname.match(/^\/(\d+)(?:\/|$)/);
    if (!m) { return; }
    var UID = m[1];

    var CFG = { delay: 450, minDelay: 150, maxDelay: 4000, retries: 3, requestTimeout: 15000, maxPages: 5000 };

    var S = {
        theme: 'auto',
        posts: [],
        offset: '',
        hasMore: true,
        running: false,
        paused: false,
        stop: false,
        name: '',
        avatar: '',
        finished: false,
        lastError: ''
    };
    var els = {};
    var timer = null;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtTs(sec) { if (!sec) return ''; var d = new Date(Number(sec) * 1000); if (isNaN(d.getTime())) return ''; return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    function dateOfTs(sec) { var s = fmtTs(sec); return s ? s.slice(0, 10) : ''; }
    function fmtNow() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()); }
    function statCount(x) { if (x == null) return 0; if (typeof x === 'object') return Number(x.count || 0) || 0; return Number(x) || 0; }
    function fmtNum(v) { var n = Number(v) || 0; return n >= 100000000 ? (n / 100000000).toFixed(1) + '亿' : (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n)); }
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function plainText(h) { return String(h || ''); }
    function stripHtmlTags(html) {
        var tpl = document.createElement('template');
        tpl.innerHTML = (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6])>/gi, '\n');
        return (tpl.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    function safeTitle(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'article'; }
    function articleRel(p) { return 'articles/cv' + p.article.id + '_' + safeTitle(p.article.title) + '.html'; }
    function stripRich(rich, fallback) { if (!rich || !rich.length) return fallback || ''; var out = ''; rich.forEach(function (x) { if (!x) return; if (x.type === 'RICH_TEXT_NODE_TYPE_EMOJI') { out += '[' + (x.text || '表情') + ']'; } else { out += x.text || x.orig_text || ''; } }); return out || fallback || ''; }

    function apiUrl(offset) {
        return 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=' + UID +
            '&offset=' + encodeURIComponent(offset || '') +
            '&timezone_offset=-480&features=itemOpusStyle,listOnlyfans,deadSpace,newFace,baseColorImage';
    }
    function fetchRaw(offset) {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, CFG.requestTimeout);
        return fetch(apiUrl(offset), { credentials: 'include', signal: ctrl.signal })
            .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (j) { if (!j || j.code !== 0) throw new Error('code=' + (j && j.code) + ' ' + (j && j.message)); var d = j.data || {}; return { items: d.items || [], offset: d.offset || '', hasMore: !!d.has_more }; })
            .catch(function (e) { clearTimeout(t); if (e && e.name === 'AbortError') throw new Error('请求超时'); throw e; });
    }
    function pickText(md, major) {
        if (md && md.desc && md.desc.text) return { text: md.desc.text, rich: md.desc.rich_text_nodes || null };
        if (major && major.opus && major.opus.summary && major.opus.summary.text) return { text: major.opus.summary.text, rich: major.opus.summary.rich_text_nodes || null };
        return null;
    }
    function parseDurationSec(txt) {
        if (!txt) return 0;
        var p = String(txt).split(':').map(function (x) { return parseInt(x, 10) || 0; });
        if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
        if (p.length === 2) return p[0] * 60 + p[1];
        return p[0] || 0;
    }
    function labelOf(it) {
        var t = it.type || '';
        var md = (it.modules && it.modules.module_dynamic) || {};
        var major = md.major || {};
        if (t === 'DYNAMIC_TYPE_FORWARD') return '转发';
        if (major.type === 'MAJOR_TYPE_ARCHIVE' || t === 'DYNAMIC_TYPE_AV') {
            var a = major.archive || {};
            var badge = (a.badge && a.badge.text) || '';
            var dur = parseDurationSec(a.duration_text);
            if (badge.indexOf('小视频') > -1) return '小视频';   // 仅按标签识别，时长不作为依据
            return '视频';
        }
        if (t === 'DYNAMIC_TYPE_ARTICLE' || major.type === 'MAJOR_TYPE_ARTICLE') return '专栏';
        if (t === 'DYNAMIC_TYPE_WORD') return '纯文字';
        if (major.type === 'MAJOR_TYPE_MEDIALIST') return '收藏夹';
        if (major.type === 'MAJOR_TYPE_OPUS' || t === 'DYNAMIC_TYPE_DRAW' || t === 'DYNAMIC_TYPE_DYN') return '图文';
        if (major.type === 'MAJOR_TYPE_LIVE') return '直播';
        if (major.type === 'MAJOR_TYPE_COMMON') return '卡片';
        return '其他';
    }
    function norm(it) {
        var md = (it.modules && it.modules.module_dynamic) || {};
        var au = (it.modules && it.modules.module_author) || {};
        var stat = (it.modules && it.modules.module_stat) || {};
        var major = md.major || {};
        var o = {
            dynId: it.id_str || it.id || '',
            type: it.type || '',
            typeLabel: labelOf(it),
            ts: Number(au.pub_ts || 0),
            time: fmtTs(au.pub_ts),
            date: dateOfTs(au.pub_ts),
            author: au.name || '',
            face: au.face || '',
            url: it.id_str ? ('https://t.bilibili.com/' + it.id_str) : '',
            reposts: statCount(stat.forward),
            comments: statCount(stat.comment),
            likes: statCount(stat.like)
        };
        var src = pickText(md, major);
        if (src) { o.text = src.text || ''; o.rich = src.rich || null; o.textPlain = stripRich(src.rich, src.text); }
        var dc = au.decoration_card;
        if (dc && (dc.name || dc.card_url)) o.dress = { name: dc.name || '', pic: dc.card_url || '' };
        // 图片
        if (major.type === 'MAJOR_TYPE_OPUS') {
            var pics = (major.opus && major.opus.pics) || [];
            o.pics = pics.map(function (p) { return p.url || p.src || ''; }).filter(Boolean);
        } else if (major.type === 'MAJOR_TYPE_DRAW') {
            var dp = (major.draw && major.draw.items) || [];
            o.pics = dp.map(function (x) { return x.src || x.url || ''; }).filter(Boolean);
        }
        if (major.type === 'MAJOR_TYPE_ARCHIVE') {
            var a = major.archive || {};
            o.video = { title: a.title || '', bvid: a.bvid || '', pic: a.cover || a.pic || '', url: a.bvid ? ('https://www.bilibili.com/video/' + a.bvid) : '', duration: a.duration_text || '' };
            o.isShort = (o.typeLabel === '小视频');
            if (!o.text) { o.text = a.title || ''; o.textPlain = a.title || ''; }
        } else if (major.type === 'MAJOR_TYPE_ARTICLE') {
            var ar = major.article || {};
            o.article = { title: ar.title || '', id: ar.id || '', pic: ar.cover || '', url: ar.id ? ('https://www.bilibili.com/read/cv' + ar.id) : '' };
            if (!o.text) { o.text = ar.title || ''; o.textPlain = ar.title || ''; }
        } else if (major.type === 'MAJOR_TYPE_LIVE') {
            var lv = major.live || {};
            o.live = { title: lv.title || lv.desc || '', pic: lv.cover || lv.cover_url || '' };
            if (!o.text) { o.text = o.live.title; o.textPlain = o.live.title; }
        } else if (major.type === 'MAJOR_TYPE_MEDIALIST') {
            var ml = major.medialist || {};
            o.medialist = { title: ml.name || ml.title || '', id: ml.id || ml.media_id || '', pic: ml.cover || '', url: ml.id ? ('https://space.bilibili.com/' + UID + '/medialist/detail/ml' + ml.id) : '' };
            if (!o.text) { o.text = o.medialist.title; o.textPlain = o.medialist.title; }
        } else if (major.type === 'MAJOR_TYPE_COMMON') {
            var cm = major.common || {};
            o.common = { title: cm.title || '', desc: cm.desc || '', pic: cm.cover || cm.pic || '', url: cm.jump_url || cm.url || '' };
            if (!o.text) { o.text = cm.title + (cm.desc ? ' ' + cm.desc : ''); o.textPlain = o.text; }
        }
        if (major.type === 'MAJOR_TYPE_MUSIC' || major.type === 'MAJOR_TYPE_AUDIO') {
            var mus = major.music || major.audio || {};
            var sid = mus.id || mus.sid || mus.music_id || '';
            o.music = { title: mus.title || mus.name || '', id: sid, pic: mus.cover || mus.cover_url || '', url: sid ? ('https://www.bilibili.com/audio/au' + sid) : '' };
            if (!o.text) { o.text = o.music.title; o.textPlain = o.music.title; }
        }
        // 附加卡片
        var add = md.additional;
        if (add) {
            var sub = add.vote || add.common || add.match || add.ugc || add.reserve || add.upower_lottery || add.goods || null;
            if (sub && typeof sub === 'object') {
                var d1 = sub.desc1 && sub.desc1.text ? sub.desc1.text : '';
                var d2 = sub.desc2 && sub.desc2.text ? sub.desc2.text : '';
                o.add = { kind: add.type || '', title: sub.title || sub.text || d1 || d2 || '', desc: (d2 && d2 !== (sub.title || d1)) ? d2 : '', url: sub.jump_url || sub.url || '', badge: sub.badge_text || '' };
                o.add.raw = sub;                 // 完整保留（投票/抽奖选项与结果的原始数据）
                var opts = sub.options || sub.option_list || sub.items || sub.choices || null;
                if (Array.isArray(opts) && opts.length) {
                    o.add.options = opts.map(function (op) {
                        var cnt = (op.cnt != null) ? op.cnt : (op.count != null ? op.count : (op.num != null ? op.num : op.votes));
                        return { text: op.text || op.option || op.title || op.desc || '', count: (cnt != null ? cnt : null) };
                    });
                }
                o.add.joinNum = (sub.join_num != null ? sub.join_num : (sub.join_count != null ? sub.join_count : (sub.total != null ? sub.total : sub.participate_num)));
                o.add.endTime = sub.end_time || sub.end_ts || sub.deadline || null;
                o.add.drawTime = sub.draw_time || sub.lottery_time || null;
                var prizes = sub.prize_list || sub.prizes || null;
                if (Array.isArray(prizes)) o.add.prizes = prizes.map(function (z) { return (typeof z === 'string') ? z : (z.name || z.title || z.prize || z.desc || ''); }).filter(Boolean);
                else if (sub.prize || sub.prize_name) o.add.prizes = [sub.prize || sub.prize_name];
            }
        }
        // 转发
        var orig = md.orig || it.orig;
        if (orig) {
            var ou = (orig.modules && orig.modules.module_author) || {};
            var omd = (orig.modules && orig.modules.module_dynamic) || {};
            var omajor = omd.major || {};
            var osrc = pickText(omd, omajor);
            var f = { name: ou.name || '', time: fmtTs(ou.pub_ts), type: orig.type || '', typeLabel: labelOf(orig) };
            if (osrc) { f.text = osrc.text || ''; f.rich = osrc.rich || null; f.textPlain = stripRich(osrc.rich, osrc.text); }
            if (!f.textPlain) {
                if (omajor.type === 'MAJOR_TYPE_ARCHIVE' && omajor.archive) f.textPlain = omajor.archive.title;
                else if (omajor.type === 'MAJOR_TYPE_OPUS' && omajor.opus && omajor.opus.summary) f.textPlain = omajor.opus.summary.text || '';
            }
            if (omajor.type === 'MAJOR_TYPE_ARCHIVE' && omajor.archive) f.video = { title: omajor.archive.title || '', bvid: omajor.archive.bvid || '', url: omajor.archive.bvid ? ('https://www.bilibili.com/video/' + omajor.archive.bvid) : '', pic: omajor.archive.cover || omajor.archive.pic || '' };
            else if (omajor.type === 'MAJOR_TYPE_OPUS') { var ops = (omajor.opus && omajor.opus.pics) || []; if (ops.length) f.picCount = ops.length; }
            o.forward = f;
        }
        return o;
    }

    // ============ 筛选 ============
    function kinds() {
        function ck(id) { var el = document.getElementById(id); return !!(el && el.checked); }
        return {
            pic: ck('bdx-k-pic'), fav: ck('bdx-k-fav'), video: ck('bdx-k-video'), short: ck('bdx-k-short'),
            rt: ck('bdx-k-rt'), word: ck('bdx-k-word'), article: ck('bdx-k-article'), other: ck('bdx-k-other')
        };
    }
    function kindOf(label) {
        if (label === '图文') return 'pic';
        if (label === '收藏夹') return 'fav';
        if (label === '视频') return 'video';
        if (label === '小视频') return 'short';
        if (label === '转发') return 'rt';
        if (label === '纯文字') return 'word';
        if (label === '专栏') return 'article';
        return 'other';
    }
    function matchPost(p) {
        var k = kinds();
        return !!k[kindOf(p.typeLabel)];
    }

    // ============ 抓取 ============
    function setStatus(t, isErr) { if (els.status) { els.status.textContent = t; els.status.className = 'bdx-status' + (isErr ? ' bdx-err' : ''); } }
    function updateUI() {
        var btn = els;
        btn.start.disabled = S.running;
        btn.pause.disabled = !S.running;
        btn.resume.disabled = S.running || !S.paused;
        btn.stop.disabled = !S.running && !S.paused;
        els.progress.textContent = '已抓取 ' + S.posts.length + ' 条动态' + (S.hasMore ? '（未到底）' : '（已到底）') + ' · ' + (S.name || '') ;
        els.progress.style.color = '#00aeec';
    }

    async function runLoop() {
        var from = els.fromDate.value || '';
        var to = els.toDate.value || '';
        if (from && to && from > to) { setStatus('开始日期不能晚于结束日期。', true); return; }
        S.posts = []; S.offset = ''; S.hasMore = true; S.running = true; S.paused = false; S.stop = false; S.finished = false; S.name=''; S.avatar='';
        var delay = parseInt(els.delay.value, 10); if (!(delay >= CFG.minDelay)) delay = CFG.delay;
        updateUI();
        var attempt = 0;
        while (S.running && !S.stop) {
            if (S.paused) { await sleep(300); continue; }
            setStatus('正在抓取第 ' + Math.ceil((S.posts.length + 1) / 12) + ' 批…（已 ' + S.posts.length + ' 条，' + (S.hasMore ? '可暂停' : '即将结束') + '）');
            var page;
            try { page = await fetchRaw(S.offset); attempt = 0; }
            catch (e) {
                attempt++;
                if (attempt <= CFG.retries) { var w = Math.min(CFG.maxDelay, 1000 * Math.pow(2, attempt)); setStatus('失败（' + e.message + '），' + w + 'ms 后重试…', true); await sleep(w); continue; }
                S.running = false; S.paused = true; S.lastError = e.message;
                setStatus('连续失败：' + e.message + '（已暂停，可稍后继续）', true);
                updateUI(); return;
            }
            var items = page.items || [];
            var pageOldest = '';
            var reachedTo = !to;
            for (var i = 0; i < items.length; i++) {
                var p = norm(items[i]);
                if (!pageOldest && p.date) pageOldest = p.date;
                if (p.date > to) continue;       // 比结束日期新，跳过（B站无服务端日期过滤）
                if (p.date < from) continue;     // 比开始日期旧，跳过
                if (!matchPost(p)) continue;
                if (!S.name && p.author) S.name = p.author;
                if (!S.avatar && p.face) S.avatar = p.face;
                if (p.typeLabel === '专栏' && (!p.article || !p.article.id)) {
                    try {
                        setStatus('解析专栏信息…');
                        var dj = await fetchJson('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=' + p.dynId);
                        var ditem = dj && dj.data && dj.data.item;
                        var dmaj = ditem && ditem.modules && ditem.modules.module_dynamic && ditem.modules.module_dynamic.major;
                        var dar = dmaj && dmaj.article;
                        if (dar && dar.id) {
                            var jump = dar.jump_url || '';
                            if (jump.indexOf('//') === 0) jump = 'https:' + jump;
                            p.article = { id: dar.id, title: dar.title || '', cover: (dar.covers && dar.covers[0] && (dar.covers[0].url || dar.covers[0])) || '', url: jump || ('https://www.bilibili.com/read/cv' + dar.id) };
                        }
                    } catch (e) { console.warn('专栏信息解析失败', p.dynId, e); }
                    await sleep(150);
                }
                if (p.article && p.article.id) {
                    try {
                        setStatus('抓取专栏全文 cv' + p.article.id + ' …');
                        var av = await fetchJson('https://api.bilibili.com/x/article/view?id=' + p.article.id);
                        var ad = av && av.data;
                        if (ad) {
                            p.article.contentHtml = ad.content || '';
                            p.article.textPlain = stripHtmlTags(ad.content || '').slice(0, 200000);
                            p.article.images = ad.origin_image_urls || ad.image_urls || [];
                            p.article.words = ad.words || 0;
                            p.article.author = (ad.author && ad.author.name) || '';
                            p.article.publishTime = ad.publish_time || ad.ctime || 0;
                        }
                    } catch (e) { console.warn('专栏全文抓取失败', p.article.id, e); }
                    await sleep(150);
                }
                S.posts.push(p);
            }
            S.offset = page.offset; S.hasMore = !!page.hasMore;
            updateUI();
            if (!page.hasMore || !items.length) { break; }
            if (from && pageOldest && pageOldest < from) { break; }  // 这一批已比开始日期更早
            await sleep(delay);
        }
        if (S.stop) { S.running = false; S.paused = false; setStatus('已停止：共收集 ' + S.posts.length + ' 条。'); }
        else if (S.paused) { S.running = false; }
        else { S.running = false; S.finished = true; setStatus('完成：' + from + ' ~ ' + (to || '最新') + ' 共导出 ' + S.posts.length + ' 条。'); }
        updateUI();
    }
    function start() { if (!S.running) { runLoop(); } }
    function pause() { if (S.running) { S.paused = true; setStatus('已暂停…点继续接着抓。'); updateUI(); } }
    function resume() { if (!S.running && S.paused) { S.paused = false; S.running = true; S.stop = false; updateUI(); runLoop(); } }
    function stopAll() { if (S.running || S.paused) { S.stop = true; } }

    // ============ 导出 ============
    function buildJSON() {
        return JSON.stringify({ exported_at: new Date().toISOString(), uid: UID, name: S.name, avatar: S.avatar, total: S.posts.length, posts: S.posts }, null, 2);
    }
    function csvEscape(v) { var s = String(v === undefined || v === null ? '' : v); if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; }
    function buildCSV() {
        var head = ['时间', '日期', '类型', '作者', '正文', '图片数', '视频标题', '视频BV号', '是否转发', '转发作者', '转发正文', '点赞', '评论', '转发数', '附加详情', '专栏字数', '动态链接'];
        var rows = [head.join(',')];
        S.posts.forEach(function (p) {
            rows.push([
                csvEscape(p.time), csvEscape(p.date), csvEscape(p.typeLabel), csvEscape(p.author), csvEscape(p.textPlain),
                (p.pics || []).length,
                csvEscape(p.video ? p.video.title : ''), csvEscape(p.video ? p.video.bvid : ''),
                p.forward ? '是' : '否',
                csvEscape(p.forward ? p.forward.name : ''), csvEscape(p.forward ? p.forward.textPlain : ''),
                p.likes, p.comments, p.reposts,
                csvEscape(p.add ? JSON.stringify({ kind: p.add.kind, options: p.add.options || null, prizes: p.add.prizes || null, joinNum: p.add.joinNum != null ? p.add.joinNum : null, endTime: p.add.endTime || null }) : ''),
                (p.article && p.article.words ? p.article.words : ''),
                csvEscape(p.url)
            ].join(','));
        });
        return '\uFEFF' + rows.join('\r\n');
    }

    // ============ HTML 生成（分卷/主题/离线媒体） ============
    var AV_URI = null;
    function loadAvatarData() {
        if (!S.avatar || AV_URI) return Promise.resolve();
        return fetchBytes(S.avatar).then(function (bytes) {
            return new Promise(function (res) {
                try { var blob = new Blob([bytes]); var fr = new FileReader(); fr.onload = function () { AV_URI = fr.result; res(); }; fr.onerror = function () { res(); }; fr.readAsDataURL(blob); }
                catch (e) { res(); }
            });
        }).catch(function () {});
    }
    function themeClass() {
        var v = 'auto'; try { var r = document.querySelector('input[name=bdx-theme]:checked'); if (r) v = r.value; } catch (e) {}
        return v === 'dark' ? ' class="dark"' : (v === 'light' ? ' class="light"' : '');
    }
    function fileNameOf(u, i, dynId, fallback) {
        var s = String(u || '').split('?')[0];
        var seg = s.split('/').pop() || '';
        var m = seg.match(/([^\/\?#]+\.(?:jpg|jpeg|png|gif|webp))$/i);
        var base = m ? m[1] : ((dynId || 'img') + '_' + (i + 1) + '.' + (fallback || 'jpg'));
        return (dynId ? (dynId + '_' + (i + 1) + '_' + base) : base);
    }
    function richHtml(rich, fallback, map) {
        if (!rich || !rich.length) return esc(fallback || '');
        var h = '';
        rich.forEach(function (x) {
            if (!x) return;
            if (x.type === 'RICH_TEXT_NODE_TYPE_EMOJI') {
                var e = x.emoji || {};
                var u = e.gif_url || e.webp_url || e.icon_url || x.icon_url || '';
                var src = (map && u && map[u]) ? map[u] : u;
                h += src ? '<img class="emot" src="' + esc(src) + '" alt="' + esc(x.text || '') + '"/>' : esc(x.text || '');
            } else h += esc(x.text || x.orig_text || '');
        });
        return h;
    }
    function volName(i) { return i === 1 ? 'messages.html' : 'messages' + i + '.html'; }
    function extOf(url) { var s = String(url || '').split('?')[0]; var m = s.match(/\.(jpg|jpeg|png|gif|webp)$/i); return m ? ('.' + m[1].toLowerCase()) : '.jpg'; }
    function safeOf(url) { var s = String(url || '').split('?')[0]; var seg = s.split('/').pop() || ''; seg = seg.replace(/[^A-Za-z0-9._-]/g, '_'); return seg || ('cover' + Math.random().toString(36).slice(2, 6) + '.jpg'); }
    function buildPageHtml(chunk, cfg) {
        function lu(url) { if (cfg.offline && cfg.map && cfg.map[url]) return cfg.map[url]; return url; }
        var cards = chunk.map(function (p, idx) {
            var h = '<div class="pcard" data-i="' + idx + '">';
            h += '<div class="head"><img class="face" src="' + esc(lu(p.face || S.avatar)) + '" alt=""/>';
            h += '<div class="who"><span class="nm">' + esc(p.author || S.name) + '</span><span class="meta">' + esc(p.time || '') + '</span>';
            if (p.dress) h += '<span class="dress">' + (p.dress.pic ? '<img src="' + esc(p.dress.pic) + '" alt=""/>' : '') + esc(p.dress.name) + '</span>';
            h += '</div><span class="tag">' + esc(p.typeLabel) + '</span></div>';
            if (p.textPlain) h += '<div class="txt">' + richHtml(p.rich, p.textPlain, cfg.offline ? cfg.map : null) + '</div>';
            if (p.pics && p.pics.length) {
                h += '<div class="imgs' + (p.pics.length === 1 ? ' one' : '') + '">';
                p.pics.forEach(function (u, j) {
                    var nm = fileNameOf(u, j, p.dynId);
                    var loc = cfg.offline ? ((cfg.map && cfg.map[u]) || u) : u;
                    h += '<a class="cell" href="' + esc(loc) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + esc(loc) + '" alt=""/></a>';
                });
                h += '</div>';
            }
            if (p.video) { h += '<div class="video"><img src="' + esc(lu(p.video.pic)) + '" alt=""/><a href="' + esc(p.video.url) + '" target="_blank" rel="noopener">' + esc(p.video.title) + '</a>'; var vl = (cfg.map && p.video.bvid) ? cfg.map['video:' + p.video.bvid] : ''; if (vl) { var mp4 = vl.replace(/_video\.m4s$/, '.mp4'); h += '<a class="loc" href="' + esc(mp4) + '" target="_blank" rel="noopener" title="运行合并视频.bat 后可直接播放">▶ 本地视频(合并后)</a>'; } h += '</div>'; }
            if (p.article) { var al = (cfg.offline && cfg.map && p.article.id) ? cfg.map['article:' + p.article.id] : ''; h += '<div class="art"><a href="' + esc(al || p.article.url) + '" target="_blank" rel="noopener">' + esc(p.article.title) + '</a><span class="artlink">' + (al ? '（本地全文 ↗）' : '（在线全文 ↗）') + '</span></div>'; }
            if (p.medialist) h += '<div class="art"><a href="' + esc(p.medialist.url) + '" target="_blank" rel="noopener">收藏：' + esc(p.medialist.title) + '</a></div>';
            if (p.add) {
                h += '<div class="add">' + (p.add.badge ? '<b>' + esc(p.add.badge) + '</b>' : '') + esc(p.add.title) + (p.add.desc ? '<small>' + esc(p.add.desc) + '</small>' : '') + (p.add.url ? '<a href="' + esc(p.add.url) + '" target="_blank">查看 ↗</a>' : '');
                if (p.add.options && p.add.options.length) {
                    h += '<ul class="addopts">';
                    p.add.options.forEach(function (op) { h += '<li>' + esc(op.text) + (op.count != null ? ' <b>' + fmtNum(op.count) + '</b>' : '') + '</li>'; });
                    h += '</ul>';
                }
                if (p.add.prizes && p.add.prizes.length) h += '<div class="addprize">奖品：' + esc(p.add.prizes.join(' / ')) + (p.add.drawTime ? ' · 开奖 ' + esc(String(p.add.drawTime)) : '') + '</div>';
                if (p.add.joinNum != null) h += '<div class="addd">参与 ' + fmtNum(p.add.joinNum) + ' 人' + (p.add.endTime ? ' · 截止 ' + esc(String(p.add.endTime)) : '') + '</div>';
                h += '</div>';
            }
            if (p.forward) {
                h += '<div class="fwd"><div class="fh">@' + esc(p.forward.name) + (p.forward.time ? ' · ' + esc(p.forward.time) : '') + '（' + esc(p.forward.typeLabel) + '）</div><div class="ft">' + richHtml(p.forward.rich, p.forward.textPlain, cfg.offline ? cfg.map : null) + '</div>';
                if (p.forward.video) h += '<div class="fv">视频：<a href="' + esc(p.forward.video.url) + '" target="_blank">' + esc(p.forward.video.title) + '</a></div>';
                h += '</div>';
            }
            h += '<div class="stats"><span>转发 ' + fmtNum(p.reposts) + '</span><span>评论 ' + fmtNum(p.comments) + '</span><span>赞 ' + fmtNum(p.likes) + '</span><a class="go" href="' + esc(p.url) + '" target="_blank">直达 ↗</a></div>';
            h += '</div>';
            return h;
        }).join('\n');

        var nav = function (cur, total) {
            if (total <= 1) return '';
            var x = '<div class="volnav"><a href="' + volName(Math.max(1, cur - 1)) + '">‹ 上一卷</a>';
            for (var i = 1; i <= total; i++) x += (i === cur) ? '<b>' + i + '</b>' : '<a href="' + volName(i) + '">' + i + '</a>';
            x += '<a href="' + volName(Math.min(total, cur + 1)) + '">下一卷 ›</a><span>第 ' + cur + '/' + total + ' 卷</span></div>';
            return x;
        };
        var av = (AV_URI || lu(S.avatar));
        var title = esc((S.name || UID) + ' 的动态导出') + (cfg.totalVol > 1 ? '（第 ' + cfg.curVol + '/' + cfg.totalVol + ' 卷）' : '');
        return '<!DOCTYPE html>\n<html lang="zh-CN"' + themeClass() + '>\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>' + title + '</title>\n<style>\n' + exportCss() + '\n</style>\n</head>\n<body>\n<div class="wrap">\n' +
            '<header><div class="pf"><img class="pav" src="' + esc(av) + '" alt=""/><div><h1>' + esc(S.name || UID) + ' 的动态</h1><p>共 ' + chunk.length + ' 条 · 本次共导出 ' + S.posts.length + ' 条 · 导出于 ' + esc(fmtNow()) + '</p></div></div></header>\n' +
            nav(cfg.curVol, cfg.totalVol) + '\n' + cards + '\n' + nav(cfg.curVol, cfg.totalVol) + '\n' +
            '</div>\n</body>\n</html>';
    }
    function buildArticleHtml(p, map) {
        var a = p.article || {};
        var content = String(a.contentHtml || '').replace(/src="\/\//g, 'src="https://');
        if (map) {
            content = content.replace(/<img([^>]*?)src="([^"]+)"/gi, function (m, pre, src) {
                var loc = map[src];
                return '<img' + pre + 'src="' + (loc || src) + '"';
            });
        }
        return '<!DOCTYPE html>\n<html lang="zh-CN"' + themeClass() + '>\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>' + esc(a.title || '专栏') + '</title>\n<style>\n' + exportCss() + '\n.artwrap{max-width:760px;margin:0 auto;background:var(--panel);min-height:100vh;padding:28px 26px;box-sizing:border-box;}\n.artwrap h1{font-size:24px;margin:0 0 10px;}\n.artwrap .ameta{color:var(--muted);font-size:13px;margin-bottom:18px;}\n.artwrap .ameta a{color:var(--blue);text-decoration:none;}\n.content{font-size:16px;line-height:1.9;color:var(--text);word-break:break-word;}\n.content img{max-width:100%;border-radius:6px;}\n</style>\n</head>\n<body>\n<div class="artwrap">\n<h1>' + esc(a.title || '') + '</h1>\n<div class="ameta">' + esc(a.author || p.author || '') + ' · ' + esc(p.time || '') + (a.words ? (' · 字数 ' + a.words) : '') + ' · <a href="' + esc(a.url || '') + '" target="_blank" rel="noopener">原专栏 ↗</a></div>\n<div class="content">' + content + '</div>\n</div>\n</body>\n</html>';
    }
    function exportCss() {
        return [
            ':root{--bg:#f4f5f7;--panel:#fff;--line:#eef0f2;--text:#1f2329;--muted:#9aa0a6;--soft:#f7f8fa;--pink:#fb7299;--blue:#00aeec;}',
            'html.dark{--bg:#0d0e12;--panel:#16171c;--line:#22242b;--text:#e5e6eb;--muted:#7a7f88;--soft:#1f2126;--pink:#ff9cb9;--blue:#4ac1f2;}',
            '@media (prefers-color-scheme: dark){:root:not(.light){--bg:#0d0e12;--panel:#16171c;--line:#22242b;--text:#e5e6eb;--muted:#7a7f88;--soft:#1f2126;--pink:#ff9cb9;--blue:#4ac1f2;}}',
            'body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
            '.wrap{max-width:720px;margin:0 auto;background:var(--panel);min-height:100vh;}',
            'header{padding:22px 24px 12px;}', '.pf{display:flex;gap:14px;align-items:center;}',
            '.pav{width:72px;height:72px;border-radius:50%;object-fit:cover;background:var(--soft);}',
            'h1{margin:0;font-size:22px;}', 'header p{margin:6px 0 0;color:var(--muted);font-size:13px;}',
            '.volnav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px;}',
            '.volnav a{color:var(--blue);text-decoration:none;}', '.volnav b{color:var(--pink);}', '.volnav span{margin-left:auto;color:var(--muted);}',
            '.pcard{padding:16px 24px;border-bottom:1px solid var(--line);}',
            '.head{display:flex;gap:10px;align-items:center;}', '.face{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--soft);}',
            '.who{flex:1;min-width:0;}', '.nm{display:block;font-size:15px;font-weight:600;}', '.meta{color:var(--muted);font-size:12px;}',
            '.dress{display:inline-flex;gap:4px;align-items:center;font-size:11px;color:var(--pink);background:rgba(251,114,153,.1);border-radius:4px;padding:1px 6px;margin-top:3px;}', '.dress img{width:16px;height:16px;border-radius:3px;}',
            '.tag{font-size:11px;color:var(--pink);border:1px solid var(--pink);border-radius:4px;padding:1px 6px;}',
            '.txt{margin-top:8px;font-size:15px;line-height:1.7;}', '.txt img.emot{width:22px;height:22px;vertical-align:-5px;}',
            '.imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:8px;border-radius:6px;overflow:hidden;}', '.imgs.one{grid-template-columns:1fr;}',
            '.imgs img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--soft);}', '.imgs.one img{aspect-ratio:auto;max-height:460px;object-fit:contain;}',
            '.video{display:flex;gap:10px;align-items:center;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:8px;text-decoration:none;color:var(--text);}',
            '.video img{width:120px;height:70px;object-fit:cover;border-radius:4px;background:var(--soft);}',
            '.art{margin-top:8px;padding:10px;background:var(--soft);border-radius:8px;}', '.art a{color:var(--blue);text-decoration:none;}', '.art .artlink{color:var(--muted);font-size:12px;margin-left:6px;}',
            '.add{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;}', '.add small{width:100%;color:var(--muted);}', '.add .addopts{width:100%;margin:4px 0 0;padding-left:18px;}', '.add .addopts li{font-size:13px;margin:2px 0;}', '.add .addopts b{color:var(--pink);}', '.add .addprize{width:100%;font-size:12px;color:var(--muted);}', '.add b{color:var(--pink);font-size:11px;}', '.add a{color:var(--blue);text-decoration:none;}',
            '.fwd{margin-top:8px;padding:10px 12px;background:var(--soft);border-radius:8px;}', '.fh{color:var(--pink);font-size:13px;margin-bottom:4px;}', '.ft{font-size:13px;color:var(--muted);line-height:1.6;}', '.fv{font-size:12px;margin-top:4px;}', '.fv a{color:var(--blue);text-decoration:none;}',
            '.stats{display:flex;gap:14px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}', '.stats .go{margin-left:auto;color:var(--pink);text-decoration:none;}'
        ].join('\n');
    }
    function buildPages(offline, map) {
        var split = !!(els.chkSplit && els.chkSplit.checked);
        var per = parseInt((els.splitN && els.splitN.value) || '300', 10); if (!(per >= 10)) per = 300;
        var step = split ? per : S.posts.length;
        var chunks = [];
        for (var i = 0; i < S.posts.length; i += step) chunks.push(S.posts.slice(i, i + step));
        if (!chunks.length) chunks.push([]);
        return chunks.map(function (c, v) { return { name: volName(v + 1), html: buildPageHtml(c, { offline: !!offline, map: map || null, curVol: v + 1, totalVol: chunks.length }) }; });
    }

    // ============ 下载 ============    // ============ 下载 ============
    function fireDownload(a) {
        // B站等 SPA 会委托 document 监听 <a> 点击并接管路由；
        // 派发不冒泡的 click，避免把下载锚点当成页面跳转。
        if (a.dispatchEvent) {
            try { a.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true, view: window })); return; } catch (e) {}
        }
        a.click();
    }
    // 注意：下载锚点绝对不要插入 DOM —— B站 SPA 会在 capture 阶段拦截 document 上的点击，
    // 把 blob: 下载地址当作站内链接接管，导致跳到畸形 URL。detached 元素不会进入事件传播链。
    function download(name, content, mime) {
        try { var blob = new Blob([content], { type: mime + ';charset=utf-8' }); downloadBlob(name, blob); }
        catch (e) { alert('下载失败：' + e.message); }
    }
    function downloadBlob(name, blob) {
        try {
            var u = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = u; a.download = name; a.rel = 'noopener';
            a.click();
            setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
        } catch (e) { alert('下载失败：' + e.message); }
    }
    // 极简 ZIP (store)
    var CRC_T = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
    function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function dosD(d) { d = d || new Date(); return { time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, date: ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF) }; }
    function makeZip(entries) {
        var locals = [], centrals = [], offset = 0, dt = dosD(new Date());
        entries.forEach(function (en) {
            var nameU8 = new TextEncoder().encode(en.name), data = en.data, crc = crc32(data);
            var local = new Uint8Array(30 + nameU8.length + data.length), dv = new DataView(local.buffer);
            dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
            dv.setUint16(10, dt.time, true); dv.setUint16(12, dt.date, true); dv.setUint32(14, crc, true);
            dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, nameU8.length, true); dv.setUint16(28, 0, true);
            local.set(nameU8, 30); local.set(data, 30 + nameU8.length);
            locals.push(local);
            var cen = new Uint8Array(46 + nameU8.length), cdv = new DataView(cen.buffer);
            cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true); cdv.setUint16(8, 0x0800, true); cdv.setUint16(10, 0, true);
            cdv.setUint16(12, dt.time, true); cdv.setUint16(14, dt.date, true); cdv.setUint32(16, crc, true); cdv.setUint32(20, data.length, true); cdv.setUint32(24, data.length, true);
            cdv.setUint16(28, nameU8.length, true); cdv.setUint16(30, 0, true); cdv.setUint16(32, 0, true); cdv.setUint16(34, 0, true); cdv.setUint16(36, 0, true);
            cdv.setUint32(38, 0, true); cdv.setUint32(42, offset, true);
            cen.set(nameU8, 46); centrals.push(cen);
            offset += local.length;
        });
        var cdSize = centrals.reduce(function (a, c) { return a + c.length; }, 0);
        var end = new Uint8Array(22), edv = new DataView(end.buffer);
        edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, entries.length, true); edv.setUint16(10, entries.length, true);
        edv.setUint32(12, cdSize, true); edv.setUint32(16, offset, true);
        var all = locals.concat(centrals); all.push(end);
        var total = all.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(total), pos = 0;
        all.forEach(function (p) { out.set(p, pos); pos += p.length; });
        return new Blob([out], { type: 'application/zip' });
    }

    function rangeName() {
        var ds = S.posts.filter(function (p) { return p.date; }).map(function (p) { return p.date; }).sort();
        var a = ds[0] || '', b = ds[ds.length - 1] || '';
        var f = function (x) { return x ? x.replace(/-/g, '') : 'all'; };
        return UID + '_' + f(a) + '-' + f(b) + '_dynamic-export';
    }
    function fetchJson(url) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({ method: 'GET', url: url, responseType: 'text', onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } }, onerror: function () { reject(new Error('网络错误')); } });
            } else {
                fetch(url, { credentials: 'include' }).then(function (r) { return r.json(); }).then(resolve).catch(reject);
            }
        });
    }
    // 解析一个视频的可下载文件（DASH: 视频+音频分离；durl: 合并文件）
    async function resolveVideoFiles(bvid, qn, isShort) {
        var out = [];
        if (!bvid) return out;
        var folder = isShort ? 'short_videos/' : 'video_files/';
        try {
            var v = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
            var cid = v && v.data && v.data.cid; if (!cid) return out;
            var want = (qn === 'auto' || !qn) ? 120 : Number(qn);
            var pj = await fetchJson('https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + cid + '&fnval=16&fourk=1&qn=' + want + '&otype=json');
            var d = pj && pj.data; if (!d) return out;
            if (d.durl && d.durl.length) {
                d.durl.forEach(function (x, i) { out.push({ url: x.url, rel: folder + bvid + (d.durl.length > 1 ? ('_' + (i + 1)) : '') + (/\.flv/i.test(x.url) ? '.flv' : '.mp4'), qn: want }); });
                return out;
            }
            if (d.dash) {
                var vids = (d.dash.video || []).filter(function (x) { return x.baseUrl || x.base_url; });
                var avc = vids.filter(function (x) { return /^avc1/i.test(x.codecs || ''); });
                var pool = avc.length ? avc : vids;
                var chosen = null;
                if (pool.length) {
                    if (qn === 'auto' || !qn) chosen = pool.reduce(function (a, b) { return (b.height > (a ? a.height : 0)) ? b : a; }, null);
                    else {
                        var eligible = pool.filter(function (x) { return Number(x.id) <= want; });
                        chosen = eligible.length ? eligible.reduce(function (a, b) { return Number(b.id) > Number(a.id) ? b : a; }) : pool.reduce(function (a, b) { return Number(b.id) < Number(a.id) ? b : a; });
                    }
                }
                var as = (d.dash.audio || []).filter(function (x) { return x.baseUrl || x.base_url; });
                var aud = as.length ? as.reduce(function (a, b) { return (Number(b.bandwidth) > Number(a.bandwidth)) ? b : a; }) : null;
                if (chosen) out.push({ url: chosen.baseUrl || chosen.base_url, rel: folder + bvid + '_video.m4s', qn: chosen.id });
                var qid = chosen ? (chosen.id || want) : want;
                if (aud) out.push({ url: aud.baseUrl || aud.base_url, rel: folder + bvid + '_audio.m4s', qn: qid });
            }
        } catch (e) { console.warn('视频地址解析失败', bvid, e); }
        return out;
    }

    async function resolveMusicFile(sid) {
        if (!sid) return null;
        try {
            var j = await fetchJson('https://www.bilibili.com/audio/music-service-c/web/url?sid=' + sid);
            var cdns = j && j.data && j.data.cdns; if (cdns && cdns.length) return { url: cdns[0], rel: 'audio_files/' + sid + '.mp3' };
        } catch (e) { console.warn('音频地址解析失败', sid, e); }
        return null;
    }
    function fetchBytes(url) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET', url: url, responseType: 'arraybuffer',
                    headers: { 'Referer': (/bilivideo|bilibili/.test(url) ? 'https://www.bilibili.com/' : 'https://space.bilibili.com/') },
                    onload: function (r) { if (r.status >= 200 && r.status < 300) resolve(new Uint8Array(r.response)); else reject(new Error('HTTP ' + r.status)); },
                    onerror: function () { reject(new Error('网络错误')); },
                    ontimeout: function () { reject(new Error('超时')); }
                });
            } else {
                fetch(url, { credentials: 'include' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                    .then(function (b) { resolve(new Uint8Array(b)); }).catch(reject);
            }
        });
    }
    async function doZip() {
        var root = rangeName();
        var zHtml = els.chkZHtml && els.chkZHtml.checked, zJson = els.chkZJson && els.chkZJson.checked, zCsv = els.chkZCsv && els.chkZCsv.checked;
        if (!zHtml && !zJson && !zCsv) { setStatus('请至少勾选一种打包格式。', true); return; }
        await loadAvatarData();
        var seen = {}, list = [], artMap = {};
        function add(u, rel, alias) { if (!u || seen[u]) return; seen[u] = 1; list.push({ url: u, rel: rel, alias: alias || null }); }
        add(S.avatar, 'media/avatar' + extOf(S.avatar));
        S.posts.forEach(function (p) {
            if (p.video && p.video.pic) add(p.video.pic, 'media/covers/' + safeOf(p.video.pic));
            if (p.article && p.article.pic) add(p.article.pic, 'media/covers/' + safeOf(p.article.pic));
            if (p.medialist && p.medialist.pic) add(p.medialist.pic, 'media/covers/' + safeOf(p.medialist.pic));
            if (p.forward && p.forward.video && p.forward.video.pic) add(p.forward.video.pic, 'media/covers/' + safeOf(p.forward.video.pic));
            (p.pics || []).forEach(function (u, j) { add(u, 'photos/' + fileNameOf(u, j, p.dynId)); });
            if (els.chkEmoticon && els.chkEmoticon.checked) {
                [p.rich, p.forward && p.forward.rich].forEach(function (rich) {
                    (rich || []).forEach(function (n) {
                        if (n && n.type === 'RICH_TEXT_NODE_TYPE_EMOJI') {
                            var e = n.emoji || {}; var u = e.gif_url || e.webp_url || e.icon_url || n.icon_url || '';
                            if (u) add(u, 'emoticons/' + safeOf(u));
                        }
                    });
                });
            }
        });
        S.posts.forEach(function (p) {
            if (p.article && p.article.contentHtml) {
                var rel = articleRel(p);
                artMap['article:' + p.article.id] = rel;
                (p.article.images || []).forEach(function (u) { add(u, 'articles/images/' + safeOf(u)); });
            }
        });
        if (els.chkVideoMedia && els.chkVideoMedia.checked) {
            var seenV = {};
            for (var vi = 0; vi < S.posts.length; vi++) {
                var vp = S.posts[vi];
                if (vp.video && vp.video.bvid && !seenV[vp.video.bvid]) {
                    seenV[vp.video.bvid] = 1;
                    var qnVal = (els.vq && els.vq.value) || 'auto';
                    setStatus('解析视频地址 ' + vp.video.bvid + '（清晰度 ' + qnVal + '）…');
                    var vf = await resolveVideoFiles(vp.video.bvid, qnVal, vp.typeLabel === '小视频');
                    vf.forEach(function (x, i) { add(x.url, x.rel, i === 0 ? ('video:' + vp.video.bvid) : null); });
                    await sleep(200);
                }
                if (vp.music && vp.music.id && !seenV['m' + vp.music.id]) {
                    seenV['m' + vp.music.id] = 1;
                    var mf = await resolveMusicFile(vp.music.id);
                    if (mf) add(mf.url, mf.rel);
                    await sleep(200);
                }
            }
        }
        var entries = [], okMap = {}, failed = [];
        for (var i = 0; i < list.length; i++) {
            setStatus('正在下载媒体 ' + (i + 1) + '/' + list.length + '：' + list[i].rel);
            try { var b = await fetchBytes(list[i].url); entries.push({ name: root + '/' + list[i].rel, data: b }); okMap[list[i].url] = list[i].rel; if (list[i].alias) okMap[list[i].alias] = list[i].rel; }
            catch (e) { failed.push(list[i].url); }
            await sleep(120);
        }
        var mapAll = {};
        Object.keys(okMap).forEach(function (k) { mapAll[k] = okMap[k]; });
        Object.keys(artMap).forEach(function (k) { mapAll[k] = artMap[k]; });
        if (zHtml) buildPages(true, mapAll).forEach(function (pg) { entries.push({ name: root + '/' + pg.name, data: new TextEncoder().encode(pg.html) }); });
        S.posts.forEach(function (p) {
            if (p.article && p.article.contentHtml) {
                entries.push({ name: root + '/' + artMap['article:' + p.article.id], data: new TextEncoder().encode(buildArticleHtml(p, okMap)) });
            }
        });
        if (zJson) entries.push({ name: root + '/messages.json', data: new TextEncoder().encode(buildJSON()) });
        if (zCsv) entries.push({ name: root + '/messages.csv', data: new TextEncoder().encode(buildCSV()) });
        if (failed.length) entries.push({ name: root + '/media_links.txt', data: new TextEncoder().encode('以下 ' + failed.length + ' 个媒体未能自动下载：\n' + failed.join('\n') + '\n') });
        var hasVideo = entries.some(function (en) { return (en.name.indexOf('/video_files/') > -1 || en.name.indexOf('/short_videos/') > -1) && /_video\.m4s$/.test(en.name); });
        if (hasVideo) {
            var CRLF = String.fromCharCode(13, 10);
            var CRLF = String.fromCharCode(13, 10);
            var BS = String.fromCharCode(92);
            var bat = [
                '@echo off',
                'setlocal enabledelayedexpansion',
                'chcp 65001 >nul',
                'cd /d "%~dp0"',
                'echo ==== B站视频合并工具 ====',
                'where ffmpeg >nul 2>nul',
                'if errorlevel 1 (',
                '  echo [错误] 未找到 ffmpeg。请先安装: winget install Gyan.FFmpeg',
                '  pause',
                '  exit /b 1',
                ')',
                'set count=0',
                'for %%d in (video_files short_videos) do (',
                '  if exist "%%d" (',
                '    for %%f in ("%%d' + BS + '*_video.m4s") do (',
                '      set "base=%%~nf"',
                '      set "name=!base:_video=!"',
                '      set "bvid=!name:~0,12!"',
                '      set "audi=%%d' + BS + '!name!_audio.m4s"',
                '      if not exist "!audi!" set "audi=%%d' + BS + '!bvid!_audio.m4s"',
                '      if exist "!audi!" (',
                '        echo [合并] %%d' + BS + '!name!',
                '        ffmpeg -y -hide_banner -loglevel warning -i "%%d' + BS + '!name!_video.m4s" -i "!audi!" -c copy "%%d' + BS + '!name!.mp4"',
                '      ) else (',
                '        echo [仅视频] %%d' + BS + '!name!',
                '        ffmpeg -y -hide_banner -loglevel warning -i "%%d' + BS + '!name!_video.m4s" -c copy "%%d' + BS + '!name!_video_only.mp4"',
                '      )',
                '      set /a count+=1',
                '    )',
                '  )',
                ')',
                'echo.',
                'echo 共处理 !count! 个视频，输出在各目录。',
                'pause'
            ].join(CRLF);
            var ps1 = [
                "$ErrorActionPreference = 'Stop'",
                'Set-Location -LiteralPath $PSScriptRoot',
                "Write-Host '=== B站视频合并工具 ===' -ForegroundColor Cyan",
                'if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {',
                "  Write-Host '[错误] 未找到 ffmpeg，请先安装：winget install Gyan.FFmpeg' -ForegroundColor Red",
                "  Read-Host '按回车退出'",
                '  exit 1',
                '}',
                "@('video_files','short_videos') | ForEach-Object {",
                '  $d = Join-Path $PSScriptRoot $_',
                '  if (-not (Test-Path -LiteralPath $d)) { return }',
                "  $vids = Get-ChildItem -LiteralPath $d -Filter '*_video.m4s' -ErrorAction SilentlyContinue",
                '  foreach ($v in $vids) {',
                "    $name = $v.BaseName -replace '_video$',''",
                "    $bvid = $name.Substring(0, [Math]::Min(12, $name.Length))",
                "    $audio = Join-Path $d ($name + '_audio.m4s')",
                "    if (-not (Test-Path -LiteralPath $audio)) { $audio = Join-Path $d ($bvid + '_audio.m4s') }",
                '    if (Test-Path -LiteralPath $audio) {',
                "      Write-Host ('[合并] ' + $v.Directory.Name + ' / ' + $name)",
                "      ffmpeg -y -hide_banner -loglevel warning -i $v.FullName -i $audio -c copy (Join-Path $d ($name + '.mp4'))",
                '    } else {',
                "      Write-Host ('[仅视频] ' + $name + ' 无音频') -ForegroundColor Yellow",
                "      ffmpeg -y -hide_banner -loglevel warning -i $v.FullName -c copy (Join-Path $d ($name + '_video_only.mp4'))",
                '    }',
                '  }',
                '}',
                "Write-Host '全部完成，输出在各视频目录。' -ForegroundColor Green",
                "Read-Host '按回车退出'"
            ].join(CRLF);
            var note = ['B站视频为 DASH 分离流（视频/音频各一个 .m4s），需要合并才能得到带声音的 mp4。', '', '两个目录都会处理：video_files（视频）/ short_videos（小视频）。', '', '用法：', '1. 先把 ZIP 完整解压到一个文件夹', '2. 安装 ffmpeg：winget install Gyan.FFmpeg（安装后需重开窗口）', '3. 双击「合并视频.bat」；若 bat 闪退，右键用 PowerShell 运行「合并视频.ps1」', '4. 合并结果：各目录下的 <BV号>.mp4', '', '若提示没有 *_video.m4s：说明导出时未勾选“下载视频/音频文件”，或媒体下载失败（见 media_links.txt）。'].join(CRLF);
            entries.push({ name: root + '/合并视频.bat', data: new TextEncoder().encode(bat) });
            entries.push({ name: root + '/合并视频.ps1', data: new TextEncoder().encode(ps1) });
            entries.push({ name: root + '/合并视频-说明.txt', data: new TextEncoder().encode(note) });
        }
        downloadBlob(root + '.zip', makeZip(entries));
        setStatus('ZIP 已生成：' + S.posts.length + ' 条 · 媒体 ' + (list.length - failed.length) + '/' + list.length);
    }

    // ============ UI ============    // ============ UI ============    // ============ UI ============
    GM_addStyle(`
        #bdx-launcher { position: fixed; left: 18px; bottom: 90px; z-index: 2147483000; padding: 10px 14px; border: none; border-radius: 999px; cursor: pointer; background: #00aeec; color: #fff; font-size: 14px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
        #bdx-overlay { position: fixed; inset: 0; z-index: 2147483100; display: none; background: rgba(20,20,20,.5); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        #bdx-overlay.bdx-open { display: flex; align-items: center; justify-content: center; }
        #bdx-panel { display: flex; flex-direction: column; width: min(680px, 94vw); max-height: 92vh; background: #fff; border-radius: 14px; box-shadow: 0 12px 50px rgba(0,0,0,.35); overflow: hidden; }
        #bdx-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eef0f2; }
        #bdx-bar label { font-size: 13px; color: #555; }
        #bdx-bar input[type=date] { border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
        #bdx-bar input[type=number], #bdx-bar input[type=text] { width: 72px; border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
        .bdx-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 14px; font-size: 13px; }
        .bdx-row .chk { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; color: #333; }
        .bdx-btns { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 14px; }
        .bdx-btns button { border: 1px solid #d9d9d9; background: #fff; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
        .bdx-btns button:hover:not(:disabled) { border-color: #00aeec; color: #00aeec; }
        .bdx-btns button:disabled { opacity: .4; cursor: not-allowed; }
        #bdx-start { background: #00aeec; border-color: #00aeec; color: #fff; }
        #bdx-start:hover:not(:disabled) { background: #009ad0; color: #fff; }
        #bdx-progress { padding: 4px 14px; font-size: 13px; color: #00aeec; }
        #bdx-status { padding: 8px 14px; font-size: 12px; color: #888; border-top: 1px solid #f0f0f0; background: #fafafa; }
        #bdx-status.bdx-err { color: #d33; }
        .bdx-note { padding: 2px 14px 6px; font-size: 11px; color: #999; line-height: 1.5; }
        #bdx-bar select, .bdx-row select { border: 1px solid #d9d9d9; border-radius: 6px; padding: 3px 6px; font-size: 12px; }
        #bdx-overlay.bdx-dark .bdx-note { color: #8a8a90; }
        #bdx-overlay.bdx-dark #bdx-bar select, #bdx-overlay.bdx-dark .bdx-row select { background: #26262b; border-color: #3a3a40; color: #d6d6da; }
        #bdx-dl { padding: 8px 14px 14px; border-top: 1px solid #eee; }
        #bdx-close { margin-left: auto; border: none !important; background: transparent !important; font-size: 22px; color: #888; }
        #bdx-overlay.bdx-dark #bdx-panel { background: #1e1e22; color: #e8e8ea; }
        #bdx-overlay.bdx-dark #bdx-bar, #bdx-overlay.bdx-dark #bdx-dl { border-color: #2a2a2f; }
        #bdx-overlay.bdx-dark .bdx-row .chk, #bdx-overlay.bdx-dark #bdx-bar label { color: #d6d6da; }
        #bdx-overlay.bdx-dark #bdx-bar input { background: #26262b; border-color: #3a3a40; color: #e8e8ea; }
        #bdx-overlay.bdx-dark .bdx-btns button { background: #26262b; border-color: #3a3a40; color: #d6d6da; }
        #bdx-overlay.bdx-dark #bdx-status { background: #17171a; color: #aaa; border-color: #2a2a2f; }
        #bdx-overlay.bdx-dark #bdx-close { color: #7a7a80; }
    `);

    function buildUI() {
        var launcher = document.createElement('button');
        launcher.id = 'bdx-launcher'; launcher.textContent = '导出动态';
        launcher.addEventListener('click', function () { els.overlay.classList.add('bdx-open'); });
        document.body.appendChild(launcher);

        var ov = document.createElement('div');
        ov.id = 'bdx-overlay';
        ov.innerHTML =
            '<div id="bdx-panel">' +
            '  <div id="bdx-bar">' +
            '    <label>日期</label><input id="bdx-from" type="date" title="开始日期（留空=最早）"/> ～ <input id="bdx-to" type="date" title="结束日期（留空=最新）"/>' +
            '    <label>间隔ms</label><input id="bdx-delay" type="number" min="150" step="50" value="450"/>' +
            '    <button id="bdx-close" title="关闭">×</button>' +
            '  </div>' +
            '  <div class="bdx-row">内容类型：' +
            '    <label class="chk" title="带图片的动态 / 相册（含 opus 图片动态）"><input type="checkbox" id="bdx-k-pic" checked/>图文</label>' +
            '    <label class="chk" title="B站收藏夹 / 合集动态（MAJOR_TYPE_MEDIALIST）"><input type="checkbox" id="bdx-k-fav" checked/>收藏夹</label>' +
            '    <label class="chk" title="投稿视频（BV）"><input type="checkbox" id="bdx-k-video" checked/>视频</label>' +
            '    <label class="chk" title="竖屏短视频：仅按动态标签识别（标签含“小视频”）"><input type="checkbox" id="bdx-k-short" checked/>小视频</label>' +
            '    <label class="chk" title="转发的动态"><input type="checkbox" id="bdx-k-rt" checked/>转发</label>' +
            '    <label class="chk" title="没有媒体的纯文字动态"><input type="checkbox" id="bdx-k-word" checked/>纯文字</label>' +
            '    <label class="chk" title="长文章：抓取全文并保存为本地 articles/*.html（含正文图片）"><input type="checkbox" id="bdx-k-article" checked/>专栏</label>' +
            '    <label class="chk" title="动态里附带的卡片：直播分享、游戏/评分/榜单等"><input type="checkbox" id="bdx-k-other" checked/>其他卡片</label>' +
            '  </div>' +
            '  <div class="bdx-note">说明：收藏夹 = B站「合集/收藏夹」动态；小视频 = 仅按标签含“小视频”识别；专栏 = 抓全文并生成本地 HTML（含正文图片）；其他卡片 = 直播/游戏/评分/榜单等非独立动态</div>' +
            '  <div class="bdx-row">媒体：' +
            '    <label class="chk"><input type="checkbox" id="bdx-media-video"/>下载视频/音频文件</label>' +
            '    <label class="chk">清晰度 <select id="bdx-vq"><option value="auto">自动(最高)</option><option value="112">1080P+</option><option value="80">1080P</option><option value="64" selected>720P</option><option value="32">480P</option><option value="16">360P</option></select></label>' +
            '    <label class="chk"><input type="checkbox" id="bdx-media-emoticon" checked/>打包表情图片</label>' +
            '  </div>' +
            '  <div class="bdx-row">外观：' +
            '    <label class="chk"><input type="radio" name="bdx-theme" value="auto" checked/>跟随系统</label>' +
            '    <label class="chk"><input type="radio" name="bdx-theme" value="light"/>日间</label>' +
            '    <label class="chk"><input type="radio" name="bdx-theme" value="dark"/>夜间</label>' +
            '  </div>' +
            '  <div class="bdx-row">分卷：<label class="chk"><input type="checkbox" id="bdx-split" checked/>自动分卷</label>' +
            '    <label class="chk">每卷约 <input id="bdx-split-n" type="number" min="10" value="300"/> 条</label>' +
            '  </div>' +
            '  <div class="bdx-btns">' +
            '    <button id="bdx-start">开始导出</button><button id="bdx-pause">暂停</button><button id="bdx-resume">继续</button><button id="bdx-stop">停止</button>' +
            '  </div>' +
            '  <div id="bdx-progress"></div>' +
            '  <div id="bdx-status">就绪：选好日期/类型后点「开始导出」；数据存内存，可随时下载已抓部分。</div>' +
            '  <div id="bdx-dl">打包格式：' +
            '    <label class="chk"><input type="checkbox" id="bdx-z-html" checked/>HTML</label>' +
            '    <label class="chk"><input type="checkbox" id="bdx-z-json" checked/>JSON</label>' +
            '    <label class="chk"><input type="checkbox" id="bdx-z-csv" checked/>CSV</label>' +
            '    <div class="bdx-btns" style="padding:6px 0 0">' +
            '      <button id="bdx-dl-json">下载 JSON</button><button id="bdx-dl-csv">下载 CSV</button><button id="bdx-dl-html">下载 HTML</button><button id="bdx-dl-zip">打包 ZIP（含图片）</button>' +
            '    </div></div>' +
            '</div>';
        document.body.appendChild(ov);
        els.overlay = ov;
        els.fromDate = ov.querySelector('#bdx-from'); els.toDate = ov.querySelector('#bdx-to'); els.delay = ov.querySelector('#bdx-delay');
        els.start = ov.querySelector('#bdx-start'); els.pause = ov.querySelector('#bdx-pause'); els.resume = ov.querySelector('#bdx-resume'); els.stop = ov.querySelector('#bdx-stop');
        els.progress = ov.querySelector('#bdx-progress'); els.status = ov.querySelector('#bdx-status');
        els.chkZHtml = ov.querySelector('#bdx-z-html'); els.chkZJson = ov.querySelector('#bdx-z-json'); els.chkZCsv = ov.querySelector('#bdx-z-csv');
        els.chkSplit = ov.querySelector('#bdx-split'); els.splitN = ov.querySelector('#bdx-split-n');
        els.chkVideoMedia = ov.querySelector('#bdx-media-video'); els.chkEmoticon = ov.querySelector('#bdx-media-emoticon'); els.vq = ov.querySelector('#bdx-vq');
        els.close = ov.querySelector('#bdx-close');
        els.start.addEventListener('click', start);
        els.pause.addEventListener('click', pause);
        els.resume.addEventListener('click', resume);
        els.stop.addEventListener('click', stopAll);
        els.close.addEventListener('click', function () { ov.classList.remove('bdx-open'); });
        ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('bdx-open'); });
        var stamp = function () { return '_' + UID + '_' + fmtNow(); };
        els.dlJson = ov.querySelector('#bdx-dl-json'); els.dlJson.addEventListener('click', function () { if (!S.posts.length) { setStatus('还没有数据。', true); return; } loadAvatarData().then(function () { download('messages' + stamp() + '.json', buildJSON(), 'application/json'); }); });
        els.dlCsv = ov.querySelector('#bdx-dl-csv'); els.dlCsv.addEventListener('click', function () { if (!S.posts.length) { setStatus('还没有数据。', true); return; } download('messages' + stamp() + '.csv', buildCSV(), 'text/csv'); });
        els.dlHtml = ov.querySelector('#bdx-dl-html'); els.dlHtml.addEventListener('click', function () { if (!S.posts.length) { setStatus('还没有数据。', true); return; } loadAvatarData().then(function () { var p = buildPages(false); download('messages' + stamp() + '.html', p[0].html, 'text/html'); }); });
        els.dlZip = ov.querySelector('#bdx-dl-zip'); els.dlZip.addEventListener('click', function () { if (!S.posts.length) { setStatus('还没有数据。', true); return; } els.dlZip.disabled = true; doZip().then(function () { els.dlZip.disabled = false; }).catch(function (e) { setStatus('打包失败：' + e.message, true); els.dlZip.disabled = false; }); });
        applyTheme();
    }
    function applyTheme() {
        var dark = false; try { var r = document.querySelector('input[name=bdx-theme]:checked'); var v = r ? r.value : 'auto'; dark = v === 'dark' || (v === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) {}
        els.overlay.classList.toggle('bdx-dark', dark);
        els.overlay.classList.toggle('bdx-light', false);
        var radios = document.querySelectorAll('input[name=bdx-theme]');
        radios.forEach(function (x) { x.addEventListener('change', applyTheme); });
    }
    function keepAlive() {
        setInterval(function () {
            if (!document.getElementById('bdx-launcher') && location.pathname.match(/^\/(\d+)(?:\/|$)/)) {
                var b = document.createElement('button'); b.id = 'bdx-launcher'; b.textContent = '导出动态';
                b.addEventListener('click', function () { els.overlay.classList.add('bdx-open'); });
                document.body.appendChild(b);
            }
        }, 3000);
    }
    function init() {
        console.log(TAG, '启动 uid=' + UID);
        buildUI();
        keepAlive();
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
    window.__bdx = { state: S, start: start, buildJSON: buildJSON, buildCSV: buildCSV, buildPages: buildPages, makeZip: makeZip, loadAvatar: loadAvatarData, resolveVideoFiles: resolveVideoFiles, resolveMusicFile: resolveMusicFile, fetchJson: fetchJson, buildArticleHtml: buildArticleHtml, articleRel: articleRel, doZip: doZip };
})();
