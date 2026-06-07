import { describe, expect, test } from "bun:test";
import {
	createCategory,
	normalizeCategorySettings,
	updateCategory,
} from "../../src/config/categories.ts";
import { DEFAULT_SETTINGS, settingsSchema } from "../../src/config/settings.ts";

describe("category settings", () => {
	test("schema defaults categories and defaultCategoryId", () => {
		const parsed = settingsSchema.parse({});

		expect(parsed.categories).toEqual([]);
		expect(parsed.defaultCategoryId).toBeNull();
	});

	test("creates stable unique category ids", () => {
		const anime = createCategory([], {
			name: " Anime ",
			savePath: "/media/anime",
		});
		const duplicate = createCategory([anime], {
			name: "Anime",
			savePath: null,
		});

		expect(anime).toEqual({
			id: "anime",
			name: "Anime",
			savePath: "/media/anime",
		});
		expect(duplicate.id).toBe("anime-2");
		expect(duplicate.name).toBe("Anime 2");
		expect(duplicate.savePath).toBeNull();
	});

	test("drops invalid default category references", () => {
		const normalized = normalizeCategorySettings({
			...DEFAULT_SETTINGS,
			categories: [{ id: "anime", name: "Anime", savePath: null }],
			defaultCategoryId: "missing",
		});

		expect(normalized.defaultCategoryId).toBeNull();
	});

	test("updates category name and path while keeping ids stable", () => {
		const anime = createCategory([], {
			name: "Anime",
			savePath: "/anime",
		});
		const movies = createCategory([anime], {
			name: "Movies",
			savePath: null,
		});

		const updated = updateCategory([anime, movies], anime.id, {
			name: "Movies",
			savePath: "",
		});

		expect(updated[0]).toEqual({
			id: "anime",
			name: "Movies 2",
			savePath: null,
		});
		expect(updated[1]).toEqual(movies);
	});
});
