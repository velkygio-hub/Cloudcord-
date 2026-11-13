/*
 * CloudCord Plus  v1.0.0
 * Plugin no formato CloudCord/Bunny: o loader avalia este código como
 *   (bunny, definePlugin) => { <este arquivo>; return plugin }
 *
 * Camadas:
 *   1) Camada BD  – BdApi (subconjunto) + loader de plugins do BetterDiscord
 *   2) Features   – registro modular (cada feature = 1 item em FEATURES)
 *   3) Acesso     – features "tester"/"owner" só ativam para usuários da lista
 */

const { metro, api, ui, utils } = bunny;
const common = metro.common || {};
const React = common.React;
const RN = common.ReactNative;
const log = (bunny.plugin && bunny.plugin.logger) || console;

/* ------------------------------------------------------------------ *
 * Acesso por usuário (client-side; só decide quais features aparecem)
 * Valores: username em minúsculas OU ID numérico do Discord.
 * ------------------------------------------------------------------ */
const ACCESS = {
  tester: ["velky_testes"],
  owner: ["xohus"], // ASSUMIDO: é o handle do GitHub do dono. Troque pelo @ real do Discord.
};

/* ------------------------------------------------------------------ *
 * Storage persistente (com fallback em memória)
 * ------------------------------------------------------------------ */
let storage;
try { storage = bunny.plugin.createStorage(); } catch (e) { storage = {}; }
const getStore = (k, d) => (storage[k] === undefined ? d : storage[k]);
const setStore = (k, v) => { storage[k] = v; };

/* ------------------------------------------------------------------ *
 * Helpers gerais
 * ------------------------------------------------------------------ */
const disposers = [];
const onDispose = (fn) => { disposers.push(fn); return fn; };
const MAX_MSG = 2000;
const clip = (s) => (String(s).length > MAX_MSG ? String(s).slice(0, MAX_MSG - 1) + "…" : String(s));

function toast(text) {
  try { return ui.toasts.showToast(String(text)); } catch (e) { log.log && log.log(text); }
}

function currentUser() {
  try {
    const store = metro.findByStoreName("UserStore");
    return store && store.getCurrentUser && store.getCurrentUser();
  } catch (e) { return null; }
}

function currentTiers() {
  const u = currentUser();
  const tiers = new Set(["public"]);
  if (!u) return tiers;
  const keys = [u.username, u.globalName, u.id].filter(Boolean).map((x) => String(x).toLowerCase());
  const hit = (list) => list.some((x) => keys.includes(String(x).toLowerCase()));
  if (hit(ACCESS.owner)) { tiers.add("owner"); tiers.add("tester"); }
  if (hit(ACCESS.tester)) tiers.add("tester");
  return tiers;
}

function localReply(ctx, text) {
  try {
    common.messageUtil.sendBotMessage(ctx.channel.id, clip(text));
    return undefined;
  } catch (e) {
    toast(clip(text).slice(0, 200));
    return undefined;
  }
}

function argsToMap(args) {
  const out = {};
  (args || []).forEach((a) => { out[a.name] = a.value; });
  return out;
}

/* ------------------------------------------------------------------ *
 * CAMADA BD
 * ------------------------------------------------------------------ */
const bdState = {
  plugins: new Map(),      // name -> { meta, source, url, instance, enabled, error }
  patches: new Map(),      // caller -> [unpatch]
  unsupported: new Set(),  // APIs de DOM/Electron chamadas
};

const noteUnsupported = (what) => {
  if (!bdState.unsupported.has(what)) {
    bdState.unsupported.add(what);
    log.warn && log.warn("[BD] API não suportada no mobile: " + what);
  }
};

/* --- iteração segura no registry do Metro (só módulos já inicializados) --- */
function* metroExports() {
  const reg = globalThis.modules;
  if (!reg) return;
  const entries = reg instanceof Map ? reg.entries() : Object.entries(reg);
  for (const [id, m] of entries) {
    try {
      if (m && m.isInitialized && m.publicModule && m.publicModule.exports != null) {
        yield [id, m.publicModule.exports];
      }
    } catch (e) { /* ignora módulos com getters que lançam */ }
  }
}

function scanModules(filter, { all = false, defaultExport = true, searchExports = false } = {}) {
  const found = [];
  for (const [id, exp] of metroExports()) {
    try {
      if (filter(exp, { exports: exp }, id)) { found.push(exp); if (!all) break; }
      if (defaultExport && exp && exp.default && filter(exp.default, { exports: exp }, id)) {
        found.push(exp.default); if (!all) break;
      }
      if (searchExports && exp && typeof exp === "object") {
        for (const k of Object.keys(exp)) {
          const v = exp[k];
          if (v && filter(v, { exports: exp }, id)) { found.push(v); if (!all) break; }
        }
        if (!all && found.length) break;
      }
    } catch (e) { /* filtro do plugin pode quebrar em exports estranhos */ }
  }
  return all ? found : found[0];
}

const Filters = {
  byProps: (...p) => (m) => m != null && p.every((k) => { try { return m[k] !== undefined; } catch (e) { return false; } }),
  byKeys: (...p) => Filters.byProps(...p),
  byDisplayName: (n) => (m) => m != null && (m.displayName === n || m.name === n),
  byStrings: (...s) => (m) => {
    if (typeof m !== "function") return false;
    let src; try { src = Function.prototype.toString.call(m); } catch (e) { return false; }
    return s.every((x) => src.includes(x));
  },
  byStoreName: (n) => (m) => m != null && typeof m.getName === "function" && (() => { try { return m.getName() === n; } catch (e) { return false; } })(),
  byRegex: (re) => (m) => typeof m === "function" && re.test(Function.prototype.toString.call(m)),
  not: (f) => (...a) => !f(...a),
  combine: (...fs) => (...a) => fs.every((f) => f(...a)),
};

