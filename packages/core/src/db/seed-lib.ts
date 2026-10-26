import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { neighborhoods, places, quests, type PlaceContent } from "./schema";
import type { ProofPolicy } from "../domain/status";
import {
  addReferenceImage,
  createQuestVersion,
  publishPlace,
  publishQuestVersion,
  storeImageAsset,
  type ReferenceImageInput,
} from "../services/content";

// Idempotent content seeding used by `pnpm db:seed` and integration tests.
// Re-running updates drafts and only publishes a new version when needed.

export interface SeedPlace {
  slug: string;
  nameZh: string;
  nameJa: string;
  nameEn: string | null;
  latitude: number;
  longitude: number;
  radiusM: number;
  photoEnabled: boolean;
  tags: string[];
  stayMinutes: number | null;
  content: PlaceContent;
  references: ReferenceImageInput[];
}

export interface SeedQuest {
  slug: string;
  title: string;
  subtitle: string;
  intro: string;
  ending: string;
  estimatedMinutes: number;
  fictionNote: string;
  steps: {
    placeSlug: string;
    proofPolicy: ProofPolicy;
    required?: boolean;
    title: string;
    story: string;
    objective: string;
    clue: string;
    observationQuestion: string;
    completionText: string;
  }[];
}

export interface SeedInput {
  neighborhood: {
    slug: string;
    nameZh: string;
    nameJa: string;
    nameEn: string | null;
    summary: string;
    center: { latitude: number; longitude: number };
    /** Position in the neighbourhood picker; lower comes first. */
    sortOrder?: number;
  };
  places: SeedPlace[];
  quests: SeedQuest[];
  /** Demo sample images per photo-enabled place; omitted → no demo samples. */
  sampleImages?: (slug: string) => Promise<{ match: Buffer; unclear: Buffer; other: Buffer } | null>;
}

const point = (lat: number, lng: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

export async function seedContent(input: SeedInput) {
  const n = input.neighborhood;
  const [hood] = await db()
    .insert(neighborhoods)
    .values({
      slug: n.slug,
      nameZh: n.nameZh,
      nameJa: n.nameJa,
      nameEn: n.nameEn,
      summary: n.summary,
      center: point(n.center.latitude, n.center.longitude) as unknown as string,
      status: "published",
      sortOrder: n.sortOrder ?? 0,
    })
    .onConflictDoUpdate({
      target: neighborhoods.slug,
      set: { nameZh: n.nameZh, nameJa: n.nameJa, nameEn: n.nameEn, summary: n.summary, status: "published", sortOrder: n.sortOrder ?? 0 },
    })
    .returning({ id: neighborhoods.id });

  const placeIds = new Map<string, string>();
  for (const p of input.places) {
    const [row] = await db()
      .insert(places)
      .values({
        slug: p.slug,
        neighborhoodId: hood!.id,
        nameZh: p.nameZh,
        nameJa: p.nameJa,
        nameEn: p.nameEn,
        geo: point(p.latitude, p.longitude) as unknown as string,
        radiusM: p.radiusM,
        photoEnabled: p.photoEnabled,
        tags: p.tags,
        stayMinutes: p.stayMinutes,
        draft: p.content,
      })
      .onConflictDoUpdate({
        target: places.slug,
        set: {
          nameZh: p.nameZh,
          nameJa: p.nameJa,
          nameEn: p.nameEn,
          geo: point(p.latitude, p.longitude) as unknown as string,
          radiusM: p.radiusM,
          photoEnabled: p.photoEnabled,
          tags: p.tags,
          stayMinutes: p.stayMinutes,
          draft: p.content,
          updatedAt: new Date(),
        },
      })
      .returning({ id: places.id, publishedVersionId: places.publishedVersionId });
    placeIds.set(p.slug, row!.id);

    if (!row!.publishedVersionId) {
      for (const ref of p.references) await addReferenceImage(row!.id, ref);
      await publishPlace(row!.id);
    }

    if (p.photoEnabled && input.sampleImages) {
      const imgs = await input.sampleImages(p.slug);
      if (imgs) {
        for (const kind of ["match", "unclear", "other"] as const) {
          const base = `sample/${p.slug}--${kind}`;
          await storeImageAsset(db(), imgs[kind], "sample", {
            main: `${base}/main.jpg`,
            model: `${base}/model.jpg`,
            thumb: `${base}/thumb.jpg`,
          });
        }
      }
    }
  }

  await insertQuests(hood!.id, placeIds, input.quests);

  const result = await db().select({ id: places.id, slug: places.slug }).from(places).where(eq(places.neighborhoodId, hood!.id));
  return { neighborhoodId: hood!.id, places: Object.fromEntries(result.map((r) => [r.slug, r.id])) as Record<string, string> };
}

/**
 * Imports only the quests of an already-seeded neighbourhood, leaving its places,
 * reference images and demo samples untouched (`pnpm db:seed <slug> --quests-only`).
 */
export async function seedQuests(neighborhoodSlug: string, input: SeedQuest[]) {
  const [hood] = await db().select({ id: neighborhoods.id }).from(neighborhoods).where(eq(neighborhoods.slug, neighborhoodSlug));
  if (!hood) throw new Error(`neighbourhood ${neighborhoodSlug} has not been seeded`);
  const rows = await db().select({ id: places.id, slug: places.slug }).from(places).where(eq(places.neighborhoodId, hood.id));
  return insertQuests(hood.id, new Map(rows.map((r) => [r.slug, r.id])), input);
}

/** Creates and publishes v1 of each quest that has no published version yet; returns the slugs created. */
async function insertQuests(neighborhoodId: string, placeIds: Map<string, string>, input: SeedQuest[]) {
  const created: string[] = [];
  for (const q of input) {
    const [quest] = await db()
      .insert(quests)
      .values({ slug: q.slug, neighborhoodId })
      .onConflictDoUpdate({ target: quests.slug, set: { neighborhoodId } })
      .returning();
    if (quest!.publishedVersionId) continue;
    const qv = await createQuestVersion(quest!.id, {
      ...q,
      steps: q.steps.map((s) => {
        const placeId = placeIds.get(s.placeSlug);
        if (!placeId) throw new Error(`quest ${q.slug} references unknown place ${s.placeSlug}`);
        return { ...s, placeId };
      }),
    });
    await publishQuestVersion(qv.id);
    created.push(q.slug);
  }
  return created;
}
