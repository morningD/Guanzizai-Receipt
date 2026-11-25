export type PreviewTriggerRect = {
  left: number;
  right: number;
  top: number;
};

export type PreviewViewport = {
  width: number;
  height: number;
};

export function calculatePreviewPosition(
  trigger: PreviewTriggerRect,
  viewport: PreviewViewport,
) {
  const gutter = 18;
  const edge = 16;
  const width = Math.min(360, viewport.width - edge * 2);
  const height = Math.min(320, viewport.height - edge * 2);
  const preferredLeft = trigger.right + gutter + width <= viewport.width - edge
    ? trigger.right + gutter
    : trigger.left - width - gutter;

  return {
    left: Math.max(edge, Math.min(preferredLeft, viewport.width - width - edge)),
    top: Math.max(edge, Math.min(trigger.top - 8, viewport.height - height - edge)),
    width,
    height,
  };
}
