/**
 * 将 ISO 时间转换为适合状态栏展示的相对时间。
 *
 * @param value ISO 时间；缺失时表示从未发生。
 * @returns 中文相对时间文本。
 */
export function relativeTime(value?: string): string {
  if (!value) return "从未";

  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 将 ISO 时间格式化为本地月日和时分，供历史记录使用。
 *
 * @param value 有效的 ISO 时间。
 * @returns 本地化后的日期时间文本。
 */
export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * 将未知异常转换为可展示文本，避免界面直接依赖异常类型。
 *
 * @param error 捕获到的任意异常值。
 * @returns 可供提示条展示的错误信息。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 将 Token 数量压缩为 K/M 短格式。
 *
 * @param value Token 数；缺失或非数字时返回 "--"。
 * @returns 例如 "12.4K"、"1.05M"。
 */
export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return Math.round(value).toLocaleString();
}

/**
 * 将毫秒格式化为 ms/s 时长文本。
 *
 * @param milliseconds 时长；缺失时返回 "--"。
 * @returns 例如 "642 ms"、"4.98 s"。
 */
export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

