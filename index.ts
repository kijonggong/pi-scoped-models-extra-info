/**
 * /scoped-models-extra-info — Pi coding agent extension
 *
 * Renders an interactive table of your enabled (scoped) models with:
 * model slug, input price, output price, context window, input modalities,
 * thinking levels, and Artificial Analysis coding benchmarks.
 *
 * Press Enter on a row to switch to that model.
 * Shortcut: Alt+E
 *
 * Environment variables:
 *   AA_API_KEY  — Artificial Analysis API key for coding index column (optional).
 *                 Get one at https://artificialanalysis.ai
 *                 Without it, the coding index column is omitted.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, getModels, getProviders } from "@earendil-works/pi-ai";
import { truncateToWidth, matchesKey, visibleWidth, Key } from "@earendil-works/pi-tui";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";

// ── Config ─────────────────────────────────────────────────────────────────
//
// The coding index column is powered by the Artificial Analysis API:
//   https://artificialanalysis.ai/api/v2/data/llms/models
//
// When AA_API_KEY is set, the extension fetches AI coding benchmark scores
// and caches them locally for 24 hours. Without the key, the coding column
// is simply absent — everything else works the same.
//

const AA_API_KEY = process.env.AA_API_KEY || "";
const AA_API_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const AA_CACHE_DIR = homedir() + "/.cache/pi/scoped-models-extra-info";
const AA_CACHE_FILE = AA_CACHE_DIR + "/aa-models.json";
const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Model data helpers ─────────────────────────────────────────────────────

interface ModelRow {
	slug: string;
	inputPrice: number | null;
	outputPrice: number | null;
	contextWindow: number | null;
	codingIndex: string;
	codingSortValue: number;
	thinkingLevels: string;
	inputModalities: string;
	provider: string;
	modelId: string;
	isFree: boolean;
}

function getSlug(model: { provider: string; id: string; name: string }): string {
	const shortId = model.id.startsWith("~") ? model.id.slice(1) : model.id;
	return `${model.provider}/${shortId}`;
}

/** Split "provider/modelId" into [provider, modelId]. Returns ["", text] when no slash found. */
function splitPath(path: string): [string, string] {
	const slash = path.indexOf("/");
	if (slash < 0) return ["", path];
	return [path.slice(0, slash), path.slice(slash + 1)];
}

/** Strip hyphens and lowercase so we can match pi provider names against AA creator slugs. */
function normalizeProvider(name: string): string {
	return name.replace(/-/g, "").toLowerCase();
}

/**
 * Resolve the thinking levels a model supports.
 *
 * Some models (especially OpenRouter proxies) don't advertise their
 * thinking capabilities directly — they inherit a `thinkingLevelMap`
 * from the native model they proxy. This function tracks it down:
 *
 *   1. If the model already has a thinkingLevelMap, use it directly.
 *   2. Otherwise, extract the provider and short name from the model
 *      ID (e.g. "google/gemma-4-31b-it" → provider="google",
 *      short="gemma-4-31b-it") and search pi's model registry for
 *      a native model with that name that does have a thinkingLevelMap.
 *   3. Try the provider as-is, then a normalized version (no hyphens),
 *      then all other providers as a last resort.
 */
function resolveThinkingLevels(model: { reasoning: boolean; id: string; thinkingLevelMap?: Record<string, string | null> }): string[] {
	if (model.thinkingLevelMap) {
		return getSupportedThinkingLevels(model as any);
	}

	const slashIdx = model.id.indexOf("/");
	if (slashIdx <= 0) return getSupportedThinkingLevels(model as any);

	const rawProvider = model.id.slice(0, slashIdx);
	const shortName = model.id.slice(slashIdx + 1);

	const findInProvider = (provider: string) => {
		const nativeModels = getModels(provider as any);
		return nativeModels.find((m: any) => m.id === shortName && m.thinkingLevelMap);
	};

	const tryLevels = (provider: string): string[] | undefined => {
		const native = findInProvider(provider);
		if (!native) return;
		return getSupportedThinkingLevels({ ...model, thinkingLevelMap: native.thinkingLevelMap } as any);
	};

	let result = tryLevels(rawProvider);
	if (result) return result;

	const normProvider = normalizeProvider(rawProvider);
	if (normProvider !== rawProvider.toLowerCase()) {
		result = tryLevels(normProvider);
		if (result) return result;
	}

	for (const prov of getProviders()) {
		if (prov === rawProvider || prov === normProvider) continue;
		result = tryLevels(prov);
		if (result) return result;
	}

	return getSupportedThinkingLevels(model as any);
}

const THINKING_LEVEL_SLOTS: ReadonlyArray<[string, number]> = [
	["off", 4],
	["minimal", 8],
	["low", 4],
	["medium", 7],
	["high", 5],
	["xhigh", 6],
	["max", 4],
];

function getThinkingLevelsLabel(model: { reasoning: boolean }, levels: string[]): string {
	if (!model.reasoning) return "—";
	const levelSet = new Set(levels);
	let result = "";
	for (const [level, width] of THINKING_LEVEL_SLOTS) {
		if (levelSet.has(level)) {
			result += level.padEnd(width);
		} else {
			result += " ".repeat(width);
		}
	}
	return result;
}