const Webpack = {
  Filters,
  getModule(filter, opts = {}) {
    if (opts && opts.all) return scanModules(filter, { ...opts, all: true });
    return scanModules(filter, opts);
  },
  getModules(filter, opts = {}) { return scanModules(filter, { ...opts, all: true }); },
  getByProps(...props) {
    let opts = {};
    const last = props[props.length - 1];
    if (last && typeof last === "object") { opts = props.pop(); }
    try { const r = metro.findByProps(...props); if (r) return r; } catch (e) {}
    return scanModules(Filters.byProps(...props), opts);
  },
  getAllByProps(...props) { return scanModules(Filters.byProps(...props), { all: true }); },
  getByKeys(...props) { return Webpack.getByProps(...props); },
  getByDisplayName(name) {
    try { const r = metro.findByDisplayName(name); if (r) return r; } catch (e) {}
    return scanModules(Filters.byDisplayName(name));
  },
  getByStrings(...strs) { return scanModules(Filters.byStrings(...strs), { searchExports: true }); },
  getStore(name) {
    try { const r = metro.findByStoreName(name); if (r) return r; } catch (e) {}
    return scanModules(Filters.byStoreName(name));
  },
  waitForModule(filter, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const r = scanModules(filter);
        if (r) return resolve(r);
        if (Date.now() - t0 > timeout) return reject(new Error("waitForModule: timeout"));
        setTimeout(tick, 500);
      };
      tick();
    });
  },
};

/* --- Patcher (BD → patcher do bunny) --- */
function trackPatch(caller, unpatch) {
  const k = String(caller);
  if (!bdState.patches.has(k)) bdState.patches.set(k, []);
  bdState.patches.get(k).push(unpatch);
  return unpatch;
}

const Patcher = {
  before(caller, mod, method, cb) {
    return trackPatch(caller, api.patcher.before(method, mod, function (args) { cb(this, args); }));
  },
  after(caller, mod, method, cb) {
    return trackPatch(caller, api.patcher.after(method, mod, function (args, ret) {
      const r = cb(this, args, ret);
      return r === undefined ? ret : r;
    }));
  },
  instead(caller, mod, method, cb) {
    return trackPatch(caller, api.patcher.instead(method, mod, function (args, orig) { return cb(this, args, orig); }));
  },
  unpatchAll(caller) {
    const k = String(caller);
    (bdState.patches.get(k) || []).forEach((u) => { try { u(); } catch (e) {} });
    bdState.patches.delete(k);
  },
  getPatchesByCaller(caller) { return (bdState.patches.get(String(caller)) || []).slice(); },
};

/* --- Data (persistência por plugin) --- */
const Data = {
  load(plugin, key) {
    const all = getStore("bdData", {});
    return all[plugin] ? all[plugin][key] : undefined;
  },
  save(plugin, key, value) {
    const all = JSON.parse(JSON.stringify(getStore("bdData", {})));
    (all[plugin] = all[plugin] || {})[key] = JSON.parse(JSON.stringify(value === undefined ? null : value));
    setStore("bdData", all);
  },
  delete(plugin, key) {
    const all = JSON.parse(JSON.stringify(getStore("bdData", {})));
    if (all[plugin]) delete all[plugin][key];
    setStore("bdData", all);
  },
};

/* --- UI --- */
const UI = {
  showToast(content, options = {}) { toast(content); },
  alert(title, content) {
    try { RN.Alert.alert(String(title), typeof content === "string" ? content : String(content)); } catch (e) { toast(title); }
  },
  showConfirmationModal(title, content, options = {}) {
    const { confirmText = "OK", cancelText = "Cancelar", onConfirm, onCancel } = options;
    try {
      RN.Alert.alert(String(title), typeof content === "string" ? content : "(conteúdo)", [
        { text: cancelText, style: "cancel", onPress: () => onCancel && onCancel() },
        { text: confirmText, onPress: () => onConfirm && onConfirm() },
      ]);
    } catch (e) { toast(title); }
  },
};

/* --- DOM / CSS / Electron: não existem no mobile --- */
const DOM = new Proxy({}, {
  get(_, prop) {
    if (prop === "addStyle" || prop === "removeStyle") return () => { noteUnsupported("DOM." + String(prop)); return () => {}; };
    return (...a) => { noteUnsupported("DOM." + String(prop)); return null; };
  },
});

const BdLogger = {
  log: (n, ...m) => log.log && log.log(`[BD:${n}]`, ...m),
  info: (n, ...m) => log.log && log.log(`[BD:${n}]`, ...m),
  warn: (n, ...m) => log.warn && log.warn(`[BD:${n}]`, ...m),
  error: (n, ...m) => log.error && log.error(`[BD:${n}]`, ...m),
  debug: (n, ...m) => log.log && log.log(`[BD:${n}]`, ...m),
};

const Utils = {
  findInTree: (...a) => utils.findInTree(...a),
  debounce(fn, ms = 100) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
  extend(target, ...srcs) { return Object.assign(target, ...srcs); },
  className: (...c) => c.flat(Infinity).filter(Boolean).join(" "),
  semverCompare(a, b) {
    const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
    return 0;
  },
};

const Plugins = {
  get: (n) => (bdState.plugins.get(n) || {}).instance,
  getAll: () => [...bdState.plugins.values()].map((p) => p.instance).filter(Boolean),
  isEnabled: (n) => !!(bdState.plugins.get(n) || {}).enabled,
  enable: (n) => bdEnable(n),
  disable: (n) => bdDisable(n),
  reload: (n) => { bdDisable(n); return bdEnable(n); },
};
const Themes = { get: () => undefined, getAll: () => [], isEnabled: () => false, enable() {}, disable() {}, reload() {} };

