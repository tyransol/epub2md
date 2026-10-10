/**
 * XML / DOM 小工具（EPUB 解析与书目检索共用）
 *
 * converter 要解析 OPF/NCX/XHTML，lookup 还要解析 NDL 返回的 RSS，
 * 两边都需要同一套「按 localName 递归找元素」的逻辑，抽到此处避免两套实现漂移。
 *
 * 浏览器用原生 DOMParser；Node（测试）由调用方注入 globalThis.DOMParser（如 linkedom）。
 */

/** 去不换行空格并 trim。 */
export const clean = (t) => (t || '').replace(/\u00a0/g, ' ').trim();

/** 取节点文本并清洗。 */
export const text = (n) => clean(n && n.textContent);

/** 以 XML 方式解析字符串。 */
export function xmlParse(source) {
  const Ctor = globalThis.DOMParser;
  if (!Ctor) throw new Error('当前环境没有 DOMParser（浏览器自带；Node 请注入 linkedom）');
  return new Ctor().parseFromString(source, 'application/xml');
}

/** 递归收集同名元素（忽略命名空间前缀）。 */
export function all(doc, name) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 1 && (n.localName === name || (n.localName || '').endsWith(':' + name))) out.push(n);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(doc);
  return out;
}

/** 取第一个同名元素。 */
export const find = (doc, name) => all(doc, name)[0];