// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// The one-line header the hub and the characters stop share.
import Link from "next/link";
import { protoHref } from "./lib";

interface ProtoHeaderProps {
  book: string;
  issue: string;
  bookName: string;
  issueName: string;
  current: "hub" | "characters";
}

export function ProtoHeader({
  book,
  issue,
  bookName,
  issueName,
  current,
}: ProtoHeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-neutral-800 px-4 text-[12px] text-neutral-500">
      {current === "hub" ? (
        <span className="text-neutral-100">
          {bookName}, {issueName}
        </span>
      ) : (
        <Link href={protoHref("", book, issue)} className="hover:text-white">
          {bookName}, {issueName}
        </Link>
      )}
      <span>/</span>
      {current === "characters" ? (
        <span className="text-neutral-100">Characters</span>
      ) : (
        <Link
          href={protoHref("/characters", book, issue)}
          className="hover:text-white"
        >
          Characters
        </Link>
      )}
      <span>/</span>
      <Link
        href={protoHref("/editor", book, issue)}
        className="hover:text-white"
      >
        Pages
      </Link>
      <span className="flex-1" />
      <span>Prototype. Nothing on these screens is written or paid for.</span>
    </header>
  );
}
