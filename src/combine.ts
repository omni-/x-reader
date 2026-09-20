import type { ReadResult, Post } from "./schema.js";

/** First-seen order and records win; every observed version remains available by source index. */
export function combineSearchResults(results: ReadResult[]) {
  const posts = new Map<string, Post>();
  const matches = new Map<string, number[]>();
  results.forEach((result, index) => {
    if (!result.search)
      throw new Error("Expected search results with query and sort metadata.");
    for (const post of result.posts) {
      if (!posts.has(post.id)) posts.set(post.id, post);
      const sources = matches.get(post.id) ?? [];
      if (!sources.includes(index)) sources.push(index);
      matches.set(post.id, sources);
    }
  });
  return {
    posts: [...posts.values()],
    matches: [...matches].map(([post_id, search_indexes]) => ({
      post_id,
      search_indexes,
    })),
    searches: results,
    complete: false as const,
  };
}