function buildApi(callerName) {
  const bound = callerName != null;
  const api_ = {
    Patcher: bound ? {
      before: (m, f, c) => Patcher.before(callerName, m, f, c),
      after: (m, f, c) => Patcher.after(callerName, m, f, c),
      instead: (m, f, c) => Patcher.instead(callerName, m, f, c),
      unpatchAll: () => Patcher.unpatchAll(callerName),
      getPatchesByCaller: () => Patcher.getPatchesByCaller(callerName),
    } : Patcher,
    Data: bound ? {
      load: (k) => Data.load(callerName, k),
      save: (k, v) => Data.save(callerName, k, v),
      delete: (k) => Data.delete(callerName, k),
    } : Data,
    Logger: bound ? {
      log: (...m) => BdLogger.log(callerName, ...m), info: (...m) => BdLogger.info(callerName, ...m),
      warn: (...m) => BdLogger.warn(callerName, ...m), error: (...m) => BdLogger.error(callerName, ...m),
      debug: (...m) => BdLogger.debug(callerName, ...m),
    } : BdLogger,
    UI, DOM, Webpack, Utils, Plugins, Themes,
    React, ReactDOM: {}, ReactUtils: {}, ContextMenu: {}, Components: {},
    Net: { fetch: (...a) => globalThis.fetch(...a) },
    version: "1.11.0-cloudcord-plus",
  };
  // atalhos legados
  api_.showToast = UI.showToast; api_.alert = UI.alert;
  api_.loadData = (p, k) => Data.load(p, k); api_.saveData = (p, k, v) => Data.save(p, k, v);
  api_.findModule = (f) => Webpack.getModule(f);
  api_.findModuleByProps = (...p) => Webpack.getByProps(...p);
  api_.findModuleByDisplayName = (n) => Webpack.getByDisplayName(n);
  api_.injectCSS = () => { noteUnsupported("injectCSS"); }; api_.clearCSS = () => {};
  api_.suppressErrors = (fn) => (...a) => { try { return fn(...a); } catch (e) {} };
  return api_;
}

function BdApi(name) { return buildApi(String(name)); }
Object.assign(BdApi, buildApi(null));

/* --- require() shim para plugins BD --- */
function bdRequire(name) {
  if (name === "react") return React;
  if (name === "react-native") return RN;
  const unsupported = ["electron", "fs", "path", "os", "child_process", "request", "https", "http", "net", "crypto", "zlib"];
  noteUnsupported("require('" + name + "')");
  if (unsupported.includes(name)) throw new Error(`require('${name}') não existe no Discord mobile (sem Node/Electron).`);
  throw new Error(`require('${name}') não suportado pela camada BD do CloudCord Plus.`);
}

