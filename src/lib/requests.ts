import type { ActiveRequest } from "../types";

/**
 * 把「只带活跃请求的增量通知」合进现有列表。
 *
 * 传输途中每 200ms 一次的进度通知，原本推的是整部历史（最多 2000 条）。那部分根本
 * 没变，白白序列化过来——主进程实测吃掉了网关转发路径八成六的 CPU。现在只推还在跑
 * 的那几条，这里按 id 就地换掉。
 *
 * 活跃请求在 start() 时就已经由一次全量通知放进列表了，所以按 id 一定找得到；
 * 找不到的（列表还没同步上）就忽略，下一次全量通知会带上它。
 */
export function mergeActiveRequests(
  current: ActiveRequest[],
  patch: ActiveRequest[],
): ActiveRequest[] {
  if (patch.length === 0) return current;
  const fresh = new Map(patch.map((request) => [request.id, request]));
  return current.map((request) => fresh.get(request.id) ?? request);
}
