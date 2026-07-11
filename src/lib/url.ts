/**
 * 规范化 HTTP(S) URL，同时保留路径大小写和查询参数值。
 *
 * @param value 已通过表单 URL 校验的字符串。
 * @returns 主机名、默认端口和 pathname 尾斜杠已规范化的 URL。
 */
export function normalizeHttpUrl(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.hash = "";
  const normalized = url.toString();
  return url.pathname === "/" && !url.search
    ? normalized.replace(/\/$/, "")
    : normalized;
}
