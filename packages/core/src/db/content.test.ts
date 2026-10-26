import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEIGHBORHOODS } from "./content-manifest";
import type { SeedQuest } from "./seed-lib";

// Static checks on content/ so a broken quest file fails here instead of in
// `pnpm db:seed` on the production server (spec §12.4).

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(`${root}content/${path}`, "utf8")) as T;

const STEP_TEXT = ["title", "story", "objective", "clue", "observationQuestion", "completionText"] as const;

describe("content manifest", () => {
  it("lists every quest file in each neighbourhood folder", () => {
    for (const hood of NEIGHBORHOODS) {
      const onDisk = readdirSync(`${root}content/${hood.dir}`).filter((f) => /^quest-.+\.json$/u.test(f));
      expect([...hood.quests].sort(), hood.dir).toEqual(onDisk.sort());
    }
  });

  it("uses each quest slug once across neighbourhoods", () => {
    const slugs = NEIGHBORHOODS.flatMap((hood) => hood.quests.map((file) => readJson<SeedQuest>(`${hood.dir}/${file}`).slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe.each(NEIGHBORHOODS.flatMap((hood) => hood.quests.map((file) => ({ hood: hood.dir, file }))))("$hood/$file", ({ hood, file }) => {
  const quest = readJson<SeedQuest>(`${hood}/${file}`);
  const places = new Map(
    readJson<{ places: { slug: string; photoEnabled: boolean }[] }>(`${hood}/places.json`).places.map((p) => [p.slug, p]),
  );

  it("has an intro, ending and fiction note", () => {
    expect(quest.slug).toMatch(/^[a-z0-9-]+$/u);
    for (const key of ["title", "subtitle", "intro", "ending", "fictionNote"] as const) expect(quest[key].trim(), key).not.toBe("");
    expect(quest.fictionNote).toContain("虚构");
    expect(quest.estimatedMinutes).toBeGreaterThan(0);
  });

  it("only visits places of its own neighbourhood, each once, with a usable proof policy", () => {
    expect(quest.steps.length).toBeGreaterThan(0);
    expect(new Set(quest.steps.map((s) => s.placeSlug)).size).toBe(quest.steps.length);
    for (const step of quest.steps) {
      const place = places.get(step.placeSlug);
      expect(place, `${step.placeSlug} is not a place in ${hood}`).toBeDefined();
      expect(["location", "photo", "either"]).toContain(step.proofPolicy);
      if (step.proofPolicy === "photo") expect(place!.photoEnabled, `${step.placeSlug} has no photo verification`).toBe(true);
      for (const key of STEP_TEXT) expect(step[key].trim(), `${step.placeSlug}.${key}`).not.toBe("");
    }
  });
});
