import { PointerSensor, type PointerSensorOptions } from "@dnd-kit/core";
import type { PointerEvent } from "react";
import { DRAG_HANDLE_SELECTOR, pointerDownStartsCardDrag } from "@/lib/board/gestures";

function targetIsDragHandle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(DRAG_HANDLE_SELECTOR) !== null;
}

export class CardPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: event }: PointerEvent, { onActivation }: PointerSensorOptions) => {
        if (
          !pointerDownStartsCardDrag({
            isPrimary: event.isPrimary,
            button: event.button,
            pointerType: event.pointerType,
            fromDragHandle: targetIsDragHandle(event.target),
          })
        ) {
          return false;
        }
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