/* --- parsing / compilação de plugins BD --- */
function parseMeta(src, fallbackName) {
  const meta = {};
  const block = src.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (block) {
    block[1].split("\n").forEach((line) => {
      const m = line.match(/@(\w+)\s+(.+?)\s*$/);
      if (m) meta[m[1]] = m[2].replace(/\*\/$/, "").trim();
    });
  } else {
    const legacy = src.match(/\/\/META(\{[\s\S]*?\})\*\//);
    if (legacy) { try { Object.assign(meta, JSON.parse(legacy[1])); } catch (e) {} }
  }
  meta.name = meta.name || fallbackName || "BDPlugin";
  meta.version = meta.version || "0.0.0";
  return meta;
}

function makeFunction(params, body) {
  try { return new Function(...params, body); }
  catch (e) { /* alguns builds do Hermes sem Function(): cai para eval */ }
  // eslint-disable-next-line no-eval
  return (0, eval)(`(function(${params.join(",")}){${body}\n})`);
}

function instantiate(meta, source) {
  const fn = makeFunction(["module", "exports", "require", "BdApi", "global", "window"], source + "\n//# sourceURL=bd-plugin/" + meta.name);
  const module_ = { exports: {} };
  fn(module_, module_.exports, bdRequire, BdApi, globalThis, globalThis);
  let Exp = module_.exports;
  if (Exp && Exp.default && Object.keys(Exp).length === 1) Exp = Exp.default;
  let inst;
  if (typeof Exp === "function") {
    try {
      inst = Exp.prototype && typeof Exp.prototype.start === "function" ? new Exp(meta) : Exp(meta);
    } catch (e) {
      throw new Error("Plugin provavelmente depende de ZeresPluginLibrary/BDFDB (não suportado): " + ((e && e.message) || e));
    }
    if (typeof inst === "function") throw new Error("Plugin depende de ZeresPluginLibrary/BDFDB (não suportado).");
  } else {
    inst = Exp;
  }
  if (!inst || (typeof inst.start !== "function" && typeof inst.stop !== "function")) {
    throw new Error("Plugin não exporta start()/stop().");
  }
  return inst;
}

function bdEnable(name) {
  const p = bdState.plugins.get(name);
  if (!p) throw new Error("Plugin BD não instalado: " + name);
  if (p.enabled) return;
  try {
    p.instance = p.instance || instantiate(p.meta, p.source);
    if (typeof p.instance.load === "function" && !p.loaded) { p.instance.load(); p.loaded = true; }
    p.instance.start && p.instance.start();
    p.enabled = true; p.error = null;
  } catch (e) {
    p.error = String((e && e.message) || e); p.enabled = false;
    try { Patcher.unpatchAll(name); } catch (_) {}
    throw e;
  }
}

function bdDisable(name) {
  const p = bdState.plugins.get(name);
  if (!p || !p.enabled) return;
  try { p.instance.stop && p.instance.stop(); } catch (e) { p.error = String((e && e.message) || e); }
  Patcher.unpatchAll(name);
  p.enabled = false;
}

function persistBd() {
  const out = {};
  bdState.plugins.forEach((p, n) => { out[n] = { source: p.source, url: p.url || null, enabled: !!p.enabled }; });
  setStore("bdPlugins", out);
}

function bdAdd(source, url, startNow = true) {
  const fallback = url ? decodeURIComponent(url.split("/").pop().replace(/\.plugin\.js$|\.js$/g, "")) : undefined;
  const meta = parseMeta(source, fallback);
  if (bdState.plugins.has(meta.name)) { bdDisable(meta.name); }
  bdState.plugins.set(meta.name, { meta, source, url: url || null, instance: null, enabled: false, error: null });
  let err = null;
  if (startNow) { try { bdEnable(meta.name); } catch (e) { err = e; } }
  persistBd();
  if (err) throw err;
  return meta;
}

function bdRemove(name) {
  bdDisable(name);
  bdState.plugins.delete(name);
  const d = JSON.parse(JSON.stringify(getStore("bdData", {}))); delete d[name]; setStore("bdData", d);
  persistBd();
}

async function bdFetchSource(url) {
  if (!/^https:\/\//i.test(url)) throw new Error("Use um link https:// (ex.: raw.githubusercontent.com ou gist raw).");
  const res = await globalThis.fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (text.length > 1.5 * 1024 * 1024) throw new Error("Arquivo grande demais (>1.5MB).");
  return text;
}

function confirmRun(name, url) {
  return new Promise((resolve) => {
    try {
      RN.Alert.alert("Instalar plugin BD?",
        `${name}\n${url || ""}\n\nPlugins BD rodam código com acesso total ao seu cliente e conta. Instale só de fontes em que você confia.`,
        [{ text: "Cancelar", style: "cancel", onPress: () => resolve(false) }, { text: "Instalar", onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) });
    } catch (e) { resolve(true); }
  });
}

async function bdInstallFromUrl(url) {
  const src = await bdFetchSource(url);
  const meta = parseMeta(src, decodeURIComponent(url.split("/").pop().replace(/\.plugin\.js$|\.js$/g, "")));
  if (!(await confirmRun(meta.name, url))) return null;
  return bdAdd(src, url, true);
}

function bdRestore() {
  const saved = getStore("bdPlugins", {});
  Object.keys(saved).forEach((name) => {
    try {
      const s = saved[name];
      const meta = parseMeta(s.source, name);
      bdState.plugins.set(name, { meta, source: s.source, url: s.url, instance: null, enabled: false, error: null });
      if (s.enabled) bdEnable(name);
    } catch (e) { log.error && log.error("[BD] falha ao restaurar " + name, e); }
  });
}

/* ------------------------------------------------------------------ *
 * FEATURES
 * ------------------------------------------------------------------ */
const FEATURES = []; // { id, name, desc, tier, group, commands?: [], start?(): cleanup }

function cmd(name, description, options, execute) {
  return {
    name, displayName: name, description, displayDescription: description,
    options: (options || []).map((o) => ({
      name: o.name, displayName: o.name, description: o.description, displayDescription: o.description,
      required: o.required !== false, type: 3,
    })),
    execute,
  };
}

function addCmdFeature({ id, name, desc, tier = "public", group, options, run, local = false }) {
  const textOpt = options || [{ name: "text", description: "Texto" }];
  FEATURES.push({
    id, name, desc, tier, group,
    commands: [cmd(id, desc, textOpt, (args, ctx) => {
      let out;
      try { out = run(argsToMap(args), ctx); } catch (e) { out = "Erro: " + ((e && e.message) || e); return localReply(ctx, out); }
      if (out === undefined || out === null) return undefined;
      return local ? localReply(ctx, out) : { content: clip(out) };
    })],
  });
}

/* --- transformadores de texto (enviam mensagem) --- */
const FW = (s) => [...s].map((c) => { const k = c.charCodeAt(0); return k === 32 ? "\u3000" : k > 32 && k < 127 ? String.fromCharCode(k + 0xFEE0) : c; }).join("");
const SMALLCAPS = { a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "ꜱ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ" };
const FLIP = { a: "ɐ", b: "q", c: "ɔ", d: "p", e: "ǝ", f: "ɟ", g: "ƃ", h: "ɥ", i: "ᴉ", j: "ɾ", k: "ʞ", l: "l", m: "ɯ", n: "u", o: "o", p: "d", q: "b", r: "ɹ", s: "s", t: "ʇ", u: "n", v: "ʌ", w: "ʍ", x: "x", y: "ʎ", z: "z", "?": "¿", "!": "¡", ".": "˙", ",": "'", "'": ",", "(": ")", ")": "(", "[": "]", "]": "[", "<": ">", ">": "<", _: "‾" };
const LEET = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7", b: "8", g: "9" };
const MORSE = { a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..", 0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----." };
const bubble = (c) => {
  const k = c.charCodeAt(0);
  if (k >= 97 && k <= 122) return String.fromCodePoint(0x24D0 + k - 97);
  if (k >= 65 && k <= 90) return String.fromCodePoint(0x24B6 + k - 65);
  if (k >= 49 && k <= 57) return String.fromCodePoint(0x2460 + k - 49);
  if (k === 48) return "\u24EA";
  return c;
};

const T = [
  ["uwu", "Fala fofa (r/l → w)", (t) => t.replace(/[rl]/g, "w").replace(/[RL]/g, "W").replace(/n([aeiou])/g, "ny$1").replace(/N([aeiou])/g, "Ny$1") + " uwu"],
  ["clap", "Palmas 👏 entre as palavras", (t) => t.trim().split(/\s+/).join(" 👏 ") + " 👏"],
  ["mock", "aLtErNaDo De MaIúScUlAs", (t) => [...t].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("")],
  ["reverse", "Texto de trás pra frente", (t) => [...t].reverse().join("")],
  ["spaced", "L e t r a s  e s p a ç a d a s", (t) => [...t].join(" ")],
  ["vapor", "ＶＡＰＯＲＷＡＶＥ", (t) => FW(t)],
  ["smallcaps", "ꜱᴍᴀʟʟ ᴄᴀᴘꜱ", (t) => [...t.toLowerCase()].map((c) => SMALLCAPS[c] || c).join("")],
  ["flip", "ʇǝxʇo de cabeça pra baixo", (t) => [...t.toLowerCase()].reverse().map((c) => FLIP[c] || c).join("")],
  ["leet", "1337 5p34k", (t) => [...t.toLowerCase()].map((c) => LEET[c] || c).join("")],
  ["bubble", "ⓑⓤⓑⓑⓛⓔ", (t) => [...t].map(bubble).join("")],
  ["rot13", "Cifra ROT13", (t) => t.replace(/[a-z]/gi, (c) => String.fromCharCode(((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)))],
  ["morse", "Texto → código Morse", (t) => [...t.toLowerCase()].map((c) => (c === " " ? "/" : MORSE[c] || "")).filter(Boolean).join(" ")],
  ["binary", "Texto → binário", (t) => [...t].map((c) => c.charCodeAt(0).toString(2).padStart(8, "0")).join(" ")],
  ["upper", "MAIÚSCULAS", (t) => t.toUpperCase()],
  ["lower", "minúsculas", (t) => t.toLowerCase()],
  ["title", "Title Case", (t) => t.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase())],
  ["slug", "texto-para-slug", (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")],
];
T.forEach(([id, desc, fn]) => addCmdFeature({ id, name: "/" + id, desc, group: "Texto", run: (a) => fn(String(a.text || "")) }));

[
  ["shrug", "¯\\_(ツ)_/¯", "¯\\\\\\_(ツ)\\_/¯"],
  ["tableflip", "(╯°□°)╯︵ ┻━┻", "(╯°□°)╯︵ ┻━┻"],
  ["unflip", "┬─┬ ノ( ゜-゜ノ)", "┬─┬ ノ( ゜-゜ノ)"],
  ["lenny", "( ͡° ͜ʖ ͡°)", "( ͡° ͜ʖ ͡°)"],
].forEach(([id, desc, face]) => addCmdFeature({
  id, name: "/" + id, desc: "Adiciona " + desc, group: "Kaomoji",
  options: [{ name: "text", description: "Texto antes (opcional)", required: false }],
  run: (a) => ((a.text ? a.text + " " : "") + face),
}));

/* --- base64 (UTF-8 seguro, sem depender de btoa/atob) --- */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function utf8Bytes(s) { const out = []; for (const ch of s) { let c = ch.codePointAt(0); if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return out; }
function utf8Decode(b) { let s = ""; for (let i = 0; i < b.length;) { const c = b[i++]; let cp; if (c < 0x80) cp = c; else if (c < 0xE0) cp = ((c & 31) << 6) | (b[i++] & 63); else if (c < 0xF0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); s += String.fromCodePoint(cp); } return s; }
function b64enc(s) { const b = utf8Bytes(s); let o = ""; for (let i = 0; i < b.length; i += 3) { const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0); o += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "="); } return o; }
function b64dec(s) { const clean = s.replace(/[^A-Za-z0-9+/]/g, ""); const b = []; for (let i = 0; i < clean.length; i += 4) { const n = [0, 1, 2, 3].map((k) => (clean[i + k] === undefined ? 0 : B64.indexOf(clean[i + k]))); const v = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3]; b.push((v >> 16) & 255); if (clean[i + 2] !== undefined) b.push((v >> 8) & 255); if (clean[i + 3] !== undefined) b.push(v & 255); } return utf8Decode(b); }
addCmdFeature({ id: "b64enc", name: "/b64enc", desc: "Texto → Base64", group: "Utilitários", local: true, run: (a) => b64enc(String(a.text)) });
addCmdFeature({ id: "b64dec", name: "/b64dec", desc: "Base64 → texto", group: "Utilitários", local: true, run: (a) => b64dec(String(a.text)) });

/* --- utilitários --- */
addCmdFeature({ id: "len", name: "/len", desc: "Conta caracteres e palavras", group: "Utilitários", local: true,
  run: (a) => { const t = String(a.text || ""); return `${[...t].length} caracteres • ${(t.trim() ? t.trim().split(/\s+/).length : 0)} palavras`; } });
addCmdFeature({ id: "uuid", name: "/uuid", desc: "Gera um UUID v4", group: "Utilitários", local: true, options: [],
  run: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }) });
