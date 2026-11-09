import { describe, expect, test } from "vitest";

import { memoryLevel } from "./memory";

describe("memoryLevel", () => {
  test("is ok below 70%", () => {
    expect(memoryLevel(500, 1024)).toBe("ok");
    expect(memoryLevel(0, 1024)).toBe("ok");
  });

  test("warns from 70% to 85%", () => {
    expect(memoryLevel(717, 1024)).toBe("warn");
    expect(memoryLevel(870, 1024)).toBe("warn");
  });

  test("is critical at 85% and above", () => {
    expect(memoryLevel(871, 1024)).toBe("critical");
    expect(memoryLevel(1023, 1024)).toBe("critical");
  });

  test("treats an unknown limit as healthy", () => {
    expect(memoryLevel(900, 0)).toBe("ok");
  });
});
