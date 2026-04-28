export interface IssueManifest {
  id: string;
  name: string;
  pageCount: number;
  bubbleCount: number;
  audioCount: number;
  hasWebP: boolean;
  hasAudio: boolean;
  hasTimestamps: boolean;
}

export interface BookManifest {
  id: string;
  name: string;
  issues: IssueManifest[];
}

export interface Manifest {
  books: BookManifest[];
  generatedAt: string;
}