addCmdFeature({ id: "coin", name: "/coin", desc: "Cara ou coroa", group: "Diversão", options: [],
  run: () => (Math.random() < 0.5 ? "🪙 Cara" : "🪙 Coroa") });
addCmdFeature({ id: "dice", name: "/dice", desc: "Rola dados (ex.: 2d6+3)", group: "Diversão",
  options: [{ name: "expr", description: "NdM(+K), ex.: 2d6+3", required: false }],
  run: (a) => {
    const m = String(a.expr || "1d6").replace(/\s/g, "").match(/^(\d{1,3})d(\d{1,4})([+-]\d+)?$/i);
    if (!m) throw new Error("Use o formato NdM ou NdM+K (ex.: 2d6+3)");
    const n = +m[1], s = +m[2], k = +(m[3] || 0), rolls = [];
    for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * s));
    return `🎲 ${a.expr || "1d6"}: [${rolls.join(", ")}]${k ? (k > 0 ? " +" : " ") + k : ""} = **${rolls.reduce((x, y) => x + y, 0) + k}**`;
  } });
addCmdFeature({ id: "choose", name: "/choose", desc: "Escolhe uma opção (separe por |)", group: "Diversão",
  options: [{ name: "options", description: "a | b | c" }],
  run: (a) => { const o = String(a.options).split("|").map((x) => x.trim()).filter(Boolean); if (o.length < 2) throw new Error("Passe 2+ opções separadas por |"); return "🤔 " + o[Math.floor(Math.random() * o.length)]; } });
