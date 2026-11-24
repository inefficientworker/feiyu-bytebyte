// ==UserScript==
// @name         肥鱼拜拜 · B站评论折叠
// @namespace    feiyu-byebye
// @version      0.1.1
// @description  本地识别头像，结合昵称和等级评分折叠大肥鱼评论；可展开、加白名单。
// @updateURL    https://raw.githubusercontent.com/inefficientworker/feiyu-bytebyte/main/feiyu-byebye.user.js
// @downloadURL  https://raw.githubusercontent.com/inefficientworker/feiyu-bytebyte/main/feiyu-byebye.user.js
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      hf-mirror.com
// @connect      huggingface.co
// @connect      hf.co
// @connect      xethub.hf.co
// @connect      cdn-lfs.huggingface.co
// @connect      cdn-lfs-us-1.huggingface.co
// @connect      cdn-lfs.hf.co
// @connect      hdslb.com
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js#sha256=be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8
// ==/UserScript==

(() => {
  'use strict';

  // ── 用户设置：可疑分越高越容易折叠。修改后刷新 B 站页面。──
  const SCORE_THRESHOLD = 80;
  const LIKE_EXEMPTION_THRESHOLD = 5; // 单条评论点赞数严格大于此值时不折叠（5 赞仍参与评分）
  const AVATAR_WEIGHT = 70; // 头像分 = 模型概率 (0~1) × 70
  const MIN_AVATAR_PROBABILITY = 0.42624813318252563; // 模型校准值；头像必须先过此门槛
  const LOW_LEVEL_MAX = 3;
  const LOW_LEVEL_SCORE = 15; // 低等级降低可信度，即增加可疑分；未知等级不加分
  const NAME_RULES = [ // 取最高一项，不重复累计“鱼 / 小鱼 / 肥鱼”
    { words: ['大肥鱼', '鲸鱼娘'], score: 30 },
    { words: ['肥鱼', 'deepseek'], score: 25 },
    { words: ['小鱼'], score: 20 },
    { words: ['鲸'], score: 15 },
    { words: ['鱼'], score: 10 },
  ];
  const NAME_ROLE_WORDS = ['打工', '运营', '营业', '加班', '摸鱼', '投喂'];
  const NAME_ROLE_BONUS = 5; // 仅在已匹配上面某个名字线索时加分
  const BUILTIN_WHITELIST = ['3747571004608077', '518791169'];
  const MODEL = {
    repo: 'inefficentworker/is-dafeiyu',
    revision: 'db483a6f487008e849a91617e9eb491083c180ac',
    file: 'artifacts/mobilenetv3_user_20261123/model_browser_fp16.onnx',
    sha256: '52a25ed2102b84cd552241ba5b29e4c53708fe256cead50a25deaea039e5588a',
    bytes: 8439096,
    imageSize: 224,
  };
  const MODEL_HOSTS = ['https://hf-mirror.com', 'https://huggingface.co'];
  const MODEL_TIMEOUT_MS = 25000; // 每个源的超时，失败自动尝试下一个
  const AVATAR_TIMEOUT_MS = 12000;
  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  const RESULT_CACHE_DAYS = 7;
  const RESULT_CACHE_LIMIT = 2000;

  const PREFIX = 'fyb';
  const MODEL_KEY = `${PREFIX}:model:${MODEL.sha256}`;
  const RESULTS_KEY = `${PREFIX}:avatars:${MODEL.sha256}`;
  const WHITE_KEY = `${PREFIX}:whitelist`;
  const CARD_SELECTOR = 'bili-comment-renderer,bili-comment-reply-renderer,.root-reply-container,.sub-reply-item,.reply-wrap';
  const SHADOW_SELECTOR = 'bili-comments,bili-comment-thread-renderer,bili-comment-renderer,bili-comment-reply-renderer,bili-comment-replies-renderer,bili-comment-user-info,bili-comment-action-buttons-renderer,bili-avatar';
  const SIMPLIFIED = { 魚: '鱼', 鯨: '鲸', 孃: '娘', 運: '运', 營: '营' };
  const records = new Map();
  const roots = new Map();
  const avatarJobs = new Map();
  const builtin = new Set(BUILTIN_WHITELIST);
  let whitelist = {};
  let avatarCache = {};
  let sessionPromise;
  let modelFailure;
  let inferenceTail = Promise.resolve();
  let scanTimer;
  let saveTimer;
  const status = { model: '尚未需要模型', downloads: [], cache: '', errors: [], inferences: 0 };

  function report(error) {
    const message = String(error?.message || error);
    if (!status.errors.includes(message)) {
      status.errors.push(message);
      status.errors = status.errors.slice(-12);
      console.warn('[肥鱼拜拜]', message);
    }
  }

  function normalizeName(name) {
    return Array.from(name.normalize('NFKC').toLowerCase(), c => SIMPLIFIED[c] || c).join('');
  }

  function nameScore(name) {
    const text = normalizeName(name);
    let score = 0;
    for (const rule of NAME_RULES) {
      if (rule.words.some(word => text.includes(word))) score = Math.max(score, rule.score);
    }
    return score + (score > 0 && NAME_ROLE_WORDS.some(word => text.includes(word)) ? NAME_ROLE_BONUS : 0);
  }

  function scoreAccount(account, probability) {
    const avatar = probability * AVATAR_WEIGHT;
    const name = nameScore(account.name);
    const level = account.level !== null && account.level <= LOW_LEVEL_MAX ? LOW_LEVEL_SCORE : 0;
    const total = avatar + name + level;
    return { probability, avatar, name, level, total,
      fold: probability >= MIN_AVATAR_PROBABILITY && total >= SCORE_THRESHOLD };
  }

  function isWhitelisted(uid) {
    return builtin.has(uid) || Object.hasOwn(whitelist, uid);
  }

  function isUid(value) {
    return typeof value === 'string' && value.length > 0 && Array.from(value).every(c => c >= '0' && c <= '9');
  }

  function uidFromLink(link) {
    try {
      const url = new URL(link, location.href);
      const uid = url.pathname.split('/')[1];
      return url.hostname === 'space.bilibili.com' && isUid(uid) ? uid : null;
    } catch { return null; }
  }

  function avatarUrl(source) {
    try {
      const url = new URL(source, location.href);
      if (!url.hostname.endsWith('.hdslb.com') || !url.pathname.startsWith('/bfs/face/')) return null;
      url.protocol = 'https:';
      url.pathname = url.pathname.split('@')[0]; // 原图，避免 24/48px 缩略图损失特征
      url.search = '';
      return url.href;
    } catch { return null; }
  }

  function readLevel(scope) {
    if (!scope) return null;
    const icon = scope.querySelector('#user-level img,.level img,.user-level img');
    const file = (icon?.getAttribute('src') || '').split('/').pop().split('.')[0];
    if (file === 'level_h') return 6;
    if (file.startsWith('level_')) {
      const value = file.slice(6);
      if (value.length === 1 && value >= '0' && value <= '6') return Number(value);
    }
    const legacy = scope.querySelector('.level,.user-level');
    for (const className of legacy?.classList || []) {
      for (const prefix of ['level-', 'level_', 'l']) {
        const value = className.startsWith(prefix) ? className.slice(prefix.length) : '';
        if (value.length === 1 && value >= '0' && value <= '6') return Number(value);
      }
    }
    return null; // 缺少等级不等于 LV0
  }

  function readAccount(card) {
    if (card.shadowRoot) {
      const scope = card.shadowRoot;
      const user = scope.querySelector('bili-comment-user-info')?.shadowRoot;
      const link = user?.querySelector('#user-name a');
      const avatar = scope.querySelector('#user-avatar');
      const img = avatar?.querySelector('img') || avatar?.querySelector('bili-avatar')?.shadowRoot?.querySelector('img');
      const uid = uidFromLink(link?.href);
      const name = link?.textContent.trim();
      const face = avatarUrl(img?.getAttribute('src'));
      return uid && name && face ? { uid, name, face, level: readLevel(user), scope, body: scope.querySelector('#body') } : null;
    }
    const link = card.querySelector('.user-name,.sub-user-name,.user .name');
    const uid = link?.getAttribute('data-user-id') || uidFromLink(link?.href);
    const name = link?.textContent.trim();
    const img = card.querySelector('.reply-avatar img,.sub-reply-avatar img,.user-face img,.face img');
    const face = avatarUrl(img?.getAttribute('src') || img?.getAttribute('data-src'));
    // 旧版容器可能包住整个楼层，只隐藏本人的 body，不隐藏其他人的楼中楼。
    const body = card.querySelector(':scope > .root-reply,:scope > .con') || card;
    return isUid(uid) && name && face ? { uid, name, face, level: readLevel(card), scope: card, body } : null;
  }

  function readLikes(record) {
    const { card, account } = record;
    const count = card.shadowRoot
      ? card.shadowRoot.querySelector('bili-comment-action-buttons-renderer')?.shadowRoot?.querySelector('#like #count')
      : account.body.querySelector('.reply-like .like-count,.reply-like,.info > .like > span');
    if (!count) return null;
    let text = count.textContent.trim().normalize('NFKC').replaceAll(',', '');
    if (text === '' || text === '点赞') return 0;
    let multiplier = 1;
    for (const [suffix, scale] of [['万', 10000], ['亿', 100000000]]) {
      if (text.endsWith(suffix)) { text = text.slice(0, -suffix.length); multiplier = scale; break; }
    }
    const value = Number(text) * multiplier;
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function likesExempt(record) {
    record.likes = readLikes(record);
    // 点赞组件尚未就绪时先保留评论，避免高赞评论短暂被折叠。
    return record.likes === null || record.likes > LIKE_EXEMPTION_THRESHOLD;
  }

  function requestBytes(url, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout, anonymous: true,
        onload: response => response.status >= 200 && response.status < 300 && response.response
          ? resolve(new Uint8Array(response.response)) : reject(new Error(`${new URL(url).hostname}: HTTP ${response.status}`)),
        onerror: () => reject(new Error(`${new URL(url).hostname}: 下载失败`)),
        ontimeout: () => reject(new Error(`${new URL(url).hostname}: 下载超时`)),
        onabort: () => reject(new Error(`${new URL(url).hostname}: 下载已取消`)),
      });
    });
  }

  async function verifyModel(bytes) {
    if (bytes.byteLength !== MODEL.bytes) throw new Error('模型大小不符');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== MODEL.sha256) throw new Error('模型 SHA-256 不符');
    return bytes;
  }

  function toBase64(bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    return btoa(chunks.join(''));
  }

  async function loadModel() {
    status.model = '检查模型缓存';
    try {
      const cached = await GM_getValue(MODEL_KEY, null);
      if (cached) {
        const bytes = Uint8Array.from(atob(cached), c => c.charCodeAt(0));
        await verifyModel(bytes);
        status.cache = '已校验缓存 SHA-256';
        return bytes;
      }
    } catch (error) {
      report(error);
      await GM_deleteValue(MODEL_KEY);
      status.cache = '损坏的缓存已删除';
    }
    for (const host of MODEL_HOSTS) {
      status.model = `下载模型：${new URL(host).hostname}`;
      const attempt = { host, result: '下载中' };
      status.downloads.push(attempt);
      try {
        const bytes = await verifyModel(await requestBytes(`${host}/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`, MODEL_TIMEOUT_MS));
        attempt.result = 'SHA-256 校验通过';
        try {
          await GM_setValue(MODEL_KEY, toBase64(bytes));
          status.cache = '已保存模型缓存';
        } catch (error) { report(error); status.cache = '无法保存缓存，本次仍可识别'; }
        return bytes;
      } catch (error) { attempt.result = String(error.message); report(error); }
    }
    throw new Error('镜像和官网均无法获取有效模型；保留评论，可从脚本菜单重试');
  }

  function getSession() {
    if (modelFailure) return Promise.reject(modelFailure);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const bytes = await loadModel();
        status.model = '加载推理引擎';
        ort.env.wasm.wasmPaths = ORT_CDN;
        ort.env.wasm.numThreads = 1; // B站未启用跨源隔离，不依赖 SharedArrayBuffer
        ort.env.wasm.proxy = false;
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        status.model = '模型就绪';
        return session;
      })().catch(error => {
        modelFailure = error;
        sessionPromise = null;
        status.model = '识别暂不可用（评论保持显示）';
        throw error;
      });
    }
    return sessionPromise;
  }

  function saveResults() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const entries = Object.entries(avatarCache).filter(([, v]) => Date.now() - v.time < RESULT_CACHE_DAYS * 86400000);
      entries.sort((a, b) => b[1].time - a[1].time);
      avatarCache = Object.fromEntries(entries.slice(0, RESULT_CACHE_LIMIT));
      try { await GM_setValue(RESULTS_KEY, avatarCache); } catch (error) { report(error); }
    }, 800);
  }

  function detectAvatar(face) {
    const cached = avatarCache[face];
    if (cached && Number.isFinite(cached.probability) && cached.probability >= 0 && cached.probability <= 1 && Date.now() - cached.time < RESULT_CACHE_DAYS * 86400000) {
      return Promise.resolve(cached.probability);
    }
    if (avatarJobs.has(face)) return avatarJobs.get(face);
    // 同一头像合并请求；WASM 推理串行，避免并发占满主线程。
    const job = inferenceTail.then(async () => {
      const session = await getSession();
      const bytes = await requestBytes(face, AVATAR_TIMEOUT_MS);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const size = MODEL.imageSize;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      try {
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, size, size);
      } finally { bitmap.close(); }
      const input = new ort.Tensor('uint8', new Uint8Array(context.getImageData(0, 0, size, size).data.buffer), [1, size, size, 4]);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: input });
        const probability = Number(outputs[session.outputNames[0]].data[0]);
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('模型输出无效');
        avatarCache[face] = { probability, time: Date.now() };
        status.inferences++;
        saveResults();
        return probability;
      } finally {
        input.dispose();
        if (outputs) for (const output of Object.values(outputs)) output.dispose();
      }
    });
    inferenceTail = job.catch(() => {});
    avatarJobs.set(face, job);
    job.finally(() => avatarJobs.delete(face)).catch(() => {});
    return job;
  }

  const CSS = `
    .fyb-bar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:10px 0; color:var(--text2,#888); font:13px/1.6 system-ui,sans-serif; }
    .fyb-bar a { color:var(--text2,#888); text-decoration:none; }
    .fyb-bar img { width:32px; height:32px; border-radius:50%; object-fit:cover; vertical-align:middle; }
    .fyb-bar button { padding:2px 7px; border:1px solid var(--line_regular,#8885); border-radius:5px; background:transparent; color:var(--text_link,#00aeec); font:inherit; cursor:pointer; }
    .fyb-bar button:hover { background:var(--graph_bg_thin,#8882); }
    .fyb-bar button:focus-visible { outline:2px solid #00aeec; outline-offset:2px; }
    .fyb-bar details { flex-basis:100%; margin-left:40px; }
    .fyb-bar[hidden], .fyb-bar details[hidden] { display:none !important; }
    :host([data-fyb-collapsed]) > #body { display:none !important; }
    [data-fyb-hidden] { display:none !important; }
    [data-fyb-self] > :not(.fyb-bar):not(style):not(.sub-reply-container):not(.reply-box) { display:none !important; }
  `;

  function ensureStyle(scope) {
    const root = scope instanceof ShadowRoot ? scope : scope.getRootNode();
    if (root.querySelector('style[data-fyb-style]')) return;
    const style = document.createElement('style');
    style.dataset.fybStyle = '';
    style.textContent = CSS;
    (root.head || root).append(style);
  }

  function restore(record) {
    record.card.removeAttribute('data-fyb-collapsed');
    record.account?.body?.removeAttribute('data-fyb-hidden');
    record.card.removeAttribute('data-fyb-self');
    record.bar?.remove();
    record.bar = null;
  }

  function setCollapsed(record, collapsed) {
    const { card, account } = record;
    record.expanded = !collapsed;
    if (card.shadowRoot) card.toggleAttribute('data-fyb-collapsed', collapsed);
    else if (account.body === card) card.toggleAttribute('data-fyb-self', collapsed);
    else account.body.toggleAttribute('data-fyb-hidden', collapsed);
    record.toggle.textContent = collapsed ? '展开评论' : '收起评论';
    record.toggle.setAttribute('aria-expanded', String(!collapsed));
    record.details.hidden = collapsed;
  }

  function button(text, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    return element;
  }

  async function addWhitelist(record) {
    try {
      whitelist = { ...await GM_getValue(WHITE_KEY, {}), [record.account.uid]: record.account.name };
      await GM_setValue(WHITE_KEY, whitelist);
      rescore();
    } catch (error) { report(error); alert('白名单保存失败，请从脚本菜单重试。'); }
  }

  function fold(record) {
    const { card, account, score } = record;
    // 异步推理完成、白名单改变时也重新读取，不能沿用请求前的点赞数。
    if (likesExempt(record)) { restore(record); return; }
    if (record.bar?.isConnected) return;
    ensureStyle(account.scope);
    const bar = document.createElement('div');
    bar.className = 'fyb-bar';
    bar.dataset.fybUid = account.uid;
    bar.dataset.fybScore = score.total.toFixed(2);
    const avatar = document.createElement('a');
    avatar.href = `https://space.bilibili.com/${account.uid}`;
    avatar.target = '_blank';
    avatar.rel = 'noopener noreferrer';
    const image = document.createElement('img');
    image.src = account.face;
    image.alt = `${account.name}的头像`;
    avatar.append(image);
    const name = avatar.cloneNode(false);
    name.textContent = account.name;
    const toggle = button('展开评论', () => setCollapsed(record, record.expanded));
    const allow = button('加入白名单', () => { void addWhitelist(record); });
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `判定明细 · ${score.total.toFixed(1)} 分`;
    const text = document.createElement('div');
    text.textContent = `头像 ${(score.probability * 100).toFixed(2)}% × ${AVATAR_WEIGHT} = ${score.avatar.toFixed(1)}；昵称 +${score.name}；等级 ${account.level ?? '未知'} +${score.level}；折叠阈值 ${SCORE_THRESHOLD}。`;
    details.append(summary, text);
    bar.append(avatar, name, toggle, allow, details);
    record.bar = bar;
    record.toggle = toggle;
    record.details = details;
    account.scope.prepend(bar);
    setCollapsed(record, !record.expanded);
  }

  function rescore() {
    for (const record of records.values()) {
      if (isWhitelisted(record.account.uid)) restore(record);
      else if (record.score?.fold) fold(record);
      else if (record.state === 'whitelist') { record.state = 'new'; scheduleScan(); }
    }
  }

  function processCard(card) {
    const account = readAccount(card);
    if (!account?.body) {
      const stale = records.get(card);
      if (stale) { restore(stale); records.delete(card); }
      return;
    }
    const fingerprint = JSON.stringify([account.uid, account.name, account.face, account.level]);
    let record = records.get(card);
    if (record?.fingerprint !== fingerprint) {
      if (record) restore(record);
      record = { card, account, fingerprint, state: 'new', expanded: false };
      records.set(card, record);
    }
    record.account = account;
    if (isWhitelisted(account.uid)) { restore(record); record.state = 'whitelist'; return; }
    if (likesExempt(record)) { restore(record); return; }
    if (record.state !== 'new') {
      if (record.score?.fold && !record.bar?.isConnected) fold(record);
      return;
    }
    // 即使头像满分也达不到阈值时，免去下载/推理。
    const maxScore = scoreAccount(account, 1).total;
    if (maxScore < SCORE_THRESHOLD) { record.state = 'below-maximum'; return; }
    record.state = 'pending';
    detectAvatar(account.face).then(probability => {
      if (records.get(card) !== record || !card.isConnected) return;
      record.score = scoreAccount(account, probability);
      record.state = 'done';
      if (record.score.fold && !isWhitelisted(account.uid)) fold(record);
    }).catch(error => { record.state = 'error'; report(error); });
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 120);
  }

  function observe(root) {
    if (roots.has(root)) return;
    const observer = new MutationObserver(changes => {
      if (changes.some(change => {
        const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
        return target && target.tagName !== 'STYLE' && !target.closest('.fyb-bar,style');
      })) scheduleScan();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'data-user-id'] });
    roots.set(root, observer);
  }

  function scan() {
    scanTimer = null;
    for (const [root, observer] of roots) {
      if (root.host && !root.host.isConnected) { observer.disconnect(); roots.delete(root); }
    }
    for (const [card, record] of records) {
      if (!card.isConnected) { restore(record); records.delete(card); }
    }
    const visit = root => {
      observe(root);
      for (const card of root.querySelectorAll(CARD_SELECTOR)) processCard(card);
      for (const host of root.querySelectorAll(SHADOW_SELECTOR)) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
  }

  function retry() {
    modelFailure = null;
    for (const record of records.values()) if (record.state === 'error') record.state = 'new';
    scheduleScan();
  }

  function diagnostics() {
    return { ...status, threshold: SCORE_THRESHOLD, likeExemptionThreshold: LIKE_EXEMPTION_THRESHOLD, modelSha256: MODEL.sha256,
      builtinWhitelist: BUILTIN_WHITELIST, whitelist,
      comments: Array.from(records.values(), r => ({ uid: r.account.uid, name: r.account.name, level: r.account.level, likes: r.likes,
        state: r.state, score: r.score, whitelisted: isWhitelisted(r.account.uid), folded: Boolean(r.bar?.isConnected && !r.expanded) })) };
  }

  async function start() {
    whitelist = await GM_getValue(WHITE_KEY, {});
    avatarCache = await GM_getValue(RESULTS_KEY, {});
    GM_registerMenuCommand('肥鱼拜拜：运行状态 / 评分明细', () => alert(JSON.stringify(diagnostics(), null, 2)));
    GM_registerMenuCommand('肥鱼拜拜：重试识别', retry);
    GM_registerMenuCommand('肥鱼拜拜：管理白名单', async () => {
      const entries = Object.entries(whitelist);
      const value = prompt(`内置保护 UID：${BUILTIN_WHITELIST.join('、')}\n自定义白名单（每行一个 UID；删除该行即可移除）：`, entries.map(([uid]) => uid).join('\n'));
      if (value === null) return;
      const ids = value.split('\n').map(s => s.trim()).filter(Boolean);
      if (ids.some(uid => !isUid(uid))) { alert('请输入每行一个纯数字 UID。'); return; }
      const updated = Object.fromEntries(ids.map(uid => [uid, whitelist[uid] || uid]));
      try { await GM_setValue(WHITE_KEY, updated); whitelist = updated; rescore(); } catch (error) { report(error); }
    });
    GM_registerMenuCommand('肥鱼拜拜：清除模型及识别缓存', async () => {
      await GM_deleteValue(MODEL_KEY);
      await GM_deleteValue(RESULTS_KEY);
      avatarCache = {};
      alert('缓存已清除，刷新页面后重新下载并识别。白名单已保留。');
    });
    GM_addValueChangeListener(WHITE_KEY, (_name, _old, value) => { whitelist = value || {}; rescore(); });
    window.addEventListener('online', retry);
    scan();
    // attachShadow 本身不触发外部 MutationObserver；补扫新挂载的评论组件。
    setInterval(() => { if (!document.hidden) scheduleScan(); }, 1500);
  }

  start().catch(report);
})();
