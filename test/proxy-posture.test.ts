import { describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  warnOnProxyPosture,
  type ProxyPostureWarning,
} from "../logic/http-security.ts";

interface CapturedWarning {
  message: string;
  fields?: Record<string, unknown>;
}

function capture() {
  const warnings: CapturedWarning[] = [];
  return {
    warnings,
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push({ message, fields });
    },
  };
}

function codes(warnings: ProxyPostureWarning[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe("proxy posture warnings", () => {
  it("does not warn for loopback binds", () => {
    const { warnings, warn } = capture();

    expect(warnOnProxyPosture("127.0.0.1", undefined, warn)).toEqual([]);
    expect(warnOnProxyPosture("localhost", false, warn)).toEqual([]);
    expect(warnOnProxyPosture("[::1]", true, warn)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns when a non-loopback bind has proxy trust unset or disabled", () => {
    const { warnings, warn } = capture();

    expect(codes(warnOnProxyPosture("0.0.0.0", undefined, warn))).toEqual([
      "proxy_trust_missing",
    ]);
    expect(codes(warnOnProxyPosture("203.0.113.5", false, warn))).toEqual([
      "proxy_trust_missing",
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toMatch(/every client will appear/i);
    expect(warnings[0].fields).toMatchObject({
      code: "proxy_trust_missing",
      host: "0.0.0.0",
    });
  });

  it("warns when wildcard proxy trust meets a non-loopback bind", () => {
    const { warnings, warn } = capture();

    expect(codes(warnOnProxyPosture("0.0.0.0", true, warn))).toEqual([
      "proxy_trust_wildcard",
    ]);
    expect(codes(warnOnProxyPosture("0.0.0.0", "0.0.0.0/0", warn))).toEqual([
      "proxy_trust_wildcard",
    ]);
    expect(codes(warnOnProxyPosture("::", "::/0", warn))).toEqual([
      "proxy_trust_wildcard",
    ]);
    expect(codes(warnOnProxyPosture(
      "0.0.0.0",
      ["10.0.0.0/8", "0.0.0.0/0"],
      warn,
    ))).toEqual(["proxy_trust_wildcard"]);
    expect(codes(warnOnProxyPosture("0.0.0.0", "1.2.3.4/0", warn))).toEqual([
      "proxy_trust_wildcard",
    ]);
    expect(warnings).toHaveLength(5);
    expect(warnings[0].message).toContain("spoof");
  });

  it("stays quiet for specific proxy trust on a non-loopback bind", () => {
    const { warnings, warn } = capture();

    expect(warnOnProxyPosture("0.0.0.0", "loopback", warn)).toEqual([]);
    expect(warnOnProxyPosture("0.0.0.0", "203.0.113.5", warn)).toEqual([]);
    expect(warnOnProxyPosture("0.0.0.0", 1, warn)).toEqual([]);
    expect(warnOnProxyPosture("0.0.0.0", ["10.0.0.0/8"], warn)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("recognizes loopback host forms", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("203.0.113.5")).toBe(false);
    expect(isLoopbackHost("todo.example.com")).toBe(false);
  });
});
