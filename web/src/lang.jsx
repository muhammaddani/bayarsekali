// Display names for a listing's content language code.
const NAMES = { en: "English", id: "Bahasa Indonesia" };

export function languageName(code) {
  if (!code) return "";
  return NAMES[code] || NAMES[code.split("-")[0]] || code;
}

// The small line under a listing title: its English summary and, when
// the content is not in English, the language it is written in.
export function ListingSubline({ listing, className = "subline" }) {
  const lang = listing.contentLanguage && !/^en\b/.test(listing.contentLanguage)
    ? languageName(listing.contentLanguage)
    : "";
  if (!listing.summaryEn && !lang) return null;
  return (
    <span className={className}>
      {listing.summaryEn}
      {lang ? <span className={listing.summaryEn ? "lang" : "lang lang-only"}>in {lang}</span> : null}
    </span>
  );
}
