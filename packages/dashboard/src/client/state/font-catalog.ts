/** Licensed Latin derivatives; source labels identify upstream families, not binary names.
 * RFN-restricted sources use neutral primary names and secondary attribution.
 * Keep this small UI registry in sync with assets/fonts/expanded/catalog.json. */
export const ADDITIONAL_FONTS = [
	{ id: "roboto", label: "Roboto", family: "Dreb Sans 01", group: "Sans-serif" },
	{ id: "open-sans", label: "Open Sans", family: "Dreb Sans 02", group: "Sans-serif" },
	{ id: "google-sans", label: "Google Sans", family: "Dreb Sans 03", group: "Sans-serif" },
	{ id: "inter", label: "Inter", family: "Dreb Sans 04", group: "Sans-serif" },
	{ id: "montserrat", label: "Montserrat", family: "Dreb Sans 05", group: "Sans-serif" },
	{ id: "poppins", label: "Poppins", family: "Dreb Sans 06", group: "Sans-serif" },
	{ id: "lato", label: "Lato", family: "Dreb Sans 07", group: "Sans-serif", reservedName: true },
	{ id: "roboto-condensed", label: "Roboto Condensed", family: "Dreb Sans 08", group: "Sans-serif" },
	{ id: "arimo", label: "Arimo", family: "Dreb Sans 09", group: "Sans-serif" },
	{ id: "noto-sans", label: "Noto Sans", family: "Dreb Sans 10", group: "Sans-serif" },
	{ id: "dm-sans", label: "DM Sans", family: "Dreb Sans 11", group: "Sans-serif" },
	{ id: "raleway", label: "Raleway", family: "Dreb Sans 12", group: "Sans-serif", reservedName: true },
	{ id: "nunito", label: "Nunito", family: "Dreb Sans 13", group: "Sans-serif" },
	{ id: "nunito-sans", label: "Nunito Sans", family: "Dreb Sans 14", group: "Sans-serif" },
	{ id: "rubik", label: "Rubik", family: "Dreb Sans 15", group: "Sans-serif" },
	{ id: "playfair-display", label: "Playfair Display", family: "Dreb Serif 01", group: "Serif", reservedName: true },
	{ id: "merriweather", label: "Merriweather", family: "Dreb Serif 02", group: "Serif", reservedName: true },
	{ id: "lora", label: "Lora", family: "Dreb Serif 03", group: "Serif", reservedName: true },
	{ id: "noto-serif", label: "Noto Serif", family: "Dreb Serif 04", group: "Serif" },
	{ id: "cormorant-garamond", label: "Cormorant Garamond", family: "Dreb Serif 05", group: "Serif" },
	{ id: "libre-baskerville", label: "Libre Baskerville", family: "Dreb Serif 06", group: "Serif", reservedName: true },
	{ id: "pt-serif", label: "PT Serif", family: "Dreb Text 07", group: "Serif", reservedName: true },
	{ id: "eb-garamond", label: "EB Garamond", family: "Dreb Serif 08", group: "Serif" },
	{ id: "fraunces", label: "Fraunces", family: "Dreb Serif 09", group: "Serif" },
	{ id: "bitter", label: "Bitter", family: "Dreb Serif 10", group: "Serif", reservedName: true },
	{ id: "source-serif-4", label: "Source Serif 4", family: "Dreb Serif 11", group: "Serif" },
	{ id: "newsreader", label: "Newsreader", family: "Dreb Serif 12", group: "Serif" },
	{ id: "crimson-text", label: "Crimson Text", family: "Dreb Serif 13", group: "Serif" },
	{ id: "arvo", label: "Arvo", family: "Dreb Serif 14", group: "Serif", reservedName: true },
	{ id: "bodoni-moda", label: "Bodoni Moda", family: "Dreb Serif 15", group: "Serif" },
] as const;

export type AdditionalFontId = (typeof ADDITIONAL_FONTS)[number]["id"];
