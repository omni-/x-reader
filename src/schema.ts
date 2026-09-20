import { z } from "zod";

export const mediaSchema = z.object({
  media_id: z.string().nullable(),
  type: z.enum(["image", "video"]),
  url: z.string().nullable(),
  alt_text: z.string().nullable(),
  limitation: z.string().nullable(),
});
export const quoteSchema = z.object({
  id: z.string().nullable(),
  url: z.string().nullable(),
  author: z.object({
    username: z.string().nullable(),
    display_name: z.string().nullable(),
  }),
  text: z.string().nullable(),
  published_at: z.string().nullable(),
  retrieved_at: z.string(),
  evidence_links: z.array(
    z.object({ url: z.string(), display: z.string().nullable() }),
  ),
  truncated: z.boolean(),
  unavailable: z.boolean(),
  media: z.array(mediaSchema),
});
export const postSchema = z.object({
  article_preview: z
    .object({
      title: z.string().nullable(),
      text: z.string().nullable(),
      limitation: z.string(),
    })
    .optional(),
  id: z.string(),
  url: z.string(),
  author: z.object({
    username: z.string().nullable(),
    display_name: z.string().nullable(),
  }),
  text: z.string().nullable(),
  published_at: z.string().nullable(),
  retrieved_at: z.string(),
  parent_id: z.string().nullable(),
  parent_evidence: z
    .object({
      kind: z.literal("explicit_reply_link"),
      source_url: z.string(),
      label: z.string(),
    })
    .nullable(),
  quoted_posts: z.array(quoteSchema),
  evidence_links: z.array(
    z.object({ url: z.string(), display: z.string().nullable() }),
  ),
  media: z.array(mediaSchema),
  engagement: z.object({
    replies: z.string().nullable(),
    reposts: z.string().nullable(),
    likes: z.string().nullable(),
    views: z.string().nullable(),
    bookmarks: z.string().nullable(),
  }),
  truncated: z.boolean(),
  unavailable: z.boolean(),
  relation: z.enum(["focal", "ancestor_context", "conversation", "result"]),
  observed_on: z.string(),
  traversal_depth: z.number().int(),
});
export type Post = z.infer<typeof postSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export const stopReasons = [
  "empty_results",
  "requested_post",
  "configured_limit",
  "snapshot_end",
  "no_further_visible_content",
  "scroll_budget",
  "page_budget",
  "depth_budget",
  "total_budget",
  "deadline",
  "cancelled",
  "login_required",
  "challenge",
  "rate_limited",
  "account_restricted",
  "protected_content",
  "unavailable",
  "navigation_error",
  "unexpected_redirect",
  "unsupported_sort",
  "extraction_error",
] as const;
export type StopReason = (typeof stopReasons)[number];
export const reportSchema = z.object({
  retrieved_at: z.string(),
  started_at: z.string(),
  focal_id: z.string().nullable(),
  observed_root_id: z.string().nullable(),
  ancestor_context_ids: z.array(z.string()),
  ordering: z.array(z.string()),
  posts_collected: z.number().int(),
  total_collected: z.number().int(),
  depth_reached: z.number().int(),
  unresolved_parents: z.number().int(),
  unexpanded_branches: z.array(
    z.object({ post_id: z.string(), reason: z.string() }),
  ),
  stop_reason: z.enum(stopReasons),
  pages_visited: z.number().int(),
  scrolls: z.number().int(),
  complete: z.literal(false),
  limitations: z.array(z.string()),
});
export type Report = z.infer<typeof reportSchema>;
export const resultSchema = z.object({
  search: z
    .object({ query: z.string(), sort: z.enum(["latest", "top"]) })
    .optional(),
  posts: z.array(postSchema),
  report: reportSchema,
  next_cursor: z.string().nullable(),
  cursor_expires_at: z.string().nullable(),
});
export type ReadResult = z.infer<typeof resultSchema>;
export const statusSchema = z.object({
  ready: z.boolean(),
  state: z.string(),
  checked_at: z.string(),
  browser_available: z.boolean(),
  dedicated_profile_exists: z.boolean(),
  action: z.string().nullable(),
});
export type Status = z.infer<typeof statusSchema>;
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }),
});
