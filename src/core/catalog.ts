import type { CatalogModel, PopNowApi } from "./api.js";
import { creditsToUsd, formatUsd, parseUsd, type Usd } from "./money.js";
import type { ModelKind } from "./store.js";

type Model = CatalogModel;

export type CatalogApi = Pick<PopNowApi, "listModels" | "getModel">;

export const KIND_SOURCE: Record<ModelKind, { modality: "image" | "video"; task: string }> = {
  image: { modality: "image", task: "text-to-image" },
  video: { modality: "video", task: "text-to-video" },
  animate: { modality: "video", task: "image-to-video" },
};

export const KIND_LABEL: Record<ModelKind, string> = {
  image: "Image",
  video: "Video",
  animate: "Animate (image to video)",
};

const UNIT_LABEL: Record<string, string> = {
  per_image: "image",
  per_second: "s",
  per_request: "request",
  per_1k_characters: "1K chars",
};

/** `ALLOWED_MODELS` entries: exact IDs, or a prefix ending in `*` such as `alibaba/*`. */
export function modelAllowed(patterns: readonly string[], model: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => (pattern.endsWith("*") ? model.startsWith(pattern.slice(0, -1)) : pattern === model));
}

/**
 * The models a person can pick for one kind of request: callable right now, of the right task,
 * allowed by the operator, cheapest first.
 *
 * Toolkit models (subject swap and single-purpose studio tools) are never offered: the bot is not
 * built for swapping real people's faces, and those tools need inputs the bot does not collect.
 */
export function selectableModels(models: readonly Model[], kind: ModelKind, allowed: readonly string[]): Model[] {
  const source = KIND_SOURCE[kind];
  return models
    .filter(
      (model) =>
        model.enabled &&
        model.available &&
        model.modality === source.modality &&
        model.tasks.includes(source.task) &&
        model.toolkit === undefined &&
        modelAllowed(allowed, model.model),
    )
    .sort((a, b) => startingPrice(a) - startingPrice(b) || a.displayName.localeCompare(b.displayName));
}

/**
 * The starting USD rate of a model: the `usd` snapshot, or the deprecated credit snapshot when an
 * older server sends no USD. Credit rates may be fractional, so only whole ones are converted.
 */
function startingRate(model: Pick<Model, "usd" | "credits">): { perUnit: Usd; unit: string; varies: boolean } | undefined {
  const usd = model.usd;
  const perUnit = parseUsd(usd?.perUnit);
  if (usd && perUnit !== undefined) return { perUnit, unit: usd.unit, varies: (usd.rules?.length ?? 0) > 0 };
  const credits = model.credits;
  const fromCredits = creditsToUsd(credits?.perUnit);
  if (credits && fromCredits !== undefined) return { perUnit: fromCredits, unit: credits.unit, varies: (credits.rules?.length ?? 0) > 0 };
  return undefined;
}

function startingPrice(model: Pick<Model, "usd" | "credits">): number {
  return startingRate(model)?.perUnit ?? Number.MAX_SAFE_INTEGER;
}

/** "$0.01/image", or "from $0.045/s" when the price depends on the settings. */
export function priceLabel(model: Pick<Model, "usd" | "credits">): string {
  const rate = startingRate(model);
  if (!rate) return "";
  return `${rate.varies ? "from " : ""}${formatUsd(rate.perUnit)}/${UNIT_LABEL[rate.unit] ?? rate.unit}`;
}

/** Model list cache. The catalog changes rarely and the list endpoint is rate limited. */
export class Catalog {
  private readonly lists = new Map<string, { at: number; items: Model[] }>();
  private readonly details = new Map<string, { at: number; model: Model }>();

  constructor(
    private readonly api: CatalogApi,
    private readonly allowed: readonly string[],
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isAllowed(model: string): boolean {
    return modelAllowed(this.allowed, model);
  }

  async list(kind: ModelKind): Promise<Model[]> {
    const { modality } = KIND_SOURCE[kind];
    let cached = this.lists.get(modality);
    if (!cached || this.now() - cached.at > this.ttlMs) {
      const response = await this.api.listModels({ modality });
      cached = { at: this.now(), items: response.items };
      this.lists.set(modality, cached);
    }
    return selectableModels(cached.items, kind, this.allowed);
  }

  /** One model with its input schema. */
  async get(model: string): Promise<Model> {
    const cached = this.details.get(model);
    if (cached && this.now() - cached.at <= this.ttlMs) return cached.model;
    const fresh = await this.api.getModel(model);
    this.details.set(model, { at: this.now(), model: fresh });
    return fresh;
  }

  /** Display name for a model ID, falling back to the ID when it is not in the cached lists. */
  displayName(model: string): string {
    for (const list of this.lists.values()) {
      const found = list.items.find((item) => item.model === model);
      if (found) return found.displayName;
    }
    return this.details.get(model)?.model.displayName ?? model;
  }
}
