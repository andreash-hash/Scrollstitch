import { createClient, createConfig } from "@replit/revenuecat-sdk/client";
import { ReplitConnectors } from "@replit/connectors-sdk";

export async function getUncachableRevenueCatClient() {
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch("revenuecat");

  const client = createClient(
    createConfig({
      baseUrl: "https://api.revenuecat.com/v2",
      fetch: proxyFetch as typeof fetch,
    })
  );

  return client;
}
