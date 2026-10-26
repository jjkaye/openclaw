import { describe, expect, it } from "vitest";
import {
  commonPrefixLength,
  containsAsciiControlCharacter,
  filterStringEntries,
  normalizeAtHashSlug,
  normalizeCsvOrLooseStringList,
  normalizeHyphenSlug,
  normalizeOptionalTrimmedStringList,
  normalizeSortedUniqueStringEntries,
  normalizeSortedUniqueTrimmedStringList,
  normalizeStringEntries,
  normalizeTrimmedStringList,
  normalizeUniqueSingleOrTrimmedStringList,
  normalizeUniqueStringEntries,
  normalizeUniqueStringEntriesLower,
  normalizeUniqueTrimmedStringList,
  sortUniqueStrings,
} from "./string-normalization.js";

describe("normalization-core/string-normalization", () => {
  it.each([
    ["", "value", 0],
    ["value", "", 0],
    ["same", "same", 4],
    ["prefix", "pre", 3],
    ["pre", "prefix", 3],
    ["abX", "abY", 2],
    ["A", "a", 0],
    ["\ud83d\ude00", "\ud83d\ude01", 1],
    ["é", "e\u0301", 0],
  ])("counts the raw UTF-16 prefix of %j and %j", (left, right, expected) => {
    expect(commonPrefixLength(left, right)).toBe(expected);
  });

  it.each([
    ["", false],
    ["fix/a&b λ", false],
    ["\u0080\u009f", false],
    ["branch\0name", true],
    ["branch\u001f", true],
    ["branch\u007fname", true],
  ])("detects only ASCII controls: %j", (value, expected) => {
    expect(containsAsciiControlCharacter(value)).toBe(expected);
  });

  it.each([
    ["value", []],
    [{ 0: "value" }, []],
    [
      ["", "  ", 1, "first", null, "first", Object("boxed"), "last\n"],
      ["", "  ", "first", "first", "last\n"],
    ],
  ])("filters runtime strings from %j", (value, expected) => {
    expect(filterStringEntries(value)).toEqual(expected);
  });

  it("normalizes mixed allow-list entries", () => {
    expect(
      normalizeStringEntries([" a ", 42, "", "  ", null, { toString: () => " obj " }]),
    ).toEqual(["a", "42", "null", "obj"]);
    expect(normalizeStringEntries(undefined)).toStrictEqual([]);
  });

  it.each([
    {
      label: "case and numeric text",
      values: ["a", "Z", "10", "2", "A", ""],
      expected: ["", "10", "2", "A", "Z", "a"],
    },
    {
      label: "UTF-16 without normalization",
      values: ["\ue000", "\ud83d\ude00", "\ud800", "\udc00", "é", "e\u0301", "é"],
      expected: ["e\u0301", "é", "\ud800", "\ud83d\ude00", "\udc00", "\ue000"],
    },
  ])("sorts fresh unique strings from iterables: $label", ({ values, expected }) => {
    const input = Object.freeze(values);
    const result = sortUniqueStrings(input);
    expect(result).toEqual(expected);
    expect(result).not.toBe(input);
    expect(sortUniqueStrings(new Set(input))).toEqual(expected);
    expect(sortUniqueStrings(input.values())).toEqual(expected);
  });

  it.each([
    [normalizeUniqueStringEntries, ["b", "a", "4", "MiXeD", "B"]],
    [normalizeUniqueStringEntriesLower, ["b", "a", "4", "mixed"]],
    [normalizeSortedUniqueStringEntries, ["4", "B", "MiXeD", "a", "b"]],
    [normalizeUniqueTrimmedStringList, ["b", "a", "MiXeD", "B"]],
    [normalizeSortedUniqueTrimmedStringList, ["B", "MiXeD", "a", "b"]],
    [normalizeUniqueSingleOrTrimmedStringList, ["b", "a", "MiXeD", "B"]],
  ])("normalizes unique lists with %s", (normalize, expected) => {
    expect(normalize([" b ", "a", "b", "", 4, "a", "MiXeD", "B"])).toEqual(expected);
  });

  it("normalizes array-backed trimmed string lists", () => {
    const values = [" first ", "", 42, " second ", null];
    expect(normalizeTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeTrimmedStringList("first")).toEqual([]);
    expect(normalizeOptionalTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeOptionalTrimmedStringList(["", 42])).toBeUndefined();
  });

  it.each([
    [" first, second, , first ", ["first", "second", "first"]],
    [
      [" first ", 42, "", "  ", 7],
      ["first", "42", "7"],
    ],
    [null, []],
  ])("normalizes CSV or loose string-list input %j", (value, expected) => {
    expect(normalizeCsvOrLooseStringList(value)).toEqual(expected);
  });

  it("distinguishes array-only from single-or-list input", () => {
    expect(normalizeUniqueTrimmedStringList("b")).toEqual([]);
    expect(normalizeUniqueSingleOrTrimmedStringList(" b ")).toEqual(["b"]);
  });

  it.each([
    [" #My_Channel + Alerts ", "#my_channel-+-alerts"],
    [undefined, ""],
    ["  ...Hello   /  World---  ", "hello-world"],
    [" ###Team@@@Room### ", "###team@@@room###"],
    ["Team 技术讨论", "team-技术讨论"],
    ["Команда разработки", "команда-разработки"],
    ["فريق التطوير", "فريق-التطوير"],
    ["Cafe\u0301 Team", "café-team"],
    ["हिन्दी चर्चा", "हिन्दी-चर्चा"],
  ])("normalizes permissive slugs: %s", (input, expected) => {
    expect(normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    [" #My_Channel + Alerts ", "my-channel-alerts"],
    ["@@Room___Name", "room-name"],
    [undefined, ""],
    ["@@@___", ""],
    ["#Команда разработки", "команда-разработки"],
    ["@فريق التطوير", "فريق-التطوير"],
    ["#OpenClaw中文群", "openclaw中文群"],
    ["#Cafe\u0301_Team", "café-team"],
    ["@हिन्दी चर्चा", "हिन्दी-चर्चा"],
  ])("normalizes strict slugs: %s", (input, expected) => {
    expect(normalizeAtHashSlug(input)).toBe(expected);
  });
});
