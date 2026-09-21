import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { IntlMessageFormat } from "intl-messageformat";
import { validateFlowForActivation } from "./validate";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import es from "../../../messages/es.json";
import ko from "../../../messages/ko.json";

const catalogues = { en, pt, es, ko } as const;

// A deliberately broken flow that trips most rules. Rules that need a
// clean-but-other-broken shape are covered by the source scan below.
const flow = {
  name: " ",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["ok", "", " "] },
  entry_node_id: "ghost",
};
const long = "x".repeat(2000);
const nodes = [
  { node_key: "s", node_type: "start", config: { next_node_key: "nope" } },
  { node_key: "s", node_type: "start", config: {} },
  { node_key: "m", node_type: "send_message", config: { next_node_key: "nope" } },
  { node_key: "m2", node_type: "send_message", config: {} },
  { node_key: "md", node_type: "send_media", config: { caption: long, next_node_key: "nope" } },
  { node_key: "md2", node_type: "send_media", config: {} },
  {
    node_key: "b",
    node_type: "send_buttons",
    config: {
      buttons: [
        { reply_id: "a", title: "x".repeat(30), next_node_key: "nope" },
        { reply_id: "a", title: "" },
        { title: "t" },
        { reply_id: "d", title: "d", next_node_key: "b" },
      ],
    },
  },
  { node_key: "b0", node_type: "send_buttons", config: {} },
  {
    node_key: "l",
    node_type: "send_list",
    config: {
      sections: [
        {
          rows: Array.from({ length: 12 }, (_, i) => ({
            reply_id: i === 1 ? "r0" : i === 2 ? "" : `r${i}`,
            title: i === 3 ? "" : i === 4 ? "y".repeat(40) : "t",
            description: i === 5 ? "z".repeat(100) : "",
            next_node_key: i === 6 ? undefined : "nope",
          })),
        },
      ],
    },
  },
  { node_key: "l0", node_type: "send_list", config: {} },
  { node_key: "c", node_type: "collect_input", config: { var_key: "1bad", next_node_key: "nope" } },
  { node_key: "c2", node_type: "collect_input", config: {} },
  { node_key: "k", node_type: "condition", config: { subject: "var", subject_key: "v", operator: "equals", true_next: "nope" } },
  { node_key: "k2", node_type: "condition", config: {} },
  { node_key: "t", node_type: "set_tag", config: { mode: "add", tag_id: "1", next_node_key: "nope" } },
  { node_key: "t2", node_type: "set_tag", config: {} },
  { node_key: "u", node_type: "weird", config: {} },
];

describe("flow validation codes", () => {
  const issues = validateFlowForActivation(flow, nodes);

  it("every issue carries a code", () => {
    expect(issues.length).toBeGreaterThan(40);
    for (const i of issues) expect(i.code).toBeTruthy();
  });

  it("every code in validate.ts has a key in all four catalogues", () => {
    const src = readFileSync(join(__dirname, "validate.ts"), "utf8");
    const codes = [...src.matchAll(/^\s*code: "(\w+)",$/gm)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(50);
    for (const [name, cat] of Object.entries(catalogues)) {
      const keys = Object.keys(cat.Flows.validation.issues);
      for (const c of codes) expect(keys, `${name}:${c}`).toContain(c);
      expect(keys.sort()).toEqual([...new Set(codes)].sort());
    }
  });

  it("en text rendered with params equals the unchanged API message", () => {
    const en_ = en.Flows.validation.issues as Record<string, string>;
    for (const i of issues) {
      const out = new IntlMessageFormat(en_[i.code], "en").format(i.params);
      expect(out, i.code).toBe(i.message);
    }
  });

  it("pt/es/ko templates keep the same ICU params as en", () => {
    const names = (s: string) =>
      [...new Set([...s.matchAll(/\{(\w+)/g)].map((m) => m[1]))].sort();
    for (const [code, text] of Object.entries(en.Flows.validation.issues)) {
      for (const cat of [pt, es, ko]) {
        const t = (cat.Flows.validation.issues as Record<string, string>)[code];
        expect(names(t), code).toEqual(names(text));
      }
    }
  });
});