addCmdFeature({ id: "eightball", name: "/eightball", desc: "Bola 8 mágica", group: "Diversão",
  options: [{ name: "question", description: "Sua pergunta" }],
  run: (a) => { const r = ["Sim.", "Com certeza!", "Provavelmente.", "Talvez.", "Pergunte de novo.", "Não conte com isso.", "Improvável.", "Não."]; return `🎱 ${a.question}\n**${r[Math.floor(Math.random() * r.length)]}**`; } });

/* --- calculadora (parser próprio, sem eval) --- */
function calc(expr) {
  const src = expr.replace(/\s+/g, "").replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/");
  let i = 0;
  const FN = { sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max };
  const CONST = { pi: Math.PI, e: Math.E };
  const peek = () => src[i];
  function num() {
    if (peek() === "(") { i++; const v = add(); if (src[i++] !== ")") throw new Error("Faltou )"); return v; }
    if (peek() === "-") { i++; return -pow(); }
    if (peek() === "+") { i++; return pow(); }
    const id = src.slice(i).match(/^[a-z]+/i);
    if (id) {
      const name = id[0].toLowerCase(); i += name.length;
      if (CONST[name] !== undefined && peek() !== "(") return CONST[name];
      if (!FN[name]) throw new Error("Função desconhecida: " + name);
      if (src[i++] !== "(") throw new Error("Faltou ( após " + name);
      const a = [add()]; while (src[i] === ";") { i++; a.push(add()); }
      if (src[i++] !== ")") throw new Error("Faltou )");
      return FN[name](...a);
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?(e[+-]?\d+)?/i);
    if (!m) throw new Error("Expressão inválida perto de: " + src.slice(i, i + 6));
    i += m[0].length; return parseFloat(m[0]);
  }
  function pow() { let b = num(); if (peek() === "^") { i++; b = Math.pow(b, pow()); } return b; }
  function mul() { let v = pow(); while (peek() === "*" || peek() === "/" || peek() === "%") { const o = src[i++]; const r = pow(); v = o === "*" ? v * r : o === "/" ? v / r : v % r; } return v; }
  function add() { let v = mul(); while (peek() === "+" || peek() === "-") { const o = src[i++]; const r = mul(); v = o === "+" ? v + r : v - r; } return v; }
  const out = add();
  if (i < src.length) throw new Error("Sobrou texto: " + src.slice(i, i + 6));
  return out;
}
addCmdFeature({ id: "calc", name: "/calc", desc: "Calculadora (+ - * / % ^, sqrt, sin, pi…)", group: "Utilitários", local: true,
  options: [{ name: "expr", description: "Ex.: (2+3)^2/4" }],
  run: (a) => `${a.expr} = **${+calc(String(a.expr)).toPrecision(12)}**` });

/* --- timestamp do Discord --- */
function parseWhen(s) {
  const rel = s.match(/^(?:in\s+|em\s+|\+)?((?:\d+\s*(?:s|m|h|d|w)\s*)+)$/i);
  if (rel) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
    let sec = 0; rel[1].replace(/(\d+)\s*(s|m|h|d|w)/gi, (_, n, u) => { sec += +n * mult[u.toLowerCase()]; });
    return Math.floor(Date.now() / 1000) + sec;
  }
  const t = Date.parse(s.replace(" ", "T"));
  if (isNaN(t)) throw new Error("Não entendi a data. Ex.: 2026-12-25 20:00 ou 'in 2h 30m'");
  return Math.floor(t / 1000);
}
addCmdFeature({ id: "ts", name: "/ts", desc: "Gera timestamp do Discord (<t:…>)", group: "Utilitários",
  options: [{ name: "when", description: "2026-12-25 20:00 | in 2h 30m" }, { name: "style", description: "t T d D f F R (padrão R)", required: false }],
  run: (a) => { const st = ["t", "T", "d", "D", "f", "F", "R"].includes(a.style) ? a.style : "R"; return `<t:${parseWhen(String(a.when))}:${st}>`; } });

addCmdFeature({ id: "snowflake", name: "/snowflake", desc: "Data de criação de um ID do Discord", group: "Utilitários", local: true,
  options: [{ name: "id", description: "ID (snowflake)" }],
  run: (a) => { const id = String(a.id).trim(); if (!/^\d{15,22}$/.test(id)) throw new Error("ID inválido"); const ms = Number((BigInt(id) >> 22n) + 1420070400000n); return `${id} → <t:${Math.floor(ms / 1000)}:F> (${new Date(ms).toISOString()})`; } });

