export interface IssueManifest {
  id: string;
  /** `issues.number`, the issue's number within its book. */
  number: number;
  name: string;
  pageCount: number;
  bubbleCount: number;
  audioCount: number;
  hasWebP: boolean;
  hasAudio: boolean;
  hasTimestamps: boolean;
  /** `issues.status`: `pending`, `processing` or `ready`. */
  status: string;
}

export interface BookManifest {
  id: string;
  name: string;
  /** The series this book is a volume of, or null for a standalone book. */
  series: { id: string; name: string; position: number | null } | null;
  issues: IssueManifest[];
}

/** A series and its books from the same manifest, lowest `position` first. */
export interface SeriesManifest {
  id: string;
  name: string;
  books: BookManifest[];
}

export interface Manifest {
  books: BookManifest[];
  series: SeriesManifest[];
  generatedAt: string;
}
