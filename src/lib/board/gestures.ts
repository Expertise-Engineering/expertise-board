/**
 * Phone taps were lost because a pointer drag sensor armed on the whole card.
 * A finger almost always moves a few pixels, the horizontal board cancels that
 * pointer, and the click never opens the card. Touch drags start only on the
 * Move handle. A mouse can still drag from anywhere on the card.
 */
export const CARD_DRAG_DISTANCE_PX = 8;

export const DRAG_HANDLE_SELECTOR = "[data-drag-handle]";

export function pointerDownStartsCardDrag(input: {
  isPrimary: boolean;
  button: number;
  pointerType: string;
  fromDragHandle: boolean;
}): boolean {
  if (!input.isPrimary || input.button !== 0) return false;
  if (input.pointerType === "touch") return input.fromDragHandle;
  return true;
}

type Schedule = (run: () => void) => () => void;

function scheduleOnNextTurn(run: () => void): () => void {
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
}

export type DragClickGate = {
  onDragStart: () => void;
  onDragFinished: () => void;
  shouldOpenFromClick: () => boolean;
  dispose: () => void;
};

/**
 * A drag suppresses the click the browser fires when the pointer goes up.
 * That includes a drag the browser cancels. The suppression has to clear,
 * or the next tap never opens the card.
 */
export function createDragClickGate(schedule: Schedule = scheduleOnNextTurn): DragClickGate {
  let blockClick = false;
  let generation = 0;
  let cancelTimer: (() => void) | null = null;

  function invalidate() {
    generation += 1;
    cancelTimer?.();
    cancelTimer = null;
  }

  return {
    onDragStart() {
      invalidate();
      blockClick = true;
    },
    onDragFinished() {
      invalidate();
      blockClick = true;
      const scheduledGeneration = generation;
      cancelTimer = schedule(() => {
        if (generation !== scheduledGeneration) return;
        blockClick = false;
        cancelTimer = null;
      });
    },
    shouldOpenFromClick() {
      return !blockClick;
    },
    dispose() {
      invalidate();
      blockClick = false;
    },
  };
}
