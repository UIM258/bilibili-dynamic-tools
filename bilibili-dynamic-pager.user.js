// ==UserScript==
// @name         B站动态分页浏览
// @name:zh-CN   B站动态分页浏览
// @namespace    https://github.com/UIM258/bilibili-dynamic-tools
// @version      1.0.0
// @description  B站用户空间动态分页浏览：本地分页/上一页下一页/按日期直达/直达最早；支持图文/视频/转发/专栏等全格式、表情(收藏集/装扮)、装扮徽章、附加卡片、图片灯箱、暗色模式
// @description:zh-CN  B站用户空间动态分页浏览：本地分页/上一页下一页/按日期直达/直达最早；支持图文/视频/转发/专栏等全格式、表情(收藏集/装扮)、装扮徽章、附加卡片、图片灯箱、暗色模式
// @author       UIM258
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @match        https://space.bilibili.com/*/dynamic
// @match        https://space.bilibili.com/*/dynamics
// @run-at       document-idle
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    var TAG = '[B站动态分页]';
    var m = location.pathname.match(/^\/(\d+)\/dynamic/);
    if (!m) { return; }
    var UID = m[1];

    var CFG = {
        delay: 350,        // 翻页抓取间隔 ms（防风控）
        minDelay: 120,
        maxDelay: 3000,
        retries: 3,
        requestTimeout: 15000,
        pageSize: 12       // B站接口每页条数（固定约12）
    };

    var S = {
        theme: 'auto',     // auto|light|dark
        posts: [],         // 归一化动态（按时间倒序）
        offset: '',        // 下一个游标（'' = 第一页）
        hasMore: true,
        loading: false,
        paused: false,
        stop: false,
        bufferFull: false, // 缓冲已加载满（不再自动加载）
        curPage: 1,
        perPage: 20,
        name: '',
        avatar: ''
    };
    var els = {};
    var timer = null;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtTs(sec) {
        if (!sec) return '';
        var d = new Date(Number(sec) * 1000);
        if (isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function dateOfTs(sec) {
        var s = fmtTs(sec);
        return s ? s.slice(0, 10) : '';
    }
    function fmtNum(v) { var n = Number(v) || 0; return n >= 100000000 ? (n / 100000000).toFixed(1) + '亿' : (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n)); }
    function stripHtml(h) {
        var tpl = document.createElement('template');
        tpl.innerHTML = (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n');
        return (tpl.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    // ============ API ============
    function apiUrl(offset) {
        return 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=' + UID +
            '&offset=' + encodeURIComponent(offset || '') +
            '&timezone_offset=-480&features=itemOpusStyle,listOnlyfans,deadSpace,newFace,baseColorImage';
    }
    function fetchPageRaw(offset) {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, CFG.requestTimeout);
        return fetch(apiUrl(offset), { credentials: 'include', signal: ctrl.signal })
            .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (j) {
                if (!j || j.code !== 0) throw new Error('code=' + (j && j.code) + ' ' + (j && j.message));
                var d = j.data || {};
                return { items: d.items || [], offset: d.offset || '', hasMore: !!d.has_more };
            })
            .catch(function (e) { clearTimeout(t); if (e && e.name === 'AbortError') throw new Error('请求超时'); throw e; });
    }

    // 富文本：普通文字 + 表情图片（收藏集/装扮表情包也走这里）
    function richHtml(rich, fallback) {
        if (!rich || !rich.length) return textHtml(fallback);
        var h = '';
        rich.forEach(function (x) {
            if (!x) return;
            if (x.type === 'RICH_TEXT_NODE_TYPE_EMOJI') {
                var e = x.emoji || {};
                var u = e.webp_url || e.gif_url || e.icon_url || x.icon_url || '';
                if (u) h += '<img class="bili-emot" src="' + esc(u) + '" alt="' + esc(x.text || '') + '"/>';
                else h += esc(x.text || x.orig_text || '');
            } else {
                h += esc(x.text || x.orig_text || '');
            }
        });
        return h || textHtml(fallback);
    }
    function pickText(md, major) {
        if (md && md.desc && md.desc.text) return { text: md.desc.text, rich: md.desc.rich_text_nodes || null };
        if (major && major.opus && major.opus.summary && major.opus.summary.text) return { text: major.opus.summary.text, rich: major.opus.summary.rich_text_nodes || null };
        if (major && major.opus && major.opus.summary && major.opus.summary.text === undefined && major.opus.pics) return { text: '', rich: null };
        return null;
    }

    // 归一化一条动态
    function norm(it) {
        var md = (it.modules && it.modules.module_dynamic) || {};
        var au = (it.modules && it.modules.module_author) || {};
        var stat = (it.modules && it.modules.module_stat) || {};
        var major = md.major || {};
        var o = {
            dynId: it.id_str || it.id || '',
            type: it.type || '',
            ts: Number(au.pub_ts || 0),
            time: fmtTs(au.pub_ts),
            date: dateOfTs(au.pub_ts),
            name: au.name || '',
            face: au.face || '',
            likes: Number(stat.like || 0),
            comments: Number(stat.comment || 0),
            reposts: Number(stat.forward || 0)
        };
        var src = pickText(md, major);
        if (src) { o.text = src.text || ''; o.rich = src.rich; }

        if (major.type === 'MAJOR_TYPE_OPUS') {
            var pics = (major.opus && major.opus.pics) || [];
            o.pics = pics.map(function (p) { return { url: p.url || '', src: p.url || '', w: p.width, h: p.height }; });
            if (major.opus && major.opus.summary && !o.text) o.text = major.opus.summary.text || '';
        } else if (major.type === 'MAJOR_TYPE_ARCHIVE') {
            var a = major.archive || {};
            o.video = { title: a.title || '', bvid: a.bvid || '', pic: a.cover || a.pic || '', url: a.bvid ? ('https://www.bilibili.com/video/' + a.bvid) : '', duration: a.duration_text || '' };
            if (a.title && !o.text) o.text = a.title;
        } else if (major.type === 'MAJOR_TYPE_ARTICLE') {
            var art = major.article || {};
            o.article = { title: art.title || '', id: art.id || '', pic: art.cover || '', url: art.id ? ('https://www.bilibili.com/read/cv' + art.id) : '' };
            if (art.title && !o.text) o.text = art.title;
        } else if (major.type === 'MAJOR_TYPE_LIVE') {
            o.live = { title: (major.live && (major.live.title || major.live.desc)) || '', cover: (major.live && (major.live.cover || major.live.cover_url)) || '' };
            if (!o.text) o.text = o.live.title;
        } else if (major.type === 'MAJOR_TYPE_DRAW') {
            var dp = (major.draw && major.draw.items) || [];
            o.pics = dp.map(function (x) { return { url: x.src || '', src: x.src || '' }; });
        }
        // 附加卡片：直播预约 / 投票 / 抽奖 / 通用卡片等
        var add = md.additional;
        if (add) {
            var sub = add.vote || add.common || add.match || add.ugc || add.reserve || add.upower_lottery || add.goods || null;
            if (sub && typeof sub === 'object') {
                var d1 = sub.desc1 && sub.desc1.text ? sub.desc1.text : '';
                var d2 = sub.desc2 && sub.desc2.text ? sub.desc2.text : '';
                o.add = {
                    kind: add.type || '',
                    title: sub.title || sub.text || d1 || d2 || '',
                    desc: (d2 && d2 !== (sub.title || d1)) ? d2 : '',
                    url: sub.jump_url || sub.url || '',
                    badge: sub.badge_text || ''
                };
                if (!o.text) o.text = '';
            }
        }
        // 作者装扮
        var dc = au.decoration_card;
        if (dc && (dc.name || dc.card_url)) o.dress = { name: dc.name || '', pic: dc.card_url || '' };
        // 转发（原动态在模块内 md.orig 或顶层 it.orig）
        var orig = md.orig || it.orig;
        if (orig) {
            var ou = (orig.modules && orig.modules.module_author) || {};
            var omd = (orig.modules && orig.modules.module_dynamic) || {};
            var omajor = omd.major || {};
            var osrc = pickText(omd, omajor);
            o.forward = { name: ou.name || '', time: fmtTs(ou.pub_ts), type: orig.type || '' };
            if (osrc) { o.forward.text = osrc.text || ''; o.forward.rich = osrc.rich; }
            if (!o.forward.text) {
                if (omajor.type === 'MAJOR_TYPE_ARCHIVE' && omajor.archive) o.forward.text = omajor.archive.title;
                else if (omajor.type === 'MAJOR_TYPE_OPUS' && omajor.opus && omajor.opus.summary) o.forward.text = omajor.opus.summary.text || '';
            }
            // 转发内容里原博的媒体（视频/图片），尽量还原
            if (omajor.type === 'MAJOR_TYPE_ARCHIVE' && omajor.archive) {
                var oa = omajor.archive;
                o.forward.media = { type: 'video', title: oa.title || '', pic: oa.cover || oa.pic || '', url: oa.bvid ? ('https://www.bilibili.com/video/' + oa.bvid) : '' };
            } else if (omajor.type === 'MAJOR_TYPE_OPUS') {
                var ops = (omajor.opus && omajor.opus.pics) || [];
                if (ops.length) o.forward.media = { type: 'pics', count: ops.length, first: ops[0].url || '' };
            } else if (omajor.type === 'MAJOR_TYPE_ARTICLE') {
                var oart = omajor.article || {};
                if (oart.title) o.forward.media = { type: 'article', title: oart.title, url: oart.id ? ('https://www.bilibili.com/read/cv' + oart.id) : '' };
            }
        }
        return o;
    }

    // ============ 渲染卡片    // ============ 渲染卡片（近似B站动态） ============
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function textHtml(t) {
        return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
    }
    function card(p) {
        var h = '<div class="bcard" data-dyn="' + esc(p.dynId) + '">';
        h += '<div class="head">';
        h += '<img class="face" src="' + esc(p.face || S.avatar) + '" alt=""/>';
        h += '<div class="who"><span class="name">' + esc(p.name || S.name) + '</span>';
        h += '<span class="meta">' + esc(p.time || '') + '</span>';
        if (p.dress) h += '<span class="dress" title="' + esc(p.dress.name) + '">' + (p.dress.pic ? '<img src="' + esc(p.dress.pic) + '" alt=""/>' : '') + esc(p.dress.name) + '</span>';
        h += '</div>';
        if (p.type === 'DYNAMIC_TYPE_FORWARD') h += '<span class="tag fwd">转发</span>';
        else if (p.type === 'DYNAMIC_TYPE_DRAW' || p.type === 'DYNAMIC_TYPE_DYN') h += '<span class="tag">动态</span>';
        else if (p.type === 'DYNAMIC_TYPE_AV') h += '<span class="tag av">视频</span>';
        else if (p.type === 'DYNAMIC_TYPE_WORD') h += '<span class="tag">文字</span>';
        else if (p.type === 'DYNAMIC_TYPE_ARTICLE') h += '<span class="tag art">专栏</span>';
        h += '</div>';
        if (p.text) h += '<div class="txt">' + (richHtml(p.rich, p.text)) + '</div>';
        if (p.video) {
            h += '<div class="video">';
            if (p.video.pic) h += '<img class="vpic" src="' + esc(p.video.pic) + '" alt=""/>';
            h += '<div class="vtitle"><a href="' + esc(p.video.url) + '" target="_blank" rel="noopener">' + esc(p.video.title) + '</a>' + (p.video.duration ? '<em>' + esc(p.video.duration) + '</em>' : '') + '</div></div>';
        }
        if (p.article) h += '<div class="article"><a href="' + esc(p.article.url) + '" target="_blank" rel="noopener">' + esc(p.article.title) + '</a></div>';
        if (p.live) h += '<div class="video live">' + esc(p.live.title) + '</div>';
        if (p.pics && p.pics.length) {
            h += '<div class="imgs' + (p.pics.length === 1 ? ' one' : '') + '">';
            p.pics.forEach(function (x, j) {
                h += '<img class="bpic" data-j="' + j + '" loading="lazy" src="' + esc(x.src) + '" alt="" title="点击预览大图"/>';
            });
            h += '</div>';
        }
        if (p.add) {
            h += '<div class="addbox">';
            if (p.add.badge) h += '<span class="addb">' + esc(p.add.badge) + '</span>';
            if (p.add.title) h += '<div class="addt">' + esc(p.add.title) + '</div>';
            if (p.add.desc) h += '<div class="addd">' + esc(p.add.desc) + '</div>';
            if (p.add.url) h += '<a class="addgo" href="' + esc(p.add.url) + '" target="_blank" rel="noopener">查看 ↗</a>';
            h += '</div>';
        }
        if (p.forward) {
            h += '<div class="fwdbox"><div class="fwdhead">@' + esc(p.forward.name) + (p.forward.time ? ' · ' + esc(p.forward.time) : '') + '</div>';
            h += '<div class="fwdtxt">' + richHtml(p.forward.rich, p.forward.text) + '</div>';
            if (p.forward.media) {
                h += '<div class="fwd-media">';
                if (p.forward.media.type === 'video') {
                    if (p.forward.media.pic) h += '<img class="fm-pic" src="' + esc(p.forward.media.pic) + '" alt=""/>';
                    h += '<div class="fm-body"><span class="fm-tag">视频</span><a href="' + esc(p.forward.media.url) + '" target="_blank" rel="noopener">' + esc(p.forward.media.title) + '</a></div>';
                } else if (p.forward.media.type === 'pics') {
                    h += '<span class="fm-tag">图片 ×' + esc(p.forward.media.count) + '</span>' + (p.forward.media.first ? '<a href="' + esc(p.forward.media.first) + '" target="_blank" rel="noopener">查看原图 ↗</a>' : '');
                } else if (p.forward.media.type === 'article') {
                    h += '<span class="fm-tag">专栏</span><a href="' + esc(p.forward.media.url) + '" target="_blank" rel="noopener">' + esc(p.forward.media.title) + '</a>';
                }
                h += '</div>';
            }
            h += '</div>';
        }
        h += '<div class="stats"><span>转发 ' + fmtNum(p.reposts) + '</span><span>评论 ' + fmtNum(p.comments) + '</span><span>点赞 ' + fmtNum(p.likes) + '</span>';
        if (p.dynId) h += '<a class="direct" href="https://t.bilibili.com/' + esc(p.dynId) + '" target="_blank" rel="noopener" title="在B站打开这条动态">直达动态 ↗</a></div>';
        h += '</div>';
        return h;
    }

    // ============ 引擎 ============
    var dynSeen = {};
    function totalPages() { return Math.max(1, Math.ceil(S.posts.length / S.perPage)); }
    function setStatus(t, isErr) { if (els.status) { els.status.textContent = t; els.status.className = 'bdp-status' + (isErr ? ' bdp-err' : ''); } }
    function updateUI() {
        var tp = totalPages();
        if (els.pageNow) els.pageNow.textContent = '第 ' + S.curPage + '/' + tp + ' 页';
        els.prev.disabled = S.curPage <= 1 || S.loading;
        els.next.disabled = S.loading; // 末页可点 = 继续加载
        els.pageInput.value = String(S.curPage);
        els.stop.disabled = !S.loading;
        els.earliest.disabled = S.loading;
        els.goDate.disabled = S.loading;
        if (S.name) document.title = S.name + '的动态（分页浏览）';
    }

    function fetchOne() {
        return fetchPageRaw(S.offset).then(function (r) {
            if (!S.paused && !S.stop) {
                var added = 0;
                (r.items || []).forEach(function (it) {
                    var id = it.id_str || it.id;
                    if (id && dynSeen[id]) return;
                    if (id) dynSeen[id] = 1;
                    var p = norm(it);
                    if (!S.name && p.name) S.name = p.name;
                    if (!S.avatar && p.face) S.avatar = p.face;
                    S.posts.push(p);
                    added++;
                });
                S.offset = r.offset;
                S.hasMore = !!r.hasMore;
                return { added: added, empty: !(r.items || []).length };
            }
            return { stopped: true };
        });
    }

    // 顺序加载若干页（stop/pause 检查）；untilEnd 或 untilDate 或 untilPages
    function loadUntil(until) {
        if (S.loading) return Promise.resolve('busy');
        if (!S.hasMore && S.posts.length) { return Promise.resolve('end'); }
        S.loading = true; S.paused = false; S.stop = false;
        updateUI();
        var attempt = 0;
        var step = function () {
            if (S.stop || S.paused) {
                S.loading = false;
                setStatus(S.stop ? '已停止加载。' : '已暂停加载。');
                updateUI();
                return Promise.resolve('stopped');
            }
            setStatus('正在加载…（已 ' + S.posts.length + ' 条）');
            return fetchOne().then(function (res) {
                if (res.stopped) { S.loading = false; updateUI(); return 'stopped'; }
                attempt = 0;
                if (res.empty || !S.hasMore) {
                    S.loading = false;
                    setStatus('已加载到最早：共 ' + S.posts.length + ' 条。');
                    updateUI();
                    return 'end';
                }
                var check = until || function () { return false; };
                var done = check();
                if (done) {
                    S.loading = false;
                    updateUI();
                    return 'target';
                }
                return sleep(CFG.delay).then(step);
            }).catch(function (err) {
                attempt++;
                if (attempt <= CFG.retries) {
                    var w = Math.min(CFG.maxDelay, 1000 * Math.pow(2, attempt));
                    setStatus('加载失败（' + err.message + '），' + w + 'ms 后重试…', true);
                    return sleep(w).then(step);
                }
                S.loading = false; S.paused = true;
                setStatus('加载失败：' + err.message + '（已暂停，可继续重试）', true);
                updateUI();
                return 'error';
            });
        };
        return step();
    }

    function pageIndexOf(pos) { return Math.floor(pos / S.perPage) + 1; }
    function showPage(n, scrollTop) {
        if (S.loading) return;
        var tp = totalPages();
        if (n < 1) n = 1;
        if (n > tp) n = tp;
        S.curPage = n;
        var start = (n - 1) * S.perPage;
        var slice = S.posts.slice(start, start + S.perPage);
        els.list.innerHTML = slice.map(card).join('') || '<div class="msg">本页为空。</div>';
        updateUI();
        if (scrollTop !== false && els.list.scrollTop !== undefined) els.list.scrollTop = 0;
    }
    function goPrev() { if (S.curPage > 1 && !S.loading) showPage(S.curPage - 1); }
    function goNext() {
        if (S.loading) return;
        var tp = totalPages();
        if (S.curPage < tp) { showPage(S.curPage + 1); return; }
        if (S.hasMore) {
            setStatus('正在加载更多，稍候自动翻页…');
            loadUntil(function () { return S.posts.length >= (S.curPage + 1) * S.perPage + 1; }).then(function (r) {
                if (r === 'error' || r === 'stopped') return;
                showPage(S.curPage + 1);
            });
        }
    }
    // 跳到包含某日期的页（先按需加载到该日期为止）
    function goDate() {
        var d = els.dateInput.value;
        if (!d) { setStatus('请先选择日期。', true); return; }
        if (S.loading) return;
        setStatus('正在定位 ' + d + ' 附近的动态…');
        loadUntil(function () {
            var oldest = S.posts.length ? S.posts[S.posts.length - 1].date : '';
            return !!oldest && oldest <= d;
        }).then(function (r) {
            if (r === 'error' || r === 'stopped') return;
            var idx = -1;
            for (var i = 0; i < S.posts.length; i++) { if (S.posts[i].date <= d) { idx = i; break; } }
            if (idx === -1) {
                if (!S.hasMore) { setStatus('该日期早于 TA 最早的动态（' + (S.posts.length ? S.posts[S.posts.length - 1].date : '?') + '）。', true); }
                else { setStatus('未能定位。', true); }
                return;
            }
            showPage(pageIndexOf(idx));
            setStatus('已定位到 ' + (S.posts[idx].date || d) + '（第 ' + S.curPage + '/' + totalPages() + ' 页）。');
        });
    }
    function goEarliest() {
        if (S.loading) return;
        if (!S.hasMore && S.posts.length) { showPage(totalPages()); return; }
        setStatus('正在扫描到最早…（当前 ' + S.posts.length + ' 条）');
        loadUntil(function () { return !S.hasMore; }).then(function (r) {
            if (r === 'error' || r === 'stopped') return;
            showPage(totalPages());
            setStatus('已到最早：共 ' + S.posts.length + ' 条。');
        });
    }
    function stopLoading() { S.stop = true; }
    function openFirst() {
        // 打开时先取一页快速展示
        if (S.posts.length) { showPage(1); return; }
        setStatus('正在获取…');
        loadUntil(function () { return S.posts.length >= S.perPage || !S.hasMore; }).then(function () {
            showPage(1);
            if (!S.hasMore) setStatus('全部动态仅 ' + S.posts.length + ' 条。');
        });
    }

    // ============ 图片灯箱 ============
    var lb = null, lbPics = [], lbIdx = 0;
    function lbOpen() { return !!lb && lb.classList.contains('bdp-lb-open'); }
    function ensureLb() {
        if (lb) return;
        lb = document.createElement('div');
        lb.id = 'bdp-lb';
        lb.innerHTML = '<button id="bdp-lb-prev" title="上一张">‹</button>' +
            '<div id="bdp-lb-stage"><img id="bdp-lb-img" alt=""/><div id="bdp-lb-count"></div><a id="bdp-lb-orig" href="#" target="_blank" rel="noopener">原图 ↗</a></div>' +
            '<button id="bdp-lb-next" title="下一张">›</button>' +
            '<button id="bdp-lb-close" title="关闭 (Esc)">×</button>';
        document.getElementById('bdp-panel').appendChild(lb);
        lb.querySelector('#bdp-lb-prev').addEventListener('click', function (e) { e.stopPropagation(); lbPrev(); });
        lb.querySelector('#bdp-lb-next').addEventListener('click', function (e) { e.stopPropagation(); lbNext(); });
        lb.querySelector('#bdp-lb-close').addEventListener('click', function (e) { e.stopPropagation(); lbClose(); });
        lb.addEventListener('click', function (e) { if (e.target === lb || e.target.id === 'bdp-lb-stage') lbClose(); });
    }
    function openLightbox(pics, idx, dynId) {
        ensureLb();
        lbPics = pics || []; lbIdx = (typeof idx === 'number') ? idx : 0;
        if (lbIdx < 0) lbIdx = 0; if (lbIdx >= lbPics.length) lbIdx = Math.max(0, lbPics.length - 1);
        lb.classList.add('bdp-lb-open');
        lbRender(dynId);
    }
    function lbRender(dynId) {
        if (!lbPics.length) return;
        var img = document.getElementById('bdp-lb-img');
        var cnt = document.getElementById('bdp-lb-count');
        var orig = document.getElementById('bdp-lb-orig');
        var prev = document.getElementById('bdp-lb-prev');
        var next = document.getElementById('bdp-lb-next');
        img.src = lbPics[lbIdx].url || lbPics[lbIdx].src || '';
        cnt.textContent = (lbPics.length > 1) ? ((lbIdx + 1) + ' / ' + lbPics.length) : '';
        orig.href = lbPics[lbIdx].url || lbPics[lbIdx].src || '#';
        prev.style.visibility = lbIdx > 0 ? 'visible' : 'hidden';
        next.style.visibility = lbIdx < lbPics.length - 1 ? 'visible' : 'hidden';
    }
    function lbPrev() { if (lbIdx > 0) { lbIdx--; lbRender(); } }
    function lbNext() { if (lbIdx < lbPics.length - 1) { lbIdx++; lbRender(); } }
    function lbClose() { if (lb) { lb.classList.remove('bdp-lb-open'); var im = document.getElementById('bdp-lb-img'); if (im) im.src = ''; } }

    // ============ 主题 ============
    var THEME_KEY = 'bdp_theme';
    function sysDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
    function applyTheme() {
        if (!els.overlay) return;
        var dark = S.theme === 'dark' || (S.theme === 'auto' && sysDark());
        els.overlay.classList.toggle('bdp-dark', dark);
        els.overlay.classList.toggle('bdp-light', S.theme === 'light');
        if (els.theme) els.theme.textContent = S.theme === 'dark' ? '🌙 暗色' : (S.theme === 'light' ? '☀️ 亮色' : '🌓 自动');
    }
    function cycleTheme() {
        S.theme = S.theme === 'auto' ? 'dark' : (S.theme === 'dark' ? 'light' : 'auto');
        try { localStorage.setItem(THEME_KEY, S.theme); } catch (e) {}
        applyTheme();
    }

    // ============ UI ============
    GM_addStyle(`
        #bdp-launcher {
            position: fixed; right: 18px; bottom: 90px; z-index: 2147483000;
            padding: 10px 14px; border: none; border-radius: 999px; cursor: pointer;
            background: #fb7299; color: #fff; font-size: 14px; font-weight: 600;
            box-shadow: 0 4px 14px rgba(0,0,0,.25);
        }
        #bdp-overlay { position: fixed; inset: 0; z-index: 2147483100; display: none; background: rgba(20,20,20,.5);
            font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        #bdp-overlay.bdp-open { display: flex; align-items: center; justify-content: center; }
        #bdp-panel { position: relative; display: flex; flex-direction: column; width: min(760px, 94vw); height: 90vh;
            background: #fff; border-radius: 14px; box-shadow: 0 12px 50px rgba(0,0,0,.35); overflow: hidden; }
        #bdp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid #eef0f2; }
        #bdp-bar button { border: 1px solid #d9d9d9; background: #fff; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
        #bdp-bar button:hover:not(:disabled) { border-color: #fb7299; color: #fb7299; }
        #bdp-bar button:disabled { opacity: .4; cursor: not-allowed; }
        #bdp-page-now { min-width: 96px; text-align: center; font-weight: 600; font-size: 14px; }
        #bdp-page-input { width: 58px; padding: 5px 6px; border: 1px solid #d9d9d9; border-radius: 6px; font-size: 13px; }
        #bdp-date { border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
        #bdp-close { margin-left: auto; border: none !important; background: transparent !important; font-size: 22px; color: #888; }
        #bdp-status { padding: 7px 14px; font-size: 12px; color: #999; border-bottom: 1px solid #f0f0f0; background: #fafafa; }
        #bdp-status.bdp-err { color: #d33; }
        #bdp-list { flex: 1; overflow-y: auto; padding: 12px; background: #f7f8fa; }
        .bcard { background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; border: 1px solid #eef0f2; }
        .bcard .head { display: flex; align-items: center; gap: 10px; }
        .bcard .face { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #eee; }
        .bcard .who { flex: 1; min-width: 0; }
        .bcard .name { font-size: 15px; font-weight: 600; color: #1f2329; display: block; }
        .bcard .meta { font-size: 12px; color: #9aa0a6; margin-top: 2px; display: block; }
        .bcard .tag { font-size: 11px; color: #fb7299; border: 1px solid #fb7299; border-radius: 4px; padding: 1px 6px; }
        .bcard .tag.av { color: #00aeec; border-color: #00aeec; }
        .bcard .txt { margin-top: 8px; font-size: 15px; line-height: 1.7; color: #1f2329; word-break: break-word; }
        .bcard .imgs { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; margin-top: 8px; border-radius: 6px; overflow: hidden; }
        .bcard .imgs.one { grid-template-columns: 1fr; }
        .bcard .imgs img { width: 100%; height: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; background: #eee; }
        .bcard .imgs.one img { aspect-ratio: auto; max-height: 460px; object-fit: contain; }
        .bcard .video { display: flex; gap: 10px; margin-top: 8px; border: 1px solid #eef0f2; border-radius: 8px; overflow: hidden; }
        .bcard .vpic { width: 120px; height: 72px; object-fit: cover; background: #eee; flex: 0 0 auto; }
        .bcard .vtitle { padding: 8px; font-size: 14px; line-height: 1.4; display: flex; flex-direction: column; gap: 6px; }
        .bcard .vtitle a { color: #1f2329; text-decoration: none; }
        .bcard .vtitle em { color: #999; font-style: normal; font-size: 12px; }
        .bcard .article { margin-top: 8px; padding: 10px; background: #f7f8fa; border-radius: 8px; }
        .bcard .article a { color: #00aeec; text-decoration: none; font-size: 14px; }
        .bcard .fwdbox { margin-top: 8px; padding: 10px 12px; background: #f7f8fa; border-radius: 8px; }
        .bcard .fwdhead { font-size: 13px; color: #fb7299; margin-bottom: 4px; }
        .bcard .fwdtxt { font-size: 13px; color: #4b5157; line-height: 1.6; word-break: break-word; }
        .bcard .addbox { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; padding: 8px 12px; border: 1px solid #eef0f2; border-radius: 8px; font-size: 13px; }
        .bcard .addt { width: 100%; font-weight: 600; color: #1f2329; }
        .bcard .addd { color: #9aa0a6; font-size: 12px; }
        .bcard .addgo { color: #fb7299; text-decoration: none; font-size: 12px; }
        .bcard .addb { color: #fb7299; font-size: 11px; border: 1px solid #fb7299; border-radius: 4px; padding: 0 5px; }
        .bcard .fwd-media { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #eef0f2; }
        .bcard .fwd-media .fm-pic { width: 74px; height: 46px; object-fit: cover; border-radius: 4px; background: #eee; flex: 0 0 auto; }
        .bcard .fwd-media .fm-body { font-size: 12px; line-height: 1.4; min-width: 0; }
        .bcard .fwd-media .fm-body a { color: #1f2329; text-decoration: none; }
        .bcard .fwd-media .fm-tag { font-size: 11px; color: #fb7299; border: 1px solid #fb7299; border-radius: 3px; padding: 0 4px; flex: 0 0 auto; }
        .bcard .fwd-media a { color: #00aeec; text-decoration: none; font-size: 12px; }
        .bcard .stats { display: flex; align-items: center; gap: 16px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #f5f6f7; font-size: 12px; color: #9aa0a6; }
        .bcard .direct { margin-left: auto; color: #fb7299; text-decoration: none; font-size: 12px; }
        .bcard .bili-emot { width: 22px; height: 22px; vertical-align: -5px; margin: 0 1px; }
        .bcard .dress { display: inline-flex; align-items: center; gap: 3px; margin-top: 3px; font-size: 11px; color: #fb7299; background: rgba(251,114,153,.1); border-radius: 4px; padding: 1px 6px; }
        .bcard .dress img { width: 16px; height: 16px; border-radius: 3px; }
        #bdp-overlay .msg { color: #999; text-align: center; padding: 40px; }
        #bdp-overlay.bdp-dark #bdp-panel { background: #1e1e22; color: #e8e8ea; }
        #bdp-overlay.bdp-dark #bdp-bar { border-bottom-color: #2a2a2f; }
        #bdp-overlay.bdp-dark #bdp-bar button, #bdp-overlay.bdp-dark input { background: #26262b; border-color: #3a3a40; color: #d6d6da; }
        #bdp-overlay.bdp-dark #bdp-status { background: #17171a; color: #aaa; border-bottom-color: #2a2a2f; }
        #bdp-overlay.bdp-dark #bdp-list { background: #121216; }
        #bdp-overlay.bdp-dark .bcard { background: #1e1e22; border-color: #2a2a2f; }
        #bdp-overlay.bdp-dark .bcard .name, #bdp-overlay.bdp-dark .bcard .txt, #bdp-overlay.bdp-dark .bcard .vtitle a { color: #e5e6eb; }
        #bdp-overlay.bdp-dark .bcard .meta, #bdp-overlay.bdp-dark .bcard .stats { color: #7a7f88; }
        #bdp-overlay.bdp-dark .bcard .fwdbox, #bdp-overlay.bdp-dark .bcard .article { background: #17171a; }
        #bdp-overlay.bdp-dark .bcard .fwdtxt { color: #b8bcc4; }
        #bdp-overlay.bdp-dark .bcard .face { background: #26262b; }
        #bdp-overlay.bdp-dark .bcard .imgs img, #bdp-overlay.bdp-dark .bcard .vpic { background: #26262b; }
        #bdp-overlay.bdp-dark #bdp-close { color: #7a7a80; }
        .bcard .imgs img.bpic { cursor: zoom-in; }
        #bdp-lb { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; gap: 8px; background: rgba(0,0,0,.93); z-index: 40; }
        #bdp-lb.bdp-lb-open { display: flex; }
        #bdp-lb-stage { position: relative; display: flex; align-items: center; justify-content: center; max-width: calc(100% - 130px); max-height: 100%; }
        #bdp-lb-img { max-width: 100%; max-height: calc(90vh - 40px); object-fit: contain; border-radius: 4px; box-shadow: 0 8px 40px rgba(0,0,0,.7); }
        #bdp-lb-count { position: absolute; bottom: -26px; left: 0; right: 0; text-align: center; color: #ccc; font-size: 12px; }
        #bdp-lb-orig { position: absolute; top: -34px; right: 0; color: #fff; font-size: 13px; text-decoration: none; }
        #bdp-lb-prev, #bdp-lb-next { width: 42px; height: 60px; flex: 0 0 auto; border: none; border-radius: 8px; background: rgba(255,255,255,.14); color: #fff; font-size: 26px; cursor: pointer; }
        #bdp-lb-close { position: absolute; top: 10px; right: 14px; border: none; background: transparent; color: #fff; font-size: 26px; cursor: pointer; }
    `);

    function buildUI() {
        var launcher = document.createElement('button');
        launcher.id = 'bdp-launcher';
        launcher.textContent = '动态分页';
        launcher.addEventListener('click', openPanel);
        document.body.appendChild(launcher);

        var ov = document.createElement('div');
        ov.id = 'bdp-overlay';
        ov.innerHTML =
            '<div id="bdp-panel">' +
            '  <div id="bdp-bar">' +
            '    <button id="bdp-prev" title="上一页">‹ 上一页</button>' +
            '    <span id="bdp-page-now">第 1 页</span>' +
            '    <button id="bdp-next" title="下一页（无更多时自动加载）">下一页 ›</button>' +
            '    <input id="bdp-page-input" type="number" min="1" value="1"/>' +
            '    <button id="bdp-jump">跳页</button>' +
            '    <input id="bdp-date" type="date" title="按日期直达（会扫描到该日期）"/>' +
            '    <button id="bdp-goDate" title="定位到某一天附近的动态">日期直达</button>' +
            '    <button id="bdp-earliest" title="扫描到最早的动态">直达最早</button>' +
            '    <input id="bdp-dynid" type="text" placeholder="动态ID" style="width:100px"/>' +
            '    <button id="bdp-goDyn" title="输入动态ID后直达该条动态">直达动态</button>' +
            '    <button id="bdp-stop">停止加载</button>' +
            '    <button id="bdp-theme" title="外观">🌓 自动</button>' +
            '    <button id="bdp-close" title="关闭">×</button>' +
            '  </div>' +
            '  <div id="bdp-status"></div>' +
            '  <div id="bdp-list"></div>' +
            '</div>';
        document.body.appendChild(ov);

        els.launcher = launcher; els.overlay = ov;
        els.prev = ov.querySelector('#bdp-prev'); els.next = ov.querySelector('#bdp-next');
        els.pageNow = ov.querySelector('#bdp-page-now'); els.pageInput = ov.querySelector('#bdp-page-input');
        els.jump = ov.querySelector('#bdp-jump'); els.dateInput = ov.querySelector('#bdp-date');
        els.goDate = ov.querySelector('#bdp-goDate'); els.earliest = ov.querySelector('#bdp-earliest');
        els.stop = ov.querySelector('#bdp-stop'); els.theme = ov.querySelector('#bdp-theme');
        els.close = ov.querySelector('#bdp-close'); els.status = ov.querySelector('#bdp-status');
        els.dynIdInput = ov.querySelector('#bdp-dynid'); els.goDyn = ov.querySelector('#bdp-goDyn');
        els.list = ov.querySelector('#bdp-list');

        els.prev.addEventListener('click', goPrev);
        els.next.addEventListener('click', goNext);
        els.jump.addEventListener('click', function () {
            var v = parseInt(els.pageInput.value, 10);
            if (isNaN(v) || v < 1) { setStatus('请输入不小于 1 的页码。', true); return; }
            if (v > totalPages()) { setStatus('尚未加载到第 ' + v + ' 页，先点“下一页”加载更多。', true); return; }
            showPage(v);
        });
        els.pageInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') els.jump.click(); });
        els.goDate.addEventListener('click', goDate);
        els.goDyn.addEventListener('click', function () {
            var v = (els.dynIdInput.value || '').trim();
            if (!/^\d+$/.test(v)) { setStatus('请输入数字形式的动态ID。', true); return; }
            window.open('https://t.bilibili.com/' + v, '_blank');
            setStatus('已在新窗口打开动态 ' + v + '。');
        });
        els.dynIdInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') els.goDyn.click(); });
        els.earliest.addEventListener('click', goEarliest);
        els.stop.addEventListener('click', stopLoading);
        els.theme.addEventListener('click', cycleTheme);
        els.close.addEventListener('click', closePanel);
        ov.addEventListener('click', function (e) { if (e.target === ov) closePanel(); });
        els.list.addEventListener('click', function (e) {
            var im = e.target && e.target.closest ? e.target.closest('img.bpic') : null;
            if (!im) return;
            var cardEl = im.closest('.bcard');
            var dyn = cardEl ? cardEl.getAttribute('data-dyn') : '';
            var j = Number(im.getAttribute('data-j')) || 0;
            var p = null;
            for (var i = 0; i < S.posts.length; i++) { if (String(S.posts[i].dynId) === String(dyn)) { p = S.posts[i]; break; } }
            if (p && p.pics && p.pics.length) openLightbox(p.pics, j, dyn);
        });
        document.addEventListener('keydown', function (e) {
            if (!ov.classList.contains('bdp-open')) return;
            if (lbOpen()) {
                if (e.key === 'Escape') lbClose();
                else if (e.key === 'ArrowLeft') lbPrev();
                else if (e.key === 'ArrowRight') lbNext();
                return;
            }
            if (e.key === 'Escape') closePanel();
            else if (e.key === 'ArrowLeft' && !S.loading) goPrev();
            else if (e.key === 'ArrowRight' && !S.loading) goNext();
        });
        applyTheme();
    }

    function openPanel() {
        els.overlay.classList.add('bdp-open');
        openFirst();
    }
    function closePanel() { els.overlay.classList.remove('bdp-open'); }

    function keepAlive() {
        setInterval(function () {
            if (!document.getElementById('bdp-launcher') && location.pathname.match(/^\/(\d+)\/dynamic/)) {
                var b = document.createElement('button');
                b.id = 'bdp-launcher'; b.textContent = '动态分页';
                b.addEventListener('click', openPanel);
                document.body.appendChild(b);
                els.launcher = b;
            }
        }, 3000);
    }

    function init() {
        console.log(TAG, '启动 uid=' + UID);
        try { var v = localStorage.getItem(THEME_KEY); if (v === 'dark' || v === 'light' || v === 'auto') S.theme = v; } catch (e) {}
        buildUI();
        keepAlive();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else { init(); }

    window.__bdp = { state: S, open: openPanel };
})();
