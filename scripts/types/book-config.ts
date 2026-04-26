export interface BookConfig {
  title: string;
  franchises: string[];
  characterContext: string;
  wikiUrls: Record<string, string>;
}

export interface CharacterRosterEntry {
  canonicalName: string;
  aliases: string[];
  description?: string;
  franchise?: string;
  firstSeenIssue: string;
  firstSeenPage: number;
}

export type CharacterRoster = Record<string, CharacterRosterEntry>;