/* --- Camada BD: comandos --- */
FEATURES.push({
  id: "bd", name: "Compatibilidade BetterDiscord", desc: "/bd-install, /bd-list, /bd-toggle, /bd-remove + BdApi", tier: "public", group: "BD",
  commands: [
    cmd("bd-install", "Instala plugin BD por link https (raw)", [{ name: "url", description: "Link https do .plugin.js" }], (args, ctx) => {
      const a = argsToMap(args);
      bdInstallFromUrl(String(a.url).trim())
        .then((meta) => localReply(ctx, meta ? `✅ BD plugin **${meta.name}** v${meta.version} instalado.` : "Instalação cancelada."))
        .catch((e) => localReply(ctx, "❌ Falha ao instalar: " + ((e && e.message) || e)));
    }),
    cmd("bd-list", "Lista plugins BD instalados", [], (args, ctx) => {
      const rows = [...bdState.plugins.values()].map((p) => `${p.enabled ? "🟢" : "⚪"} **${p.meta.name}** v${p.meta.version}${p.error ? " ⚠️ " + p.error : ""}`);
      return localReply(ctx, rows.length ? rows.join("\n") : "Nenhum plugin BD instalado.");
    }),
    cmd("bd-toggle", "Liga/desliga um plugin BD", [{ name: "name", description: "Nome do plugin" }], (args, ctx) => {
      const n = String(argsToMap(args).name);
      const p = bdState.plugins.get(n);
      if (!p) return localReply(ctx, "Plugin não encontrado: " + n);
      try { p.enabled ? bdDisable(n) : bdEnable(n); persistBd(); return localReply(ctx, `${p.enabled ? "🟢 ligado" : "⚪ desligado"}: ${n}`); }
      catch (e) { return localReply(ctx, "❌ " + ((e && e.message) || e)); }
    }),
    cmd("bd-remove", "Remove um plugin BD", [{ name: "name", description: "Nome do plugin" }], (args, ctx) => {
      const n = String(argsToMap(args).name);
      if (!bdState.plugins.has(n)) return localReply(ctx, "Plugin não encontrado: " + n);
      bdRemove(n); return localReply(ctx, "🗑️ Removido: " + n);
    }),
  ],
});

/* --- Features restritas (tester / owner) --- */
FEATURES.push({
  id: "lab", name: "Plus Lab (inspetor)", desc: "/plus-modules, /plus-stores, /plus-bd-debug", tier: "tester", group: "Restrito",
  commands: [
    cmd("plus-modules", "Busca props exportadas nos módulos Metro", [{ name: "query", description: "Trecho do nome da prop" }], (args, ctx) => {
      const q = String(argsToMap(args).query).toLowerCase();
      const hits = new Set(); let n = 0;
      for (const [, exp] of metroExports()) {
        n++;
        try { Object.keys(exp || {}).forEach((k) => { if (k.toLowerCase().includes(q) && hits.size < 40) hits.add(k); }); } catch (e) {}
      }
      return localReply(ctx, `Módulos inicializados: ${n}\nProps contendo "${q}" (${hits.size}):\n` + ([...hits].join(", ") || "—"));
    }),
    cmd("plus-stores", "Lista Flux stores visíveis", [], (args, ctx) => {
      const names = new Set();
      for (const [, exp] of metroExports()) { try { if (exp && typeof exp.getName === "function" && exp._dispatchToken !== undefined) names.add(exp.getName()); } catch (e) {} }
      return localReply(ctx, `Stores (${names.size}):\n` + [...names].sort().join(", "));
    }),
    cmd("plus-bd-debug", "Estado da camada BD", [], (args, ctx) => {
      const lines = [`Plugins BD: ${bdState.plugins.size}`, `Patches ativos: ${[...bdState.patches.values()].reduce((s, a) => s + a.length, 0)}`, `APIs não suportadas já chamadas: ${[...bdState.unsupported].join(", ") || "nenhuma"}`];
      bdState.plugins.forEach((p, n) => { if (p.error) lines.push(`⚠️ ${n}: ${p.error}`); });
      return localReply(ctx, lines.join("\n"));
    }),
  ],
});
FEATURES.push({
  id: "owner-tools", name: "Ferramentas do dono", desc: "/plus-access, /plus-reset-bd", tier: "owner", group: "Restrito",
  commands: [
    cmd("plus-access", "Mostra seu nível de acesso", [], (args, ctx) => {
      const u = currentUser();
      return localReply(ctx, `Usuário: ${u ? u.username : "?"} (${u ? u.id : "?"})\nNíveis: ${[...currentTiers()].join(", ")}`);
    }),
    cmd("plus-reset-bd", "Apaga TODOS os plugins/dados BD", [], (args, ctx) => {
      [...bdState.plugins.keys()].forEach((n) => { try { bdDisable(n); } catch (e) {} });
      bdState.plugins.clear(); setStore("bdPlugins", {}); setStore("bdData", {});
      return localReply(ctx, "🧹 BD resetado.");
    }),
  ],
});

/* ------------------------------------------------------------------ *
 * Motor de features (liga/desliga conforme acesso + preferências)
 * ------------------------------------------------------------------ */
const active = new Map(); // id -> [unregister]
const canUse = (feature, tiers) => feature.tier === "public" || tiers.has(feature.tier);
const isOff = (id) => !!(getStore("disabledFeatures", {})[id]);

function startFeature(f) {
  if (active.has(f.id)) return;
  const un = [];
  (f.commands || []).forEach((c) => { try { un.push(api.commands.registerCommand(c)); } catch (e) { log.error && log.error("[Plus] comando falhou: " + c.name, e); } });
  try { if (f.start) { const r = f.start(); if (typeof r === "function") un.push(r); } } catch (e) { log.error && log.error("[Plus] feature falhou: " + f.id, e); }
  active.set(f.id, un);
}
function stopFeature(id) {
  (active.get(id) || []).forEach((u) => { try { u(); } catch (e) {} });
  active.delete(id);
}
function refreshFeatures() {
  const tiers = currentTiers();
  FEATURES.forEach((f) => { (canUse(f, tiers) && !isOff(f.id)) ? startFeature(f) : stopFeature(f.id); });
}

