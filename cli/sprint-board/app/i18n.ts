/**
 * Prose only. Ticket ids, titles, lane names, statuses, column headers and
 * people's names are never translated: they must match the tracker and Slack.
 */
import { save, store } from './util.ts';

export type Lang = 'en' | 'es';
let lang: Lang = store<Lang>('sprint-board-lang', 'en');

export const getLang = () => lang;
export function setLang(l: Lang): void {
  lang = l;
  save('sprint-board-lang', l);
  document.documentElement.lang = l;
  document.documentElement.dataset.lang = l;
}

/** tr('English', 'Español'): the two versions sit side by side where they are used. */
export const tr = (en: string, es: string) => (lang === 'es' ? es : en);