function getInputModalitiesLabel(modalities: string[] | undefined | null): string {
	if (Array.isArray(modalities) && modalities.includes("image")) return "text+img";
	return "text";
}

function formatPrice(price: number | null | undefined): string {
	if (price == null || typeof price !== "number" || !Number.isFinite(price)) return "—";
	if (price >= 10) {
		return `$${Math.round(price)}`;
	}
	return `$${price.toFixed(2)}`;
}

function formatContextWindow(window: number | null | undefined): string {
	if (window == null || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return "—";
	if (window >= 1_000_000) {
		return `${(window / 1_000_000).toFixed(1)}M`;
	}
	return `${Math.round(window / 1000)}K`;
}

function isFreeModelLocal(model: { _freeKnown?: boolean; _isFree?: boolean; _pricingKnown?: boolean; cost?: { input?: number | null; output?: number | null } | null; name?: string; id?: string }): boolean {
	if ((model as any)._freeKnown === true) return (model as any)._isFree === true;
	const name = ((model as any).name ?? (model as any).id ?? "").toLowerCase();
	const hasFreeInName = name.includes("free");
	if ((model as any)._pricingKnown === false) return hasFreeInName;
	const isZeroCost = ((model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0);
	return isZeroCost || hasFreeInName;
}

/** Fit plain text into a fixed-width cell (truncate then pad). */
function padVisibleLeft(text: string, width: number): string {
	const cur = visibleWidth(text);
	const needed = width - cur;
	if (needed > 0) return " ".repeat(needed) + text;
	return text;
}

function padVisibleRight(text: string, width: number): string {
	const cur = visibleWidth(text);
	const needed = width - cur;
	if (needed > 0) return text + " ".repeat(needed);
	return text;
}

/** Simple truncation that cuts text at maxWidth visible columns without adding "...". */
function truncatePlain(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let result = "";
	let w = 0;
	for (const ch of text) {
		const cw = visibleWidth(ch);
		if (w + cw > maxWidth) break;
		result += ch;
		w += cw;
	}
	return result;
}

function fitCell(text: string, width: number, align: "left" | "right" = "left"): string {
	const fitted = truncatePlain(text, width);
	return align === "right" ? padVisibleLeft(fitted, width) : padVisibleRight(fitted, width);
}

// ── Artificial Analysis coding benchmark data ─────────────────────────────
//
// The Artificial Analysis dataset has one entry per model+thinking-level
// combination, e.g. "deepseek-v3-0324" or "kimi-k2-6-low". Each entry has
// a coding index score (0-100) and the model creator info.
//
// We parse this into a Map<"provider/baseSlug", Map<thinkingLevel, score>>
// then use a multi-strategy matching algorithm (see findLevelMap) to
// connect pi model IDs to AA scores.
//
// Key challenge: pi model IDs and AA slugs don't follow the same naming
// conventions. For example pi has "kimi-k2-7-code" but AA only has
// "kimi-k2" (original) and "kimi-k2-6" (v2.6). The matching below
// handles these cases with a two-direction prefix search guarded
// by suffix validation (see validPrefixSuffix).

interface AAModelEntry {
	name: string;
	slug: string;
	model_creator: { name: string; slug?: string };
	evaluations: { artificial_analysis_coding_index?: number };
}

/** Slug suffix → pi thinking level mapping (longest-first). */
const SUFFIX_TO_LEVEL: ReadonlyArray<{ suffix: string; level: string }> = [
	{ suffix: "-non-reasoning-low-effort", level: "off" },
	{ suffix: "-non-reasoning-high-effort", level: "off" },
	{ suffix: "-non-reasoning", level: "off" },
	{ suffix: "-minimal", level: "minimal" },
	{ suffix: "-low-effort", level: "low" },
	{ suffix: "-low", level: "low" },
	{ suffix: "-medium", level: "medium" },
	{ suffix: "-high-effort", level: "high" },
	{ suffix: "-high", level: "high" },
	{ suffix: "-xhigh-effort", level: "xhigh" },
	{ suffix: "-xhigh", level: "xhigh" },
	{ suffix: "-max-effort", level: "max" },
	{ suffix: "-max", level: "max" },
];

/** Wider slots for coding column: "level(99.9)" per slot, +1 for spacing */
const CODING_SLOTS: ReadonlyArray<[string, number]> = [
	["off", 10],
	["minimal", 14],
	["low", 10],
	["medium", 13],
	["high", 11],
	["xhigh", 12],
	["max", 12],
];

/** per-model: baseKey → Map<thinkingLevel, codingIndex> */
type AAModelLevels = Map<string, Map<string, number>>;

let aaModelData: AAModelLevels | null = null;

/** Extract base slug and pi thinking level from an AA entry slug. */
function parseEntryLevel(slug: string, name: string): { baseSlug: string; level: string } | null {
	const s = slug.toLowerCase();
	const n = name.toLowerCase();

	// "-max" is ambiguous: it can be a thinking-effort suffix, but it is
	// also part of model names such as Qwen3.8 Max. Only treat it as an
	// effort suffix when the display name explicitly identifies max effort.
	const maxIsModelName =
		s.endsWith("-max") &&
		!/\(\s*max\s*\)/.test(n) &&
		!/\bmax[- ]effort\b/.test(n);

	for (const { suffix, level } of SUFFIX_TO_LEVEL) {
		// Do not strip the model-name "-max" suffix (for example,
		// "qwen3-8-max"). Other effort suffixes remain unaffected.
		if (maxIsModelName && suffix === "-max") continue;
		if (s.endsWith(suffix)) {
			const base = s.slice(0, -suffix.length);
			if (base.length > 0) return { baseSlug: base, level };
		}
	}
	// No known slug suffix — check name for reasoning-mode hints
	const nameLevelRe = /\(\s*(minimal|low|medium|high|xhigh|max|non.reasoning|non reasoning|reasoning)\s*\)/;
	const nameMatch = n.match(nameLevelRe);
	if (nameMatch) {
		const raw = nameMatch[1].replace(/[^a-z]/g, "");
		const level = raw === "nonreasoning" ? "off" : raw === "reasoning" ? "high" : raw;
		return { baseSlug: s, level };
	}
	// Check for "Max Effort" (maps to max)
	if (n.includes("max effort")) {
		return { baseSlug: s, level: "max" };
	}
	// Final fallback: high — most reasoning models default here, xhigh only when specified
	return { baseSlug: s, level: "high" };
}

function buildAAModelData(data: AAModelEntry[]): AAModelLevels {
	const map: AAModelLevels = new Map();
	for (const entry of data) {
		const ci = entry.evaluations?.artificial_analysis_coding_index;
		if (ci == null) continue;
		const parsed = parseEntryLevel(entry.slug, entry.name);
		if (!parsed) continue;
		const key = `${(entry.model_creator.slug ?? entry.model_creator.name).toLowerCase()}/${parsed.baseSlug}`;
		let levelMap = map.get(key);
		if (!levelMap) {
			levelMap = new Map();
			map.set(key, levelMap);
		}
		// Keep highest CI when the same base+level appears in multiple AA entries
		const existing = levelMap.get(parsed.level);
		if (existing === undefined || ci > existing) {
			levelMap.set(parsed.level, ci);
		}
	}
	return map;
}

/**
 * Match a pi model (provider + ID) against the AA dataset to find its
 * per-thinking-level coding index scores.
 *
 * The matching is a multi-strategy fallback chain because pi model IDs
 * and AA slugs use different naming conventions:
 *
 *   1. Exact match with the pi provider ("openrouter" → "provider/key")
 *   2. If model ID contains a sub-provider (e.g. "deepseek/deepseek-v3"),
 *      extract it and try exact + prefix matching
 *   3. Prefix matching with the pi provider (catches version suffixes
 *      like "deepseek-v3" vs "deepseek-v3-0324")
 *   4. Common provider aliases ("qwen" → "alibaba", "moonshotai" → "kimi")
 *   5. Cleaned names (strip ":free", "-latest") then retry all of the above
 *
 * Each step uses validPrefixSuffix to avoid false matches — see the
 * tryPrefix function for details on the two-direction search.
 */
function findLevelMap(
	provider: string,
	modelId: string,
	data: AAModelLevels,
): Map<string, number> | undefined {
	const p = provider.toLowerCase();
	const mid = modelId.toLowerCase().replace(/\./g, "-");

	/** Model variant suffixes that AA systematically omits from slugs. */
	const OMITTED_VARIANT_SUFFIXES = ["-it", "-instruct", "-chat"];

	/** Collect normalized forms (with date and variant suffix stripping) for a model name. */
	const normalForms = (name: string): string[] => {
		const r = [name];
		// Strip date suffixes: -2025-01-01-1 or -20250101
		const s1 = name.replace(/-\d{4}-\d{2}-\d{2}(?:-\d+)?$/, "");
		if (s1 !== name) r.push(s1);
		const s2 = name.replace(/-\d{8}$/, "");
		if (s2 !== name && s2 !== s1) r.push(s2);
		// Strip common model variant suffixes that AA omits (e.g. "-it", "-instruct", "-chat")
		// AA entry slugs never include these suffixes, but pi/OpenRouter model IDs often do.
		for (const suffix of OMITTED_VARIANT_SUFFIXES) {
			if (name.endsWith(suffix)) {
				const stripped = name.slice(0, -suffix.length);
				if (!r.includes(stripped)) r.push(stripped);
			}
		}
		return r;
	};

	/** Try exact lookup with a given (provider, model) pair. */
	const tryLookup = (pr: string, md: string): Map<string, number> | undefined => {
		for (const c of normalForms(md)) {
			const found = data.get(`${pr}/${c}`);
			if (found) return found;
		}
		return undefined;
	};

	/**
	 * Gateway providers (such as opencode-go) expose canonical model IDs
	 * without the upstream creator in the provider name. If an exact model
	 * slug identifies one AA creator unambiguously, use that match as a safe
	 * provider-agnostic fallback.
	 */
	const getUniqueMatch = (matches: Set<Map<string, number>>): Map<string, number> | undefined => {
		if (matches.size !== 1) return undefined;
		let onlyMatch: Map<string, number> | undefined;
		matches.forEach((match) => { onlyMatch = match; });
		return onlyMatch;
	};

	const tryLookupAnyCreator = (md: string): Map<string, number> | undefined => {
		const matches = new Set<Map<string, number>>();
		for (const c of normalForms(md)) {
			const suffix = `/${c}`;
			data.forEach((value, key) => {
				if (key.endsWith(suffix)) matches.add(value);
			});
		}
		return getUniqueMatch(matches);
	};

	/**
	 * Prefix match is only valid when the pi model name suffix after the AA slug
	 * is a version/checkpoint suffix (only dashes and digits starting with -N),
	 * a known AA naming variant, or empty — not a sub-model name like
	 * "-7-code". This prevents false matches like K2 → K2.7-Code while allowing
	 * DeepSeek-V3 → DeepSeek-V3-0324 and Qwen3.8 Flash → Qwen3.8-Flash-Next.
	 */
	const KNOWN_AA_VARIANT_SUFFIXES = new Set(["-next"]);
	const validPrefixSuffix = (rest: string): boolean =>
		rest === "" || /^-\d[\d-]*$/.test(rest) || KNOWN_AA_VARIANT_SUFFIXES.has(rest);

	/** Try prefix matching with a given (provider, model) pair. */
	const tryPrefix = (pr: string, md: string): Map<string, number> | undefined => {
		const prefix = pr + "/";
		const norm = normalForms(md);

		const findFirst = (
			predicate: (aaSlug: string, val: Map<string, number>) => boolean,
		): Map<string, number> | undefined => {
			let found: Map<string, number> | undefined;
			data.forEach((val, key) => {
				if (found) return;
				if (!key.startsWith(prefix)) return;
				const aaSlug = key.slice(prefix.length);
				if (predicate(aaSlug, val)) found = val;
			});
			return found;
		};

		// Direction 1: pi model name starts with AA slug
		const r1 = findFirst((aaSlug) =>
			md.startsWith(aaSlug) && validPrefixSuffix(md.slice(aaSlug.length)),
		);
		if (r1) return r1;

		// Direction 2: AA slug starts with pi model name
		return findFirst((aaSlug) =>
			norm.some((c) => aaSlug.startsWith(c) && validPrefixSuffix(aaSlug.slice(c.length))),
		);
	};

	/** Prefix fallback for gateway providers without a creator mapping. */
	const tryPrefixAnyCreator = (md: string): Map<string, number> | undefined => {
		const norm = normalForms(md);
		const matches = new Set<Map<string, number>>();
		data.forEach((value, key) => {
			const slash = key.indexOf("/");
			if (slash < 0) return;
			const aaSlug = key.slice(slash + 1);
			const piStartsAA = md.startsWith(aaSlug) && validPrefixSuffix(md.slice(aaSlug.length));
			const aaStartsPi = norm.some((c) =>
				aaSlug.startsWith(c) && validPrefixSuffix(aaSlug.slice(c.length)),
			);
			if (piStartsAA || aaStartsPi) matches.add(value);
		});
		return getUniqueMatch(matches);
	};

	// 1. Try pi's provider directly (e.g. openrouter/deepseek-v4-flash)
	const hit1 = tryLookup(p, mid);
	if (hit1) return hit1;

	// 2. ModelId may contain a sub-provider, e.g. "deepseek/deepseek-v4-flash"
	const slashIdx = mid.indexOf("/");
	if (slashIdx >= 0) {
		const rawProvider = mid.slice(0, slashIdx);
		const rawModel = mid.slice(slashIdx + 1);
		const realProvider = rawProvider.replace(/^~/, "");
		const hit2 = tryLookup(realProvider, rawModel);
		if (hit2) return hit2;
		const hit3 = tryPrefix(realProvider, rawModel);
		if (hit3) return hit3;
	}

	// 3. Fallback: prefix matching with pi's provider
	const hit4 = tryPrefix(p, mid);
	if (hit4) return hit4;

	// 4. Try common provider aliases (e.g. openai-codex → openai)
	const aliasMap: Record<string, string> = {
		"openai-codex": "openai",
		"qwen": "alibaba",
		"moonshotai": "kimi",
		"arcee-ai": "arcee ai",
		"z-ai": "zai",
	};
	const alias = aliasMap[p];
	if (alias) {
		const hit5 = tryLookup(alias, mid);
		if (hit5) return hit5;
	}
	// Also try sub-provider aliased (e.g. qwen → alibaba)
	if (slashIdx >= 0) {
		const rawProvider = mid.slice(0, slashIdx);
		const rawModel = mid.slice(slashIdx + 1);
		const realProvider = rawProvider.replace(/^~/, "");
		const subAlias = aliasMap[realProvider];
		if (subAlias) {
			const hit6 = tryLookup(subAlias, rawModel);
			if (hit6) return hit6;
			const hit6b = tryPrefix(subAlias, rawModel);
			if (hit6b) return hit6b;
		}
		// Also try stripped-hyphen provider (e.g. "z-ai" → "zai")
		const strippedProvider = realProvider.replace(/-/g, "");
		if (strippedProvider !== realProvider) {
			const hit6c = tryLookup(strippedProvider, rawModel);
			if (hit6c) return hit6c;
			const hit6d = tryPrefix(strippedProvider, rawModel);
			if (hit6d) return hit6d;
		}
	}

	// Gateway providers may not have a creator alias. An exact, unique
	// model-slug match is still safe and covers those provider catalogs.
	const sourceModel = slashIdx >= 0 ? mid.slice(slashIdx + 1) : mid;
	const hitAnyCreator = tryLookupAnyCreator(sourceModel);
	if (hitAnyCreator) return hitAnyCreator;
	const hitAnyCreatorPrefix = tryPrefixAnyCreator(sourceModel);
	if (hitAnyCreatorPrefix) return hitAnyCreatorPrefix;

	// 5. Clean model name (strip ":free", "-latest" etc.) and retry
	const cleanMid = mid.replace(/:.*$/, "").replace(/-latest$/, "");
	if (cleanMid !== mid) {
		const hit7 = tryLookup(p, cleanMid);
		if (hit7) return hit7;
		if (slashIdx >= 0) {
			const rawProvider = mid.slice(0, slashIdx);
			const rawModel = mid.slice(slashIdx + 1);
			const cleanModel = rawModel.replace(/:.*$/, "").replace(/-latest$/, "");
			const realProvider = rawProvider.replace(/^~/, "");
			const hit8 = tryLookup(realProvider, cleanModel);
			if (hit8) return hit8;
			const hit9 = tryPrefix(realProvider, cleanModel);
			if (hit9) return hit9;
			const subAlias = aliasMap[realProvider];
			if (subAlias) {
				const hit10 = tryLookup(subAlias, cleanModel);
				if (hit10) return hit10;
			}
		}
	}

	return undefined;
}

/**
 * Format level→CI map as display string + sort value.
 *
 * The algorithm walks CODING_SLOTS from highest effort (max) down to
 * lowest (off), carrying AA data from unsupported levels and depositing
 * it into the nearest lower slot pi supports.
 *
 * For example: if AA scored `glm-5-2-max` but pi caps at `xhigh` for
 * this model, the max score is shown under the `xhigh` label. The
 * thinking column independently reflects what pi actually supports.
 *
 * Sort priority: prefer the "high" level CI if available (the most
 * common reasoning level, and the most comparable across models).
 * Otherwise fall back to the highest-priority supported level with
 * data — max > xhigh > medium > low > minimal > off. The fallback also
 * honors carry values, so an xhigh-only model whose only AA entry is a
 * max score (GLM 5.2) sorts by the carried xhigh value the user sees.
 */
function formatCodingData(
	levelMap: Map<string, number>,
	supportedLevels?: Set<string>,
): { display: string; sortValue: number } {
	let display = "";
	let sortValue = -1;
	let carry: number | undefined;
	// Carry values that were consumed by a supported slot. Lets the
	// fallback honor "the value the user actually sees" when "high"
	// data is absent (e.g. xhigh-only model with max carry).
	const inherited = new Map<string, number>();

	for (let i = CODING_SLOTS.length - 1; i >= 0; i--) {
		const [level, width] = CODING_SLOTS[i];
		const direct = levelMap.get(level);

		if (supportedLevels && !supportedLevels.has(level)) {
			// Not shown — remember any AA data as carry for the nearest
			// lower slot that pi does support.
			if (direct != null) carry = direct;
			display = " ".repeat(width) + display;
			continue;
		}

		// Use direct AA data or the carry from a higher unsupported level
		const ci = direct ?? carry;
		if (ci != null) {
			display = `${level}(${ci.toFixed(1)})`.padEnd(width) + display;
			if (level === "high") sortValue = ci;
			if (carry != null) inherited.set(level, carry);
		} else {
			display = " ".repeat(width) + display;
		}
		carry = undefined; // consumed — one spill per orphan
	}

	if (sortValue < 0) {
		// Fall back to the highest-priority supported level with data.
		// Both the direct levelMap entry and any carried value count;
		// direct wins.
		for (const level of ["max", "xhigh", "medium", "low", "minimal", "off"]) {
			if (supportedLevels && !supportedLevels.has(level)) continue;
			const ci = levelMap.get(level) ?? inherited.get(level);
			if (ci != null) { sortValue = ci; break; }
		}
	}
	return { display, sortValue };
}

//
// ── Caching strategy ────
//
// AA data is fetched from the API and cached to disk for 24 hours.
// The design prioritizes not blocking the UI over data freshness:
//
//   initAAData()  — called synchronously when the table opens.
//                   Tries to load from cache. If cache is stale,
//                   fires a background refresh (fire-and-forget,
//                   never awaited). If no cache exists, also fires
//                   a background fetch. Returns immediately.
//
//   fetchAAData() — the actual async HTTP fetch. Writes to cache
//                   on success, falls back to stale cache on error.
//
//   loadStaleCache() — shared helper: tries to read whatever is on
//                      disk. Used in fetchAAData's error paths.
//
// Result: the first open shows whatever data is cached (or no data),
// and the table auto-updates on the next open after the fetch completes.
//

function loadStaleCache(): void {
	try {
		const raw = readFileSync(AA_CACHE_FILE, "utf-8");
		aaModelData = buildAAModelData(JSON.parse(raw) as AAModelEntry[]);
	} catch { /* no cache file yet */ }
}

async function fetchAAData(): Promise<void> {
	if (!AA_API_KEY) return;
	try {
		const resp = await fetch(AA_API_URL, { headers: { "x-api-key": AA_API_KEY } });
		if (!resp.ok) {
			loadStaleCache();
			return;
		}
		const json = await resp.json();
		const data = json.data as AAModelEntry[];
		aaModelData = buildAAModelData(data);
		try {
			mkdirSync(AA_CACHE_DIR, { recursive: true });
			writeFileSync(AA_CACHE_FILE, JSON.stringify(data));
		} catch { /* cache write failure is non-fatal */ }
	} catch {
		loadStaleCache();
	}
}

function initAAData(): void {
	if (!AA_API_KEY) return;
	try {
		const raw = readFileSync(AA_CACHE_FILE, "utf-8");
		aaModelData = buildAAModelData(JSON.parse(raw) as AAModelEntry[]);
		// Cache exists — if stale, refresh in background.
		try {
			const s = statSync(AA_CACHE_FILE);
			if (Date.now() - s.mtimeMs >= AA_CACHE_TTL_MS) {
				fetchAAData(); // fire-and-forget
			}
		} catch { /* stat failed, ignore */ }
	} catch { /* no cache file */
		fetchAAData(); // fire-and-forget
	}
}

//
// ── Terminal table component ───────────────────────────────────────────────
//
// The table is rendered as a custom TUI widget via pi's ctx.ui.custom() API.
// Pi's TUI engine calls:
//   render(width)   → get display lines
//   handleInput(k)  → process a keypress
//   invalidate()    → mark cached lines dirty so render() rebuilds
//
// The component owns the data, scroll position, selection, sort state,
// and a line cache. It's fully self-contained — no external deps.
//

type SortColumn = "name" | "input" | "output" | "coding";

class ExtraInfoTable {
	private allRows: ModelRow[];
	private rows: ModelRow[];
	private theme: Theme;
	private done: (value: string | undefined) => void;
	private scrollOffset = 0;
	selectedIndex = 0;
	private sortColumn: SortColumn = "output";
	private sortDirection: "asc" | "desc" = "asc";
	private cachedLines: string[] | undefined;
	private terminalRows: number;
	private freeOnly = false;

	constructor(
		rows: ModelRow[],
		theme: Theme,
		done: (value: string | undefined) => void,
		terminalRows?: number,
	) {
		this.allRows = [...rows];
		this.rows = rows;
		this.theme = theme;
		this.done = done;
		this.terminalRows = terminalRows ?? (typeof process !== "undefined" && (process.stdout as any)?.rows) ?? 30;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}

		// ── Sort shortcuts ──
		if (matchesKey(data, "n")) {
			this.sortBy("name");
			return;
		}
		if (matchesKey(data, "i")) {
			this.sortBy("input");
			return;
		}
		if (matchesKey(data, "o")) {
			this.sortBy("output");
			return;
		}
		if (matchesKey(data, "c")) {
			this.sortBy("coding");
			return;
		}

		if (matchesKey(data, "f")) {
			this.toggleFreeOnly();
			return;
		}

		// ── Navigation ──
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			this.selectedIndex = this.rows.length - 1;
			this.scrollOffset = Math.max(0, this.rows.length - this.maxVisibleRows());
			this.invalidate();
			return;
		}

		if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleRows());
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f") || matchesKey(data, "ctrl+d")) {
			this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + this.maxVisibleRows());
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "space")) {
			const row = this.rows[this.selectedIndex];
			if (!row) return;
			this.done(`${row.provider}/${row.modelId}`);
			return;
		}
	}

	private sortBy(column: SortColumn): void {
		if (this.sortColumn === column) {
			// Toggle direction
			this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
		} else {
			this.sortColumn = column;
			this.sortDirection = "asc";
		}

		const dir = this.sortDirection === "asc" ? 1 : -1;
		const cmpFn = (a: ModelRow, b: ModelRow) => {
			let cmp: number;
			switch (column) {
				case "name":
					cmp = a.slug.localeCompare(b.slug);
					break;
				case "input":
					cmp = (a.inputPrice ?? Number.POSITIVE_INFINITY) - (b.inputPrice ?? Number.POSITIVE_INFINITY);
					break;
				case "output":
					cmp = (a.outputPrice ?? Number.POSITIVE_INFINITY) - (b.outputPrice ?? Number.POSITIVE_INFINITY);
					break;
				case "coding":
					cmp = a.codingSortValue - b.codingSortValue;
					break;
			}
			return cmp * dir;
		};
		this.allRows.sort(cmpFn);
		this.rows.sort(cmpFn);

		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.invalidate();
	}

	private toggleFreeOnly(): void {
		this.freeOnly = !this.freeOnly;
		if (this.freeOnly) {
			const freeRows = this.allRows.filter((r) => r.isFree);
			// Keep current sort order; if no free models, keep empty but allow toggle back
			this.rows = freeRows;
		} else {
			this.rows = [...this.allRows];
		}
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.invalidate();
	}

	private maxVisibleRows(): number {
		// Reserve lines for header (blank+header+separator+filter) + footer (blank+hint+separator)
		const overhead = 9;
		const available = this.terminalRows - overhead;
		// Clamp to sensible range: at least 5 rows, at most 30 so table stays readable on tall terminals
		const capped = Math.max(5, Math.min(30, available));
		return Math.min(this.rows.length, capped);
	}

	ensureVisible(): void {
		const maxVis = this.maxVisibleRows();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + maxVis) {
			this.scrollOffset = this.selectedIndex - maxVis + 1;
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;

		const t = this.theme;
		const accent = (s: string) => t.fg("accent", s);
		const text = (s: string) => t.fg("text", s);
		const dim = (s: string) => t.fg("dim", s);
		const success = (s: string) => t.fg("success", s);

		const arrow = this.sortDirection === "asc" ? ">" : "<";

		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// Column widths (visible character counts)
		const colSlug = 50;
		const colIn = 7;
		const colOut = 8;
		const colCtx = 7;
		const colCode = 82;
		const colThink = 38;
		const colMod = 10;

		// Build separator AFTER deciding column widths (so we can compute total)
		const sep = " | ";
		const rowWidth = colSlug + colIn + colOut + colCtx + colCode + colThink + colMod + sep.length * 6;

		// ── Header ──
		add("");

		interface HeaderCellDef { label: string; col: SortColumn | null; width: number; align: "left" | "right" }
		const headerDefs: HeaderCellDef[] = [
			{ label: "Model", col: "name", width: colSlug, align: "left" },
			{ label: "Input$", col: "input", width: colIn, align: "right" },
			{ label: "Output$", col: "output", width: colOut, align: "right" },
			{ label: "Context", col: null, width: colCtx, align: "right" },
			{ label: "Modalities", col: null, width: colMod, align: "left" },
			{ label: "Thinking", col: null, width: colThink, align: "left" },
			{ label: "Coding index", col: "coding", width: colCode, align: "left" },
		];

		const headerCells = headerDefs.map(({ label, col, width, align }) => {
			const isSorted = col !== null && this.sortColumn === col;
			const content = fitCell(isSorted ? label + success(arrow) : label, width, align);
			return isSorted ? accent(content) : dim(content);
		});
		add("  " + headerCells.join(sep));

		// Separator line
		add(dim("  " + "-".repeat(Math.min(width, rowWidth))));

		// ── Free filter status ──
		if (this.freeOnly) {
			add(accent(`  ◆ FREE only ${this.rows.length}/${this.allRows.length} — press f to show all`));
		} else {
			const freeCount = this.allRows.filter((r) => r.isFree).length;
			if (freeCount > 0 && freeCount < this.allRows.length) {
				add(dim(`  f: filter free (${freeCount}/${this.allRows.length})`));
			}
		}

		// ── Data rows (viewport with paging) ──
		const maxVisible = this.maxVisibleRows();
		const endIndex = Math.min(this.scrollOffset + maxVisible, this.rows.length);
		if (this.rows.length === 0) {
			add(dim("  (no models match filter — press f to toggle)"));
		} else {
			if (this.scrollOffset > 0) {
				add(dim(`  ↑ ${this.scrollOffset} more above`));
			}
			for (let i = this.scrollOffset; i < endIndex; i++) {
				const row = this.rows[i];
				const isSelected = i === this.selectedIndex;

				const slugCell = fitCell(row.slug, colSlug, "left");
				const inCell = fitCell(formatPrice(row.inputPrice), colIn, "right");
				const outCell = fitCell(formatPrice(row.outputPrice), colOut, "right");
				const ctxCell = fitCell(formatContextWindow(row.contextWindow), colCtx, "right");
				const modCell = fitCell(row.inputModalities, colMod, "left");
				const thinkCell = fitCell(row.thinkingLevels, colThink, "left");
				const codeCell = fitCell(row.codingIndex, colCode, "left");

				let plainRow = [slugCell, inCell, outCell, ctxCell, modCell, thinkCell, codeCell].join(sep);
				plainRow = truncateToWidth(plainRow, rowWidth);

				if (isSelected) {
					add(accent("> " + plainRow));
				} else {
					add("  " + text(plainRow));
				}
			}
			if (endIndex < this.rows.length) {
				add(dim(`  ↓ ${this.rows.length - endIndex} more below`));
			}
		}

		// ── Footer ──
		add("");
		let scrollInfo: string;
		if (this.rows.length === 0) {
			scrollInfo = this.freeOnly ? `0 free / ${this.allRows.length} total` : "0 models";
		} else if (this.rows.length > this.maxVisibleRows()) {
			scrollInfo = `${this.selectedIndex + 1}/${this.rows.length}`;
			if (this.freeOnly) scrollInfo += ` (FREE ${this.rows.length}/${this.allRows.length})`;
		} else {
			scrollInfo = `${this.rows.length} models`;
			if (this.freeOnly) scrollInfo = `FREE ${this.rows.length}/${this.allRows.length}`;
		}
		const filterHint = this.freeOnly ? "f free:ON" : "f free";
		const footerText = `  ↑↓/jk PgUp/Dn navigate  •  n/i/o/c sort  •  ${filterHint}  •  Enter select  •  q/Esc  •  ${scrollInfo}`;
		add(dim(footerText));
		add(dim("  " + "-".repeat(Math.min(width, rowWidth))));

		this.cachedLines = lines;
		return lines;
	}
}