function setFeatureEnabled(id, on) {
  const d = { ...getStore("disabledFeatures", {}) };
  if (on) delete d[id]; else d[id] = true;
  setStore("disabledFeatures", d);
  refreshFeatures();
}

/* ------------------------------------------------------------------ *
 * Tela de configurações
 * ------------------------------------------------------------------ */
function SettingsComponent() {
  if (!React || !RN) return null;
  const h = React.createElement;
  const [, force] = React.useState(0);
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const rerender = () => force((x) => x + 1);
  const dark = (RN.useColorScheme && RN.useColorScheme()) !== "light";
  const fg = dark ? "#FFFFFF" : "#111111", muted = dark ? "#B5BAC1" : "#555555";
  const tiers = currentTiers();
  const S = {
    h: { color: fg, fontSize: 18, fontWeight: "700", marginTop: 18, marginBottom: 6 },
    t: { color: fg, fontSize: 15 }, m: { color: muted, fontSize: 12 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
    input: { color: fg, borderWidth: 1, borderColor: muted, borderRadius: 8, padding: 8, marginVertical: 6 },
    btn: { backgroundColor: "#5865F2", padding: 10, borderRadius: 8, alignItems: "center", opacity: busy ? 0.5 : 1 },
  };
  const features = FEATURES.filter((f) => canUse(f, tiers));
  const groups = {}; features.forEach((f) => { (groups[f.group] = groups[f.group] || []).push(f); });

  const install = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try { const meta = await bdInstallFromUrl(url.trim()); if (meta) { toast(`BD: ${meta.name} instalado`); setUrl(""); } }
    catch (e) { UI.alert("Falha ao instalar", String((e && e.message) || e)); }
    setBusy(false); rerender();
  };

  return h(RN.ScrollView, { style: { padding: 16 } },
    h(RN.Text, { style: S.h }, "CloudCord Plus"),
    h(RN.Text, { style: S.m }, `v1.0.0 • nível: ${[...tiers].join(", ")} • features ativas: ${active.size}`),

    h(RN.Text, { style: S.h }, "Plugins BetterDiscord"),
    h(RN.Text, { style: S.m }, "Plugins que usam DOM/CSS/Electron/ZeresPluginLibrary não funcionam no mobile."),
    h(RN.TextInput, { style: S.input, value: url, onChangeText: setUrl, placeholder: "https://…/MeuPlugin.plugin.js", placeholderTextColor: muted, autoCapitalize: "none", autoCorrect: false }),
    h(RN.TouchableOpacity, { style: S.btn, onPress: install }, h(RN.Text, { style: { color: "#fff", fontWeight: "700" } }, busy ? "Instalando…" : "Instalar plugin BD")),
    ...[...bdState.plugins.values()].map((p) => h(RN.View, { key: "bd-" + p.meta.name, style: S.row },
      h(RN.View, { style: { flex: 1, paddingRight: 8 } },
        h(RN.Text, { style: S.t }, `${p.meta.name} v${p.meta.version}`),
        h(RN.Text, { style: S.m }, p.error ? "⚠️ " + p.error : (p.meta.description || p.meta.author || ""))),
      h(RN.Switch, { value: !!p.enabled, onValueChange: (v) => { try { v ? bdEnable(p.meta.name) : bdDisable(p.meta.name); persistBd(); } catch (e) { UI.alert("Erro", String((e && e.message) || e)); } rerender(); } }),
      h(RN.TouchableOpacity, { onPress: () => { bdRemove(p.meta.name); rerender(); }, style: { marginLeft: 10 } }, h(RN.Text, { style: { color: "#ED4245" } }, "Remover")))),

    ...Object.keys(groups).flatMap((g) => [
      h(RN.Text, { key: "g-" + g, style: S.h }, g),
      ...groups[g].map((f) => h(RN.View, { key: f.id, style: S.row },
        h(RN.View, { style: { flex: 1, paddingRight: 8 } }, h(RN.Text, { style: S.t }, f.name), h(RN.Text, { style: S.m }, f.desc)),
        h(RN.Switch, { value: !isOff(f.id), onValueChange: (v) => { setFeatureEnabled(f.id, v); rerender(); } }))),
    ]),
    h(RN.View, { style: { height: 40 } }));
}

/* ------------------------------------------------------------------ *
 * Ciclo de vida
 * ------------------------------------------------------------------ */
const plugin = definePlugin({
  start() {
    try { bdRestore(); } catch (e) { log.error && log.error("[Plus] BD restore", e); }
    refreshFeatures();
    // o usuário só existe depois do login/READY: reavalia o acesso nesses eventos
    try {
      const FD = common.FluxDispatcher;
      if (FD && FD.subscribe) {
        const cb = () => refreshFeatures();
        ["CONNECTION_OPEN", "LOGIN_SUCCESS", "CURRENT_USER_UPDATE"].forEach((ev) => { FD.subscribe(ev, cb); onDispose(() => FD.unsubscribe(ev, cb)); });
      }
    } catch (e) {}
    globalThis.BdApi = globalThis.BdApi || BdApi; // alguns plugins leem o global
    this._ownsBdGlobal = globalThis.BdApi === BdApi;
  },
  stop() {
    [...bdState.plugins.keys()].forEach((n) => { try { const p = bdState.plugins.get(n); const was = p.enabled; bdDisable(n); p.enabled = was; } catch (e) {} });
    [...active.keys()].forEach(stopFeature);
    while (disposers.length) { try { disposers.pop()(); } catch (e) {} }
    if (this._ownsBdGlobal) { try { delete globalThis.BdApi; } catch (e) {} }
  },
  SettingsComponent,
});
