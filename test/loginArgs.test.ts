import { describe, expect, it } from "vitest";
import { parseLoginArgs } from "../src/login-args.js";

describe("parseLoginArgs", () => {
  it("defaults to no cache and no help", () => {
    expect(parseLoginArgs([])).toEqual({ help: false, cache: null });
  });

  it("reads --cache <path>", () => {
    expect(parseLoginArgs(["--cache", "C:/tmp/creds.json"])).toEqual({
      help: false,
      cache: "C:/tmp/creds.json",
    });
  });

  it("accepts --help and -h", () => {
    expect(parseLoginArgs(["--help"]).help).toBe(true);
    expect(parseLoginArgs(["-h"]).help).toBe(true);
  });

  it("ignores --cache without a value", () => {
    expect(parseLoginArgs(["--cache"])).toEqual({ help: false, cache: null });
  });
});
