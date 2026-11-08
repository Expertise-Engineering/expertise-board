import assert from "node:assert/strict";
import test from "node:test";
import { CARD_DRAG_DISTANCE_PX, createDragClickGate, pointerDownStartsCardDrag } from "./gestures.ts";

test("a mouse can drag from the card, and a finger only drags from the Move handle", () => {
  assert.equal(CARD_DRAG_DISTANCE_PX, 8);
  const mouse = { isPrimary: true, button: 0, pointerType: "mouse", fromDragHandle: false };
  assert.equal(pointerDownStartsCardDrag(mouse), true);
  assert.equal(pointerDownStartsCardDrag({ ...mouse, fromDragHandle: true }), true);
  assert.equal(pointerDownStartsCardDrag({ ...mouse, pointerType: "pen" }), true);
  assert.equal(pointerDownStartsCardDrag({ ...mouse, pointerType: "" }), true);

  const touch = { isPrimary: true, button: 0, pointerType: "touch", fromDragHandle: false };
  assert.equal(pointerDownStartsCardDrag(touch), false);
  assert.equal(pointerDownStartsCardDrag({ ...touch, fromDragHandle: true }), true);
  assert.equal(pointerDownStartsCardDrag({ ...touch, fromDragHandle: true, isPrimary: false }), false);
  assert.equal(pointerDownStartsCardDrag({ ...mouse, button: 2 }), false);
});

test("a click opens a card, and the click after a drag does not", () => {
  const queued: Array<() => void> = [];
  const gate = createDragClickGate((run) => {
    queued.push(run);
    return () => {
      const index = queued.indexOf(run);
      if (index >= 0) queued.splice(index, 1);
    };
  });

  assert.equal(gate.shouldOpenFromClick(), true);

  gate.onDragStart();
  gate.onDragFinished();
  assert.equal(gate.shouldOpenFromClick(), false);
  assert.equal(queued.length, 1);

  queued.shift()?.();
  assert.equal(gate.shouldOpenFromClick(), true);
});

test("a cancelled drag does not block the next tap", () => {
  const queued: Array<() => void> = [];
  const gate = createDragClickGate((run) => {
    queued.push(run);
    return () => {
      const index = queued.indexOf(run);
      if (index >= 0) queued.splice(index, 1);
    };
  });

  gate.onDragStart();
  gate.onDragFinished();
  assert.equal(gate.shouldOpenFromClick(), false, "the click that follows the cancelled drag is swallowed");

  queued.shift()?.();
  assert.equal(gate.shouldOpenFromClick(), true, "the next tap opens the card");
  gate.dispose();
});

test("a drag that starts before the previous click clears stays closed", () => {
  const queued: Array<() => void> = [];
  const gate = createDragClickGate((run) => {
    queued.push(run);
    return () => {
      const index = queued.indexOf(run);
      if (index >= 0) queued.splice(index, 1);
    };
  });

  gate.onDragStart();
  gate.onDragFinished();
  const stale = queued[0];
  assert.ok(stale);
  gate.onDragStart();
  stale();
  assert.equal(gate.shouldOpenFromClick(), false);
  gate.dispose();
});

test("the default scheduler clears the drag click on the next turn", async () => {
  const gate = createDragClickGate();
  gate.onDragStart();
  gate.onDragFinished();
  assert.equal(gate.shouldOpenFromClick(), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gate.shouldOpenFromClick(), true);
  gate.dispose();
});
