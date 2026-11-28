import { afterEach, describe, expect, it } from "vitest";
import { canonicalNode, canonicalNodeIn, hostnameValues, nodeNames, nodeNamesIn, parseNodeAliases, setNodeAliasesForTest } from "./node-names.js";

describe("parseNodeAliases (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8)", () => {
  it("is empty when unset or blank", () => {
    expect(parseNodeAliases({})).toEqual(new Map());
    expect(parseNodeAliases({ CLAWS_NODE_ALIASES: " , " })).toEqual(new Map());
  });

  it("parses old=new pairs in order, trimming whitespace", () => {
    expect([...parseNodeAliases({ CLAWS_NODE_ALIASES: " k3s = thinkcentre , k3s-nas=nas" })])
      .toEqual([["k3s", "thinkcentre"], ["k3s-nas", "nas"]]);
  });

  it("throws on a malformed, self, duplicate or chained entry", () => {
    for (const bad of ["k3s", "=nas", "k3s=", "bad_host=nas", "k3s=bad host"]) {
      expect(() => parseNodeAliases({ CLAWS_NODE_ALIASES: bad })).toThrow(/Invalid CLAWS_NODE_ALIASES entry/);
    }
    expect(() => parseNodeAliases({ CLAWS_NODE_ALIASES: "nas=nas" })).toThrow(/the same/);
    expect(() => parseNodeAliases({ CLAWS_NODE_ALIASES: "k3s=a,k3s=b" })).toThrow(/aliased twice/);
    expect(() => parseNodeAliases({ CLAWS_NODE_ALIASES: "a=b,b=c" })).toThrow(/itself an old name/);
  });
});

describe("canonicalNodeIn / nodeNamesIn", () => {
  const aliases = parseNodeAliases({ CLAWS_NODE_ALIASES: "k3s=thinkcentre,k3s-nas=nas,old-nas=nas" });

  it("maps an old name to its new one and leaves others alone", () => {
    expect(canonicalNodeIn(aliases, "k3s")).toBe("thinkcentre");
    expect(canonicalNodeIn(aliases, "thinkcentre")).toBe("thinkcentre");
    expect(canonicalNodeIn(aliases, "ryzen")).toBe("ryzen");
  });

  it("lists the new name first, then its old names", () => {
    expect(nodeNamesIn(aliases, "nas")).toEqual(["nas", "k3s-nas", "old-nas"]);
    expect(nodeNamesIn(aliases, "ryzen")).toEqual(["ryzen"]);
  });
});

describe("process aliases", () => {
  afterEach(() => setNodeAliasesForTest(null));

  it("are empty without CLAWS_NODE_ALIASES, so names pass through", () => {
    expect(canonicalNode("k3s")).toBe("k3s");
    expect(nodeNames("k3s")).toEqual(["k3s"]);
    expect(hostnameValues(["k3s-nas", "k3s"])).toEqual(["k3s-nas", "k3s"]);
  });

  it("expand a node list into a hostname In list without duplicates", () => {
    setNodeAliasesForTest(new Map([["k3s", "thinkcentre"], ["k3s-nas", "nas"]]));
    expect(canonicalNode("k3s-nas")).toBe("nas");
    expect(hostnameValues(["nas", "thinkcentre", "nas"])).toEqual(["nas", "k3s-nas", "thinkcentre", "k3s"]);
  });
});
