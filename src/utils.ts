import { nanoid } from "nanoid";

export async function getGitHubUsername(
  accessToken: string
): Promise<string | null> {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "YourAppName/1.0",
    },
  });

  if (!userResponse.ok) {
    console.error("Failed to fetch user data:", await userResponse.text());
    return null;
  }

  const userData: { login: string } = await userResponse.json();
  return userData.login;
}

export async function logAnalytics(c: any, shortCode: string, urlId: string) {
  console.log(`Analytics logged for shortCode: ${shortCode}, urlId: ${urlId}`);

  // Use the Workers Analytics engine to log the click event
  c.env.URL_CLICK_TRACKING.writeDataPoint({
    "blobs": [String(urlId), String(shortCode)],
    "indexes": [String(urlId)],
  });
}

export function generateShortCode(length: number = 4): string {
  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let result = "";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += characters.charAt(randomValues[i] % characters.length);
  }
  return result;
}

export async function acquireLock(c: any, url: string): Promise<string | null> {
  const lockId = nanoid();
  try {
    await c.env.URL_SHORTENER.put(`lock:${url}`, lockId, {
      expirationTtl: 60, // KV store typically uses seconds
    });
    // If put succeeds without throwing an error, we've acquired the lock
    return lockId;
  } catch (error) {
    console.error("Error acquiring lock:", error);
    return null;
  }
}

export async function releaseLock(c: any, url: string, lockId: string) {
  try {
    const currentLockId = await c.env.URL_SHORTENER.get(`lock:${url}`);
    if (currentLockId === lockId) {
      await c.env.URL_SHORTENER.delete(`lock:${url}`);
    }
  } catch (error) {
    console.error("Error releasing lock:", error);
  }
}
