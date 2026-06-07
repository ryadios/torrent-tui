import type { AppSettings, CategorySettings } from "./settings";

export interface CategoryInput {
	name: string;
	savePath?: string | null;
}

export function createCategory(
	existing: readonly CategorySettings[],
	input: CategoryInput,
): CategorySettings {
	const name = uniqueCategoryName(normalizeCategoryName(input.name), existing);
	const id = uniqueCategoryId(slugifyCategoryName(name), existing);
	return {
		id,
		name,
		savePath: normalizeCategorySavePath(input.savePath),
	};
}

export function updateCategory(
	existing: readonly CategorySettings[],
	id: string,
	input: CategoryInput,
): CategorySettings[] {
	const target = existing.find((category) => category.id === id);
	if (!target) return [...existing];
	const others = existing.filter((category) => category.id !== id);
	const name = uniqueCategoryName(normalizeCategoryName(input.name), others);
	return existing.map((category) =>
		category.id === id
			? {
					...category,
					name,
					savePath: normalizeCategorySavePath(input.savePath),
				}
			: category,
	);
}

export function normalizeCategories(
	categories: readonly CategorySettings[],
): CategorySettings[] {
	const normalized: CategorySettings[] = [];
	for (const category of categories) {
		const name = normalizeCategoryName(category.name);
		if (!name) continue;
		if (
			normalized.some(
				(existing) => existing.name.toLowerCase() === name.toLowerCase(),
			)
		) {
			continue;
		}
		const baseId = category.id.trim() || slugifyCategoryName(name);
		normalized.push({
			id: uniqueCategoryId(baseId, normalized),
			name,
			savePath: normalizeCategorySavePath(category.savePath),
		});
	}
	return normalized;
}

export function normalizeCategorySettings(settings: AppSettings): AppSettings {
	const categories = normalizeCategories(settings.categories);
	const defaultCategoryId = categories.some(
		(category) => category.id === settings.defaultCategoryId,
	)
		? settings.defaultCategoryId
		: null;
	return { ...settings, categories, defaultCategoryId };
}

export function normalizeCategoryName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}

export function normalizeCategorySavePath(path: string | null | undefined) {
	const trimmed = path?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}

function slugifyCategoryName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "category";
}

function uniqueCategoryId(
	baseId: string,
	existing: readonly CategorySettings[],
): string {
	const base = baseId || "category";
	const taken = new Set(existing.map((category) => category.id));
	if (!taken.has(base)) return base;
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) suffix++;
	return `${base}-${suffix}`;
}

function uniqueCategoryName(
	name: string,
	existing: readonly CategorySettings[],
): string {
	const base = name || "Category";
	const taken = new Set(
		existing.map((category) => category.name.trim().toLowerCase()),
	);
	if (!taken.has(base.toLowerCase())) return base;
	let suffix = 2;
	while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix++;
	return `${base} ${suffix}`;
}