//
// ── Extension registration ─────────────────────────────────────────────────
//
// Registers a command and a keyboard shortcut (Ctrl+Alt+F), both of which
// open the interactive scoped-models table. The shortcut is the primary
// entry point for most users.
//
// The flow:
//   1. Read enabled models from pi's settings (enabledModels)
//   2. Initialize AA data from cache (or fire background fetch)
//   3. Build ModelRow[] with pricing, thinking levels, benchmarks
//   4. Show the interactive table via ctx.ui.custom()
//   5. If user picks a model (Enter), switch to it via pi.setModel()
//

export default function (pi: ExtensionAPI) {
	pi.registerCommand("scoped-models-extra-info", {
		description:
			"Render table of scoped models with prices, context window, thinking levels, and modalities",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showScopedModelsTable(pi, ctx);
		},
	});

	pi.registerShortcut(Key.alt("e"), {
		description: "Open scoped models table",
		handler: async (ctx: ExtensionContext) => {
			await showScopedModelsTable(pi, ctx);
		},
	});
}

async function showScopedModelsTable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Command requires interactive mode", "error");
		return;
	}

	// Read enabled models from settings
	const sm = SettingsManager.create(ctx.cwd);
	const allModels = ctx.modelRegistry.getAvailable();

	// Build a lookup by "provider/id"
	const modelLookup = new Map<string, (typeof allModels)[0]>();
	for (const m of allModels) {
		modelLookup.set(`${m.provider}/${m.id}`, m);
	}

	const globalSettings = sm.getGlobalSettings();
	const enabledPatterns = globalSettings.enabledModels;

	let matchedModels: typeof allModels;

	if (!enabledPatterns || enabledPatterns.length === 0) {
		matchedModels = allModels;
	} else {
		matchedModels = [];

		for (const pattern of enabledPatterns) {
			const [provider, modelId] = splitPath(pattern);
			if (!provider) continue;

			const key = `${provider}/${modelId}`;
			let model = modelLookup.get(key);

			if (!model) {
				model = allModels.find((m) => m.provider === provider && m.id === modelId);
			}

			if (model) {
				matchedModels.push(model);
			}
		}
	}

	// Filter out models whose slug starts with "router/"
	matchedModels = matchedModels.filter((m) => !getSlug(m).startsWith("router/"));

	if (matchedModels.length === 0) {
		ctx.ui.notify("No available models found", "warning");
		return;
	}

	initAAData();

	// Build rows
	const rows = buildRows(matchedModels, aaModelData);

	// Pre-select the currently active model, if it's in the list
	let initialIndex = 0;
	if (ctx.model) {
		const currentSlug = `${ctx.model.provider}/${ctx.model.id}`;
		const found = rows.findIndex((r) => r.slug === currentSlug);
		if (found >= 0) initialIndex = found;
	}

	// Show interactive table — pass terminal height so table can page and fit on screen
	const selectedPath = await ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) => {
			const termRows =
				(tui as unknown as { terminal?: { rows?: number } })?.terminal?.rows ??
				(typeof process !== "undefined" ? (process.stdout as unknown as { rows?: number })?.rows : undefined) ??
				30;
			const table = new ExtraInfoTable(rows, theme, done, termRows);
			table.selectedIndex = initialIndex;
			table.ensureVisible();
			return table;
		},
	);

	// If user selected a model (Enter/Space), switch to it
	if (selectedPath) {
		const [provider, modelId] = splitPath(selectedPath);

		const model = ctx.modelRegistry.find(provider, modelId);
		if (model) {
			const ok = await pi.setModel(model);
			if (ok) {
				ctx.ui.notify(`✓ Switched to ${provider}/${modelId}`, "info");
			} else {
				ctx.ui.notify(`✗ No API key available for ${provider}/${modelId}`, "error");
			}
		} else {
			ctx.ui.notify(`✗ Model ${selectedPath} not found in registry`, "error");
		}
	}
}

