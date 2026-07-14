import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";

/** 滑块再短也不能短过这个，否则捏不住。 */
const MIN_THUMB = 30;

interface Metrics {
  /** 轨道有多高。 */
  rail: number;
  /** 滑块该多高。 */
  thumb: number;
  /** 滑块顶端在轨道里的位置。 */
  top: number;
  /** 内容根本装得下——滑块占满整条轨，但仍旧在那儿。 */
  full: boolean;
}

/**
 * 自绘滚动轨。
 *
 * 原生滚动条在这套界面里是外来物：圆角、渐变、还会跟着系统主题变，压根按不住。
 * 更要命的是——**内容不溢出时它根本不画滑块**，轨道就空在那儿。所以整条自己画：
 * 装得下的时候滑块占满全轨，照样杵在那里，宽度和刻度都归我们管。
 *
 * 度量靠 ResizeObserver（容器变大变小）加 MutationObserver（内容增删）。
 * 光听 scroll 是不够的：搜索一筛，内容高度当场就变了，可 scroll 事件不会响。
 */
export function ScrollRail({ scroller }: { scroller: RefObject<HTMLElement | null> }): ReactElement {
  const railRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics>({ rail: 0, thumb: 0, top: 0, full: true });
  const drag = useRef<{ pointer: number; grabY: number; startTop: number }>(undefined);

  const measure = useCallback(() => {
    const node = scroller.current;
    const rail = railRef.current?.clientHeight ?? 0;
    if (!node || rail === 0) return;
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow <= 1) {
      setMetrics({ rail, thumb: rail, top: 0, full: true });
      return;
    }
    const thumb = Math.max(MIN_THUMB, (node.clientHeight / node.scrollHeight) * rail);
    const top = (node.scrollTop / overflow) * (rail - thumb);
    setMetrics({ rail, thumb, top, full: false });
  }, [scroller]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    if (railRef.current) resize.observe(railRef.current);
    // 筛选一变，内容高度当场就变，但 scroll 事件不会响
    const mutate = new MutationObserver(measure);
    mutate.observe(node, { childList: true, subtree: true });
    return () => {
      node.removeEventListener("scroll", measure);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [measure, scroller]);

  /** 把滑块顶端的像素位置换算回 scrollTop。 */
  const scrollTo = useCallback((thumbTop: number) => {
    const node = scroller.current;
    if (!node || metrics.full) return;
    const travel = metrics.rail - metrics.thumb;
    if (travel <= 0) return;
    const ratio = Math.min(1, Math.max(0, thumbTop / travel));
    node.scrollTop = ratio * (node.scrollHeight - node.clientHeight);
  }, [metrics, scroller]);

  useEffect(() => {
    if (!drag.current) return undefined;
    function onMove(event: PointerEvent): void {
      if (!drag.current || event.pointerId !== drag.current.pointer) return;
      scrollTo(drag.current.startTop + (event.clientY - drag.current.grabY));
    }
    function onUp(): void {
      drag.current = undefined;
      document.body.classList.remove("rail-dragging");
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [scrollTo, metrics]);

  return (
    <div
      className={`rail ${metrics.full ? "rail-full" : ""}`}
      ref={railRef}
      aria-hidden="true"
      onPointerDown={(event) => {
        // 点空轨：滑块中心跳到点的地方
        if (event.target !== railRef.current || metrics.full) return;
        const rect = railRef.current.getBoundingClientRect();
        scrollTo(event.clientY - rect.top - metrics.thumb / 2);
      }}
    >
      <div
        className="rail-thumb"
        style={{ height: `${metrics.thumb}px`, transform: `translateY(${metrics.top}px)` }}
        onPointerDown={(event) => {
          if (metrics.full) return;
          event.preventDefault();
          drag.current = { pointer: event.pointerId, grabY: event.clientY, startTop: metrics.top };
          document.body.classList.add("rail-dragging");
          // 触发一次重挂，把 pointermove 的监听装上
          setMetrics((current) => ({ ...current }));
        }}
      >
        {/* 滑块上的两道刻痕。是抓手，也是这套仪表语言的一部分。 */}
        <i />
        <i />
      </div>
    </div>
  );
}
