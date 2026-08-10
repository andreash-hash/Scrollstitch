import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

/** Placeholder shipped in eas.json so an unconfigured build fails loudly. */
const DOMAIN_PLACEHOLDER = "SET_ME_TO_YOUR_SERVER_DOMAIN";

/**
 * Base URL of the Express API server — where every stitch actually happens.
 *
 * The value comes from EXPO_PUBLIC_DOMAIN, which Expo inlines at BUILD time,
 * so a wrong value cannot be corrected without a rebuild. It must be a bare
 * host ("api.scrollstitch.com"), not a URL: the scheme is added here, and
 * "https://host" would otherwise produce "https://https://host".
 */
export function getApiUrl(): string {
  const raw = process.env.EXPO_PUBLIC_DOMAIN?.trim();

  if (!raw || raw === DOMAIN_PLACEHOLDER) {
    throw new Error(
      "This build has no server configured. Set EXPO_PUBLIC_DOMAIN to your " +
        "server's hostname in eas.json and rebuild."
    );
  }

  // Tolerate a pasted URL rather than producing a nonsense address from it.
  const host = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host || host.includes("/") || host.includes(" ")) {
    throw new Error(
      `EXPO_PUBLIC_DOMAIN must be a bare hostname such as "api.scrollstitch.com" ` +
        `— got "${raw}".`
    );
  }

  return new URL(`https://${host}`).href;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown | undefined,
): Promise<Response> {
  const baseUrl = getApiUrl();
  const url = new URL(route, baseUrl);

  const res = await fetch(url.toString(), {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const baseUrl = getApiUrl();
    const url = new URL(queryKey.join("/") as string, baseUrl);

    const res = await fetch(url.toString(), {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