//
// ── Row building ───────────────────────────────────────────────────────────
//
// Converts pi's raw model objects into ModelRow display records.
// For each model it resolves thinking levels (with fallback for
// proxied models), looks up AA coding benchmarks, and formats
// prices/context into human-readable strings.
// Rows are sorted by output price ascending by default.
//

function buildRows(
	models: {
		provider: string;
		id: string;
		name: string;
		cost: { input: number | null; output: number | null; cacheRead: number; cacheWrite: number } | null | undefined;
		contextWindow: number | null | undefined;
		input: string[] | null | undefined;
		reasoning: boolean;
	}[],
	aaModelData: AAModelLevels | null,
): ModelRow[] {
	const rows: ModelRow[] = [];

	for (const model of models) {
		const levels = resolveThinkingLevels(model as any);

		// Look up artificial analysis coding index (across all thinking levels)
		let codingIndex = "—";
		let codingSortValue = -1;
		if (aaModelData) {
			const levelMap = findLevelMap(model.provider, model.id, aaModelData);
			if (levelMap) {
				const fmt = formatCodingData(levelMap, new Set(levels));
				codingIndex = fmt.display;
				codingSortValue = fmt.sortValue;
			}
		}

		rows.push({
			slug: getSlug(model),
			inputPrice: model.cost?.input ?? null,
			outputPrice: model.cost?.output ?? null,
			contextWindow: model.contextWindow ?? null,
			codingIndex,
			codingSortValue,
			thinkingLevels: getThinkingLevelsLabel(model, levels),
			inputModalities: getInputModalitiesLabel(model.input as string[] | null | undefined),
			provider: model.provider,
			modelId: model.id,
			isFree: isFreeModelLocal(model as any),
		});
	}

	// Sort by output price ascending (nulls last)
	rows.sort((a, b) => {
		const av = a.outputPrice ?? Number.POSITIVE_INFINITY;
		const bv = b.outputPrice ?? Number.POSITIVE_INFINITY;
		return av - bv;
	});
	return rows;
}
