import { expect, test } from "bun:test";
import { Reservations } from "../src/reservation";

test("overlapping window reservations refuse without minting a second action", () => {
  const reservations = new Reservations();
  const first = reservations.reserve("desk", 2, "42:7");
  expect(first).toMatchObject({ requestId: "2-1", target: "42:7" });
  expect(reservations.reserve("desk", 2, "42:7")).toBe("window_busy");
  expect(reservations.pending("desk")).toHaveLength(1);
});

test("different windows and machines have independent reservations", () => {
  const reservations = new Reservations();
  expect(reservations.reserve("desk", 2, "42:7")).toMatchObject({ requestId: "2-1" });
  expect(reservations.reserve("desk", 2, "42:8")).toMatchObject({ requestId: "2-2" });
  expect(reservations.reserve("other", 1, "42:7")).toMatchObject({ requestId: "1-1" });
  expect(reservations.reserve("desk", 2, "*")).toBe("window_busy");
});

test("wildcard blocks targeted input until its receipt releases the reservation", () => {
  const reservations = new Reservations();
  expect(reservations.reserve("desk", 2, "*")).toMatchObject({ requestId: "2-1" });
  expect(reservations.reserve("desk", 2, "42:7")).toBe("window_busy");
  reservations.release("desk", "2-1");
  expect(reservations.reserve("desk", 2, "42:7")).toMatchObject({ requestId: "2-3" });
  expect(reservations.pending("desk")).toHaveLength(1);
});

test("the same request ID on two machines retains both reservations independently", () => {
  const reservations = new Reservations();
  expect(reservations.reserve("desk", 1, "42:7")).toMatchObject({ requestId: "1-1" });
  expect(reservations.reserve("other", 1, "42:7")).toMatchObject({ requestId: "1-1" });
  expect(reservations.pending("desk")).toHaveLength(1);
  expect(reservations.pending("other")).toHaveLength(1);
  reservations.release("other", "1-1");
  expect(reservations.reserve("desk", 1, "42:7")).toBe("window_busy");
  expect(reservations.pending("desk")).toHaveLength(1);
  expect(reservations.pending("other")).toHaveLength(0);
});

test("an action id is captured before the reservation starts", () => {
  const reservations = new Reservations();
  const requestId = reservations.mint("desk", 3);
  expect(requestId).toBe("3-1");
  expect(reservations.pending("desk")).toEqual([]);
  expect(reservations.reserve("desk", 3, "42:7", requestId)).toMatchObject({ requestId });
  expect(reservations.mint("desk", 3)).toBe("3-2");
});
