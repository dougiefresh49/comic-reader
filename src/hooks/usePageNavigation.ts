"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

interface UsePageNavigationOptions {
  prevPageLink?: string | null;
  nextPageLink?: string | null;
}

export function usePageNavigation({
  prevPageLink,
  nextPageLink,
}: UsePageNavigationOptions) {
  const router = useRouter();

  const navigatePrev = useCallback(() => {
    if (prevPageLink) router.push(prevPageLink);
  }, [prevPageLink, router]);

  const navigateNext = useCallback(() => {
    if (nextPageLink) router.push(nextPageLink);
  }, [nextPageLink, router]);

  return { navigatePrev, navigateNext };
}
