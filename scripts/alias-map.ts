export const aliasMap = {
  // Power Rangers
  tommy: "Green Ranger",
  "tommy oliver": "Green Ranger",
  "green ranger": "Green Ranger",

  jason: "Red Ranger",
  "red ranger": "Red Ranger",

  kimberly: "Pink Ranger",
  "pink ranger": "Pink Ranger",

  trini: "Yellow Ranger",
  "yellow ranger": "Yellow Ranger",

  zack: "Black Ranger",
  "black ranger": "Black Ranger",

  billy: "Blue Ranger",
  "billy cranston": "Blue Ranger",
  "master splinter": "Splinter",

  // Note: "Blue Ranger" wasn't in your file, but Billy was.
  // We will map Billy to Blue Ranger to keep the naming convention consistent.

  // Support Characters
  "ms. sterling": "Grace Sterling",
  "grace sterling": "Grace Sterling",

  // Groups (Map to the dominant speaker or a generic group voice if needed)
  "jason and kimberly": "Red Ranger", // Default to Jason for now, or create a 'Group' entry
  "michelangelo & red ranger": "Michelangelo", // Default to Mikey for shared lines
  "yellow turtle ranger": "Michelangelo", // Default to Mikey for shared lines
  scientist: "Dr. Boyd", // Default to Mikey for shared lines
};

// Helper to normalize names (trim, lowercase) for lookup
export const getCanonicalName = (name: string) => {
  const cleanName = name.toLowerCase().trim();
  // Return the alias if it exists, otherwise return the original name (Title Cased)
  // This preserves names like "Shredder" or "Leonardo" that aren't in the alias map.
  return aliasMap[cleanName as keyof typeof aliasMap] || name;
};
