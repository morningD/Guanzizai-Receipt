import { useLayoutEffect, useRef } from "react";

export function useCardMasonry(enabled: boolean) {
  const boardRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!enabled || !board || typeof ResizeObserver === "undefined") return;

    board.dataset.masonry = "";
    const { gridAutoRows, columnGap } = getComputedStyle(board);
    const rowHeight = Number.parseFloat(gridAutoRows);
    const spacing = Number.parseFloat(columnGap);
    // Reserve each card's measured height and one gutter in the grid.
    const fitCard = (card: HTMLElement, height: number) => {
      card.style.gridRowEnd = `span ${Math.ceil((height + spacing) / rowHeight)}`;
    };
    const resize = new ResizeObserver((entries) => {
      for (const { target, borderBoxSize } of entries) {
        const card = target as HTMLElement;
        fitCard(card, borderBoxSize?.[0]?.blockSize ?? card.offsetHeight);
      }
    });
    const cards = () => board.querySelectorAll<HTMLElement>(":scope > :is(.line-card, .error-boundary, .empty-state)");
    const observeCards = () => {
      resize.disconnect();
      const measured = Array.from(cards(), (card) => ({ card, height: card.offsetHeight }));
      for (const { card, height } of measured) {
        fitCard(card, height);
        resize.observe(card, { box: "border-box" });
      }
    };
    observeCards();
    const changes = new MutationObserver(observeCards);
    changes.observe(board, { childList: true });

    return () => {
      changes.disconnect();
      resize.disconnect();
      delete board.dataset.masonry;
      for (const card of cards()) card.style.removeProperty("grid-row-end");
    };
  }, [enabled]);

  return boardRef;
}
