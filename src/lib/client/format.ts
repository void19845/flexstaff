/** Mise en forme partagée par les pages. */

export function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

/** Code de récompense lisible à l'oral ou à taper : ABCD-EFGH-JKLM */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
export const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Minuscules sans accents, pour une recherche tolérante. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Jour AAAA-MM-JJ (dates du calendrier, sans heure) en toutes lettres : « jeudi 10 décembre 2026 » */
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const formatDay = (iso: string): string => dayFmt.format(new Date(`${iso}T00:00:00Z`));
/** Jour AAAA-MM-JJ en court : « 10/12/2026 » */
const shortDayFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeZone: "UTC" });
export const formatShortDay = (iso: string): string => shortDayFmt.format(new Date(`${iso}T00:00:00Z`));
/** Mois du calendrier (month : 0 à 11) : « décembre 2026 » */
const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
export const formatMonth = (year: number, month: number): string => monthFmt.format(new Date(Date.UTC(year, month, 1)));
