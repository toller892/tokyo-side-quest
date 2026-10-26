import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { closeDb } from "./client";
import { NEIGHBORHOODS } from "./content-manifest";
import { seedContent, seedQuests, type SeedPlace, type SeedQuest } from "./seed-lib";
import type { PlaceContent } from "./schema";
import { closeRedis } from "../infra/redis";
import { ensureBucket } from "../storage/s3";

// `pnpm db:seed [slug…] [--quests-only]`: imports neighbourhood content (all of
// them, or only the slugs given). Reference photos are fetched from Wikimedia
// Commons (licences recorded in content/sources/reference-images.json) and
// cached under content/.cache. `--quests-only` adds new quests to neighbourhoods
// that are already seeded without touching their places.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cacheDir = `${root}content/.cache/commons`;
const USER_AGENT = "TokyoSideQuest/0.1 (content seeding; https://github.com/toller892/tokyo-side-quest)";

interface RefSource {
  /** Where the licence was checked; Commons when absent. */
  provider?: "commons" | "flickr";
  file: string;
  filePageUrl: string;
  originalUrl: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  photoDate: string | null;
  viewNote: string;
  publicDisplay: boolean;
}

/** Ask the Commons API for a standard-size thumbnail (arbitrary widths are rejected). */
async function thumbUrl(src: RefSource): Promise<string> {
  const title = src.file.replace(/ /gu, "_");
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=1920&titles=${encodeURIComponent(title)}`;
  const res = await fetch(api, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`commons api ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: Record<string, { imageinfo?: { thumburl?: string; url?: string }[] }> } };
  const info = Object.values(body.query?.pages ?? {})[0]?.imageinfo?.[0];
  const url = info?.thumburl ?? info?.url;
  if (!url) throw new Error(`no image url for ${src.file}`);
  return url;
}

async function fetchCached(url: string): Promise<Buffer> {
  const file = `${cacheDir}/${createHash("sha256").update(url).digest("hex").slice(0, 24)}.bin`;
  try {
    return await readFile(file);
  } catch {
    // not cached yet
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, buf);
      return buf;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`download failed ${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  throw new Error(`download failed after retries ${url}`);
}

async function downloadReference(src: RefSource): Promise<Buffer> {
  const cached = `${cacheDir}/${createHash("sha256").update(src.filePageUrl).digest("hex").slice(0, 24)}.bin`;
  try {
    return await readFile(cached);
  } catch {
    // not cached yet
  }
  await new Promise((r) => setTimeout(r, 1200)); // be polite to the image host
  // Flickr entries point at the published size directly; Commons ones are resolved to a standard thumbnail.
  const bytes = await fetchCached(src.provider === "flickr" ? src.originalUrl : await thumbUrl(src));
  await writeFile(cached, bytes);
  return bytes;
}

/** Demo "unclear" sample: a heavily blurred crop of a licensed photo, labelled as a sample. */
async function unclearVariant(bytes: Buffer): Promise<Buffer> {
  const img = sharp(bytes).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? 1600;
  const h = meta.height ?? 1200;
  return sharp(bytes)
    .rotate()
    .extract({ left: Math.round(w * 0.35), top: Math.round(h * 0.35), width: Math.round(w * 0.3), height: Math.round(h * 0.3) })
    .blur(18)
    .modulate({ brightness: 0.55 })
    .jpeg()
    .toBuffer();
}

async function readQuests(hood: (typeof NEIGHBORHOODS)[number]): Promise<SeedQuest[]> {
  const quests: SeedQuest[] = [];
  for (const file of hood.quests) quests.push(JSON.parse(await readFile(`${root}content/${hood.dir}/${file}`, "utf8")) as SeedQuest);
  return quests;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const questsOnly = args.includes("--quests-only");
  const only = args.filter((a) => a !== "--quests-only");
  const unknown = only.filter((slug) => !NEIGHBORHOODS.some((n) => n.dir === slug));
  if (unknown.length) throw new Error(`unknown neighbourhood: ${unknown.join(", ")}`);
  const selected = NEIGHBORHOODS.filter((n) => only.length === 0 || only.includes(n.dir));

  if (questsOnly) {
    for (const hood of selected) {
      const created = await seedQuests(hood.dir, await readQuests(hood));
      console.log(`故事导入完成：${hood.dir} 新增 ${created.length} 个${created.length ? `（${created.join("、")}）` : ""}`);
    }
    return;
  }

  const sources = JSON.parse(await readFile(`${root}content/sources/reference-images.json`, "utf8")) as {
    places: Record<string, RefSource[]>;
  };
  await ensureBucket();

  // Location-only places whose rules forbid redistributing photos get no stored references.
  const skipReferences = new Set(["nezu-shrine", "yomise-dori"]);
  // "Other place" demo sample: a licensed photo of a different place (Nezu shrine gate).
  const nezu = sources.places["nezu-shrine"]?.[0];
  const otherPlace = nezu ? await downloadReference(nezu) : null;

  for (const hood of selected) {
    const placesFile = JSON.parse(await readFile(`${root}content/${hood.dir}/places.json`, "utf8"));
    const quests = await readQuests(hood);

    // Demo samples: the last licensed photo of each place is held out of the reference set.
    const demoMatch = new Map<string, Buffer>();
    const seedPlaces: SeedPlace[] = [];
    for (const p of placesFile.places as (Omit<SeedPlace, "references" | "content"> & { content: PlaceContent; photoNote?: string })[]) {
      const refs = skipReferences.has(p.slug) ? [] : (sources.places[p.slug] ?? []);
      const downloaded = [];
      for (const r of refs) {
        process.stdout.write(`  下载参考图 ${p.slug}: ${r.file}\n`);
        downloaded.push({ src: r, bytes: await downloadReference(r) });
      }
      let references = downloaded;
      if (p.photoEnabled && downloaded.length > 3) {
        const held = downloaded[downloaded.length - 1]!;
        demoMatch.set(p.slug, held.bytes);
        references = downloaded.slice(0, -1);
      } else if (p.photoEnabled && downloaded[0]) {
        demoMatch.set(p.slug, downloaded[0].bytes);
      }
      seedPlaces.push({
        slug: p.slug,
        nameZh: p.nameZh,
        nameJa: p.nameJa,
        nameEn: p.nameEn,
        latitude: p.latitude,
        longitude: p.longitude,
        radiusM: p.radiusM,
        photoEnabled: p.photoEnabled,
        tags: p.tags,
        stayMinutes: p.stayMinutes,
        content: p.content,
        references: references.map(({ src, bytes }) => ({
          bytes,
          viewNote: src.viewNote,
          sourceUrl: src.filePageUrl,
          author: src.author,
          license: src.license,
          usageBasis: `${src.provider === "flickr" ? "Flickr" : "Wikimedia Commons"} ${src.license}${src.licenseUrl ? ` (${src.licenseUrl})` : ""}；需署名${src.license.includes("SA") ? "，衍生作品以相同协议发布" : ""}`,
          publicDisplay: src.publicDisplay,
          capturedOn: src.photoDate,
        })),
      });
    }

    const result = await seedContent({
      neighborhood: placesFile.neighborhood,
      places: seedPlaces,
      quests,
      sampleImages: async (slug) => {
        const match = demoMatch.get(slug);
        if (!match || !otherPlace) return null;
        return { match, unclear: await unclearVariant(match), other: otherPlace };
      },
    });
    console.log(`种子数据完成：${placesFile.neighborhood.nameZh} ${Object.keys(result.places).length} 个地点`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await closeDb();
  });
