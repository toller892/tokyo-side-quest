import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { checkins, neighborhoods, places, questRuns, quests, questSteps, questStepProgress, questVersions } from "../db/schema";
import type { Mode } from "../domain/status";
import { AppError } from "../http/errors";

// Quest runs (spec §5.3). A run is pinned to the quest version it started
// with, so later edits never rewrite a player's history.

/** Published quests, grouped by neighbourhood order and then oldest first, so the flagship story leads (the demo page plays the first one). */
export async function listQuests() {
  return db()
    .select({
      id: quests.id,
      slug: quests.slug,
      title: questVersions.title,
      subtitle: questVersions.subtitle,
      intro: questVersions.intro,
      estimatedMinutes: questVersions.estimatedMinutes,
      fictionNote: questVersions.fictionNote,
      version: questVersions.version,
      stepCount: sql<number>`(select count(*) from quest_steps s where s.quest_version_id = ${questVersions.id} and s.required)`.mapWith(Number),
    })
    .from(quests)
    .innerJoin(questVersions, eq(questVersions.id, quests.publishedVersionId))
    .innerJoin(neighborhoods, eq(neighborhoods.id, quests.neighborhoodId))
    .where(eq(quests.status, "published"))
    .orderBy(asc(neighborhoods.sortOrder), asc(quests.createdAt), asc(quests.slug));
}

async function stepsOf(questVersionId: string) {
  return db()
    .select({
      id: questSteps.id,
      position: questSteps.position,
      placeId: questSteps.placeId,
      placeSlug: places.slug,
      placeNameZh: places.nameZh,
      placeNameJa: places.nameJa,
      placeStatus: places.status,
      photoEnabled: places.photoEnabled,
      latitude: sql<number>`ST_Y(${places.geo}::geometry)`.mapWith(Number),
      longitude: sql<number>`ST_X(${places.geo}::geometry)`.mapWith(Number),
      proofPolicy: questSteps.proofPolicy,
      required: questSteps.required,
      title: questSteps.title,
      story: questSteps.story,
      objective: questSteps.objective,
      clue: questSteps.clue,
      observationQuestion: questSteps.observationQuestion,
      completionText: questSteps.completionText,
    })
    .from(questSteps)
    .innerJoin(places, eq(places.id, questSteps.placeId))
    .where(eq(questSteps.questVersionId, questVersionId))
    .orderBy(asc(questSteps.position));
}

