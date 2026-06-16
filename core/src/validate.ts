import { KIND_BY_TYPE, CATEGORY_BY_TYPE, type Category } from './constants.js';

export interface EntryInput {
  type: string; title?: string; summary?: string; category?: string;
}
export interface ValidationResult { ok: boolean; errors: string[]; category?: Category; }

export function validateEntryInput(e: EntryInput): ValidationResult {
  const errors: string[] = [];
  if (!e.type || !(e.type in KIND_BY_TYPE)) errors.push(`invalid type: ${e.type}`);
  else if (e.type === 'rollup') errors.push('rollup entries are system-generated; use collab.rollup');
  if (!e.title || !e.title.trim()) errors.push('title is required');
  if (!e.summary || !e.summary.trim()) errors.push('summary is required');
  else if (e.summary.length > 200) errors.push(`summary exceeds 200 chars (got ${e.summary.length})`);
  const category = (e.category || (e.type in CATEGORY_BY_TYPE ? CATEGORY_BY_TYPE[e.type as keyof typeof CATEGORY_BY_TYPE] : undefined)) as Category | undefined;
  if (!category || !['Index', 'Reference', 'Activity'].includes(category)) errors.push(`invalid category: ${category}`);
  return { ok: errors.length === 0, errors, category: category ?? undefined };
}
