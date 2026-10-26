import { describe, expect, it } from "vitest";
import {
  asNonArrayRecord,
  asNullableRecord,
  asOptionalRecord,
  filterStringRecord,
  isStringArray,
  isStringRecord,
  omitUndefinedFields,
} from "./record-coerce.js";

describe("record-coerce", () => {
  const sparse: string[] = [];
  sparse.length = 2;
  it.each([
    [[], true],
    [["", "  ", "same", "same"], true],
    [sparse, true],
    [["ok", 2], false],
    [["ok", undefined], false],
    [null, false],
    [{ 0: "ok" }, false],
    ["ok", false],
  ])("accepts only all-string arrays without normalizing entries %#", (value, expected) => {
    expect(isStringArray(value)).toBe(expected);
  });

  it("removes only undefined projection fields in place without traversing nested records", () => {
    const nested = { untouched: undefined };
    const fields = { missing: undefined, empty: "", zero: 0, disabled: false, nil: null, nested };
    expect(omitUndefinedFields(fields)).toBe(fields);
    expect(fields).toStrictEqual({
      empty: "",
      zero: 0,
      disabled: false,
      nil: null,
      nested: { untouched: undefined },
    });
    expect(fields.nested).toBe(nested);
  });

  it.each([
    [null, undefined, null],
    [[{ ok: true }], undefined, null],
    [{ ok: true }, { ok: true }, { ok: true }],
  ])("coerces optional/nullable records: %j", (value, optional, nullable) => {
    expect(asOptionalRecord(value)).toEqual(optional);
    expect(asNullableRecord(value)).toEqual(nullable);
  });

  it("preserves accepted record identity and returns fresh ordinary fallbacks", () => {
    class ExampleRecord {
      marker = true;
    }
    const record = Object.create(null) as Record<string, unknown>;
    const firstFallback = asNonArrayRecord(null);
    const secondFallback = asNonArrayRecord([]);
    for (const value of [record, new Date(), new ExampleRecord()]) {
      expect(asNonArrayRecord(value)).toBe(value);
    }
    expect(firstFallback).toEqual({});
    expect(Object.getPrototypeOf(firstFallback)).toBe(Object.prototype);
    expect(secondFallback).toEqual({});
    expect(secondFallback).not.toBe(firstFallback);
  });

  it("preserves the canonical proxy trap behavior", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => asNonArrayRecord(proxy)).toThrow(TypeError);
    expect(() => isStringRecord(proxy)).toThrow(TypeError);
  });

  it.each([
    [{ first: "one", second: "two" }, true],
    [Object.assign(Object.create(null), { first: "one" }), true],
    [new Date(), true],
    [{ first: "one", second: 2 }, false],
    [["one"], false],
    [null, false],
  ])("validates all-or-nothing string records %#", (value, expected) => {
    expect(isStringRecord(value)).toBe(expected);
  });

  const inheritedAndHidden = Object.create({ inherited: "skip" }) as Record<string, unknown>;
  Object.defineProperty(inheritedAndHidden, "hidden", { value: "skip", enumerable: false });
  Object.assign(inheritedAndHidden, {
    blank: "",
    ignored: 1,
    whitespace: "  ",
    first: "same",
    second: "same",
  });

  it.each([
    [null, undefined],
    [["value"], undefined],
    [{ count: 1, enabled: true }, undefined],
    [inheritedAndHidden, { blank: "", whitespace: "  ", first: "same", second: "same" }],
  ])("filters string-valued record entries from %j", (value, expected) => {
    const result = filterStringRecord(value);
    expect(result).toEqual(expected);
    expect(result ? Object.keys(result) : undefined).toEqual(
      expected ? Object.keys(expected) : undefined,
    );
  });
});