export async function getQuest(idOrSlug: string) {
  const isUuid = /^[0-9a-f-]{36}$/iu.test(idOrSlug);
  const [row] = await db()
    .select({ quest: quests, version: questVersions })
    .from(quests)
    .innerJoin(questVersions, eq(questVersions.id, quests.publishedVersionId))
    .where(and(eq(quests.status, "published"), isUuid ? eq(quests.id, idOrSlug) : eq(quests.slug, idOrSlug)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "没有找到这个故事");
  const steps = await stepsOf(row.version.id);
  return {
    id: row.quest.id,
    slug: row.quest.slug,
    versionId: row.version.id,
    version: row.version.version,
    title: row.version.title,
    subtitle: row.version.subtitle,
    intro: row.version.intro,
    estimatedMinutes: row.version.estimatedMinutes,
    fictionNote: row.version.fictionNote,
    // Spoiler-free preview: clues and the ending are revealed during the run.
    steps: steps.map((s) => ({
      id: s.id,
      position: s.position,
      required: s.required,
      title: s.title,
      proofPolicy: s.proofPolicy,
      place: { id: s.placeId, slug: s.placeSlug, nameZh: s.placeNameZh, nameJa: s.placeNameJa },
    })),
  };
}

export async function startQuestRun(opts: { visitorId: string; mode: Mode; questId: string }) {
  const quest = await getQuest(opts.questId);
  // Only one active run per visitor + quest + mode (partial unique index).
  const inserted = await db()
    .insert(questRuns)
    .values({ visitorId: opts.visitorId, questId: quest.id, questVersionId: quest.versionId, mode: opts.mode })
    .onConflictDoNothing()
    .returning({ id: questRuns.id });
  if (inserted.length > 0) return { runId: inserted[0]!.id, created: true };
  const [active] = await db()
    .select({ id: questRuns.id })
    .from(questRuns)
    .where(
      and(
        eq(questRuns.visitorId, opts.visitorId),
        eq(questRuns.questId, quest.id),
        eq(questRuns.mode, opts.mode),
        eq(questRuns.status, "active"),
      ),
    );
  return { runId: active!.id, created: false };
}

export async function getQuestRun(opts: { visitorId: string; runId: string }) {
  const [row] = await db()
    .select({ run: questRuns, version: questVersions, questSlug: quests.slug })
    .from(questRuns)
    .innerJoin(questVersions, eq(questVersions.id, questRuns.questVersionId))
    .innerJoin(quests, eq(quests.id, questRuns.questId))
    .where(and(eq(questRuns.id, opts.runId), eq(questRuns.visitorId, opts.visitorId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "没有找到这次故事探索");
  const steps = await stepsOf(row.version.id);
  const progress = await db()
    .select({ stepId: questStepProgress.stepId, completedAt: questStepProgress.completedAt, method: checkins.method, arrivalVerified: checkins.arrivalVerified, simulated: checkins.simulated })
    .from(questStepProgress)
    .innerJoin(checkins, eq(checkins.id, questStepProgress.checkinId))
    .where(eq(questStepProgress.runId, row.run.id));
  const done = new Map(progress.map((p) => [p.stepId, p]));
  const currentStep = steps.find((s) => s.required && !done.has(s.id)) ?? null;
  const completed = row.run.status === "completed";

  return {
    runId: row.run.id,
    mode: row.run.mode,
    status: row.run.status,
    startedAt: row.run.startedAt,
    completedAt: row.run.completedAt,
    quest: {
      id: row.run.questId,
      slug: row.questSlug,
      title: row.version.title,
      intro: row.version.intro,
      fictionNote: row.version.fictionNote,
      version: row.version.version,
      ending: completed ? row.version.ending : null,
    },
    currentStepId: currentStep?.id ?? null,
    steps: steps.map((s) => {
      const p = done.get(s.id);
      const unlocked = Boolean(p) || s.id === currentStep?.id;
      return {
        id: s.id,
        position: s.position,
        required: s.required,
        title: s.title,
        proofPolicy: s.proofPolicy,
        place: {
          id: s.placeId,
          slug: s.placeSlug,
          nameZh: s.placeNameZh,
          nameJa: s.placeNameJa,
          available: s.placeStatus === "published",
          photoEnabled: s.photoEnabled,
          latitude: s.latitude,
          longitude: s.longitude,
        },
        status: p ? ("completed" as const) : s.id === currentStep?.id ? ("current" as const) : ("locked" as const),
        // Story text unlocks progressively.
        story: unlocked ? s.story : null,
        objective: unlocked ? s.objective : null,
        clue: unlocked ? s.clue : null,
        observationQuestion: unlocked ? s.observationQuestion : null,
        completionText: p ? s.completionText : null,
        completedAt: p?.completedAt ?? null,
        proofLabel: p ? (p.method === "location" ? (p.simulated ? "位置符合范围 · 模拟定位" : "位置符合范围") : p.arrivalVerified ? "照片匹配 · 位置符合范围" : "照片地点匹配 · 未核验到访") : null,
      };
    }),
  };
}

export async function endQuestRun(opts: { visitorId: string; runId: string }) {
  const res = await db()
    .update(questRuns)
    .set({ status: "ended_partial", endedAt: new Date() })
    .where(and(eq(questRuns.id, opts.runId), eq(questRuns.visitorId, opts.visitorId), eq(questRuns.status, "active")))
    .returning({ id: questRuns.id });
  if (res.length === 0) {
    const run = await getQuestRun(opts);
    if (run.status !== "ended_partial") throw new AppError("QUEST_RUN_CONFLICT", "只能结束进行中的探索");
  }
  return { runId: opts.runId, status: "ended_partial" as const };
}

export async function resumeQuestRun(opts: { visitorId: string; runId: string }) {
  try {
    const res = await db()
      .update(questRuns)
      .set({ status: "active", endedAt: null })
      .where(and(eq(questRuns.id, opts.runId), eq(questRuns.visitorId, opts.visitorId), eq(questRuns.status, "ended_partial")))
      .returning({ id: questRuns.id });
    if (res.length === 0) {
      const run = await getQuestRun(opts);
      if (run.status !== "active") throw new AppError("QUEST_RUN_CONFLICT", "这次探索不能恢复");
    }
  } catch (error) {
    if ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") {
      throw new AppError("QUEST_RUN_CONFLICT", "这个故事已有另一段进行中的探索");
    }
    throw error;
  }
  return { runId: opts.runId, status: "active" as const };
}

export async function listMyRuns(opts: { visitorId: string; mode: Mode }) {
  return db()
    .select({
      runId: questRuns.id,
      status: questRuns.status,
      startedAt: questRuns.startedAt,
      completedAt: questRuns.completedAt,
      questSlug: quests.slug,
      title: questVersions.title,
      done: sql<number>`(select count(*) from quest_step_progress p where p.run_id = ${questRuns.id})`.mapWith(Number),
      total: sql<number>`(select count(*) from quest_steps s where s.quest_version_id = ${questRuns.questVersionId} and s.required)`.mapWith(Number),
    })
    .from(questRuns)
    .innerJoin(quests, eq(quests.id, questRuns.questId))
    .innerJoin(questVersions, eq(questVersions.id, questRuns.questVersionId))
    .where(and(eq(questRuns.visitorId, opts.visitorId), eq(questRuns.mode, opts.mode)))
    .orderBy(sql`${questRuns.startedAt} desc`);
}
