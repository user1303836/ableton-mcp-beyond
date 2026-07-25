export const docsContent: { path: string; title: string; level: "product" | "technical"; content: string }[] = [];
export type DocsContentEntry = (typeof docsContent)[number];
