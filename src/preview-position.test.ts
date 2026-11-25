import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculatePreviewPosition } from "./preview-position";

describe("材料悬浮预览定位", () => {
  it("在左侧材料行右侧展开，并保持在视口内", () => {
    expect(calculatePreviewPosition({ left: 327, right: 368, top: 265 }, { width: 1200, height: 698 })).toEqual({
      left: 386,
      top: 257,
      width: 360,
      height: 320,
    });
  });

  it("靠近右边缘时改为向左展开", () => {
    const preview = calculatePreviewPosition({ left: 1100, right: 1140, top: 300 }, { width: 1200, height: 700 });
    expect(preview.left).toBe(722);
    expect(preview.left + preview.width).toBeLessThanOrEqual(1184);
  });

  it("小视口不会生成横向溢出的预览尺寸", () => {
    const preview = calculatePreviewPosition({ left: 300, right: 340, top: 500 }, { width: 360, height: 640 });
    expect(preview).toEqual({ left: 16, top: 304, width: 328, height: 320 });
  });

  it("排序行不应创建会改变 fixed 浮层定位参照的 transform 上下文", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.requirement-row--prioritized\s*\{[^}]*will-change\s*:\s*transform/);
  });
});
