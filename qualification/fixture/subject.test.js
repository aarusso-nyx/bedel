import { test, expect } from "vitest";
import { sign } from "./subject.js";
test("positive and boundary values", () => {
  expect(sign(1)).toBe("positive");
  expect(sign(0)).toBe("other");
  expect(sign(-1)).toBe("other");
});
