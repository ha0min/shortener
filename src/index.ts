import { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import {
  acquireLock,
  fetchAnalyticsData,
  generateShortCode,
  getGitHubUsername,
  logAnalytics,
  releaseLock,
} from "./utils";
import {
  ShortenRequest,
  ShortenResponse,
  KVData,
  KVPair,
  ListAllResponse,
  Bindings,
  AnalyticsResponseType,
  AnalyticsEngineResponseType,
  AnalyticsRequestBody,
  AnalyticsOverviewResponse,
} from "./type";

/**
 * ------- start ---------
 */

const app = new Hono<{ Bindings: Bindings }>();
// Enable CORS
app.use("*", cors());

app.get("/ping", (c) => {
  return c.text("PONG!");
});

app.get("/", (c) => {
  return c.text("Hello World");
});

/**
 * ------- authentication ---------
 */

async function authMiddleware(
  c: Context<{ Bindings: Bindings }>,
  next: () => Promise<void>
) {
  const sessionId = getCookie(c, "url_shortener_gh_session");
  if (!sessionId) {
    console.log("authMiddleware session not found, not pass the middleware");
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  // Retrieve the session data from KV storage
  const sessionData = await c.env.URL_SHORTENER.get(`session:${sessionId}`);
  if (!sessionData) {
    console.log(
      "authMiddleware session data not found, not pass the middleware"
    );
    return c.json({ success: false, message: "Session not found" }, 403);
  }

  return next();
}

// Authentication route
app.post("/auth/callback", async (c: Context<{ Bindings: Bindings }>) => {
  const { code } = await c.req.json();
  console.log("auth/callback code", code);

  if (!code) {
    return c.json({
      success: false,
      message: "No code provided",
      url_shortener_gh_session: null,
    });
  }

  // check if already authenticated
  const sessionId = getCookie(c, "url_shortener_gh_session");
  if (sessionId) {
    console.log("auth/callback passed with existed sessionId", sessionId);

    return c.json({
      success: true,
      message: "Already authenticated",
      url_shortener_gh_session: sessionId,
    });
  }

  // Exchange code for access token
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    }
  );

  // handle error
  if (!tokenResponse.ok) {
    console.error(
      "auth/callback Failed to fetch access token:",
      await tokenResponse.text()
    );
    return c.json({
      success: false,
      message: tokenResponse,
      url_shortener_gh_session: null,
    });
  }

  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };

  if (!access_token) {
    console.error("auth/callback Failed to fetch access token from json.");
    return c.json({
      success: false,
      message: tokenResponse,
      url_shortener_gh_session: null,
    });
  }

  console.log(
    "auth/callback passed with generated access_token,",
    access_token
  );

  // Get user info from github
  const username = await getGitHubUsername(access_token).catch((error) => {
    console.error("auth/callback error", error);
    return null;
  });

  if (!username) {
    console.log("auth/callback failed with getting username,", access_token);
    return c.json({
      success: false,
      message: "Failed to fetch user data",
      url_shortener_gh_session: null,
    });
  }

  console.log("auth/callback get the username as:", username);
  // console.log("auth/callback c.env.THE_GITHUB_USERNAME", c.env.THE_GITHUB_USERNAME);
  if (username === c.env.THE_GITHUB_USERNAME) {
    // Generate a session ID
    const sessionId = nanoid();

    // Store the access token in KV storage
    await c.env.URL_SHORTENER.put(`session:${sessionId}`, access_token, {
      expirationTtl: 60 * 60 * 24, // 1 day
    });

    // Set the cookie with the session ID
    setCookie(c, "url_shortener_gh_session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24, // 1 day
    });

    // redirect to success page
    console.log("auth/callback success!");
    // TODO: redirect to web app dashboard
    return c.json({
      success: true,
      message: "Authentication successful",
      url_shortener_gh_session: sessionId,
    });
  } else {
    return c.json({
      success: false,
      message: "Authentication failed",
      url_shortener_gh_session: null,
    });
  }
});

// Add a new route to check the cookie
app.get("/auth/validate", async (c: Context<{ Bindings: Bindings }>) => {
  const sessionId = getCookie(c, "url_shortener_gh_session");
  if (!sessionId) {
    console.log("auth/validate failed, no sessionID");
    return c.json({ success: false, message: "Unauthorized" });
  }

  console.log("auth/validate sessionId", sessionId);

  const sessionData = await c.env.URL_SHORTENER.get(`session:${sessionId}`);
  console.log("auth/validate sessionData", sessionData);

  if (!sessionData) {
    // delete the cookie
    setCookie(c, "url_shortener_gh_session", "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 0, // Expire immediately
      expires: new Date(0),
    });
    console.log("auth/validate failed, no sessionData", sessionId);

    return c.json({ success: false, message: "Session not found" });
  }

  return c.json({ success: true, message: "Session found", isValid: true });
});

app.post("/auth/logout", async (c: Context<{ Bindings: Bindings }>) => {
  const sessionId = getCookie(c, "url_shortener_gh_session");

  if (!sessionId) {
    return c.json({ success: false, message: "Session not found" });
  }

  if (sessionId) {
    // Delete the KV pair
    await c.env.URL_SHORTENER.delete(`session:${sessionId}`);

    console.log("auth/logout sessionId logged out", sessionId);

    // Clear the cookie
    setCookie(c, "url_shortener_gh_session", "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 0, // Expire immediately
    });

    return c.json({ success: true, message: "Logged out successfully" });
  }
});
app.get("/auth/clear", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // List all keys in the KV namespace
    let keys = await c.env.URL_SHORTENER.list({ prefix: "session:" });

    // Delete only session KV pairs
    let deletedCount = 0;
    for (const key of keys.keys) {
      if (key.name.startsWith("session:")) {
        await c.env.URL_SHORTENER.delete(key.name);
        deletedCount++;
      }
    }

    return c.json({
      success: true,
      message: `${deletedCount} session KV pairs cleared successfully`,
    });
  } catch (error) {
    console.error("Error clearing session KV pairs:", error);
    return c.json(
      { success: false, message: "Failed to clear session KV pairs" },
      500
    );
  }
});

/**
 * ------- short url api ---------
 */

app.use("/api/*", authMiddleware);

app.get("/api/ping", (c) => {
  return c.json({ success: true, message: "pong" });
});

app.get("/api/clear/link", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // List all keys in the KV namespace
    let keys = await c.env.URL_SHORTENER.list({ prefix: "link:" });

    // Delete only session KV pairs
    let deletedCount = 0;
    for (const key of keys.keys) {
      if (key.name.startsWith("link:")) {
        await c.env.URL_SHORTENER.delete(key.name);
        deletedCount++;
      }
    }

    return c.json({
      success: true,
      message: `${deletedCount} link KV pairs cleared successfully`,
    });
  } catch (error) {
    console.error("Error clearing link KV pairs:", error);
    return c.json(
      { success: false, message: "Failed to clear link KV pairs" },
      500
    );
  }
});

app.get("/api/clear/urlId", async (c: Context<{ Bindings: Bindings }>) => {
  try {
    // List all keys in the KV namespace
    let keys = await c.env.URL_SHORTENER.list({ prefix: "urlId:" });

    // Delete only session KV pairs
    let deletedCount = 0;
    for (const key of keys.keys) {
      if (key.name.startsWith("urlId:")) {
        await c.env.URL_SHORTENER.delete(key.name);
        deletedCount++;
      }
    }

    return c.json({
      success: true,
      message: `${deletedCount} urlId KV pairs cleared successfully`,
    });
  } catch (error) {
    console.error("Error clearing urlId KV pairs:", error);
    return c.json(
      { success: false, message: "Failed to clear urlId KV pairs" },
      500
    );
  }
});

// Create KV pair (shorten URL)
app.post("/api/shorten", async (c) => {
  const body: ShortenRequest = await c.req.json();
  const {
    originalUrl,
    shortCode = generateShortCode(),
    expiration = -1,
    description = "",
  } = body;

  // Try to acquire a lock
  const lockId = await acquireLock(c, originalUrl);
  if (!lockId) {
    return c.json(
      {
        success: false,
        message: "Server is busy, please try again",
      } as ShortenResponse,
      429
    );
  }

  try {
    // Check if shortCode already exists
    const existingUrl = await c.env.URL_SHORTENER.get("link:" + shortCode);
    if (existingUrl) {
      console.log("/api/shorten failed as short Code exists:", shortCode);
      return c.json(
        {
          success: false,
          message: "Short code already exists",
        } as ShortenResponse,
        400
      );
    }

    let urlId = await c.env.URL_SHORTENER.get(`urlId:${originalUrl}`);
    let isNewUrlId = false;

    if (!urlId) {
      // Create new urlId
      urlId = nanoid();
      await c.env.URL_SHORTENER.put(`urlId:${originalUrl}`, urlId);
      isNewUrlId = true;
    }

    console.log(
      `/api/shorten ${isNewUrlId ? "created" : "retrieved"} urlId for url:`,
      urlId,
      originalUrl
    );

    // Validate the request parameters
    console.log(
      "/api/shorten create pair:",
      originalUrl,
      shortCode,
      expiration,
      description,
      urlId
    );

    // Prepare the data to be stored in KV
    const kvData: KVData = {
      originalUrl,
      description,
      urlId,
    };

    // Only set expiration if it's not -1
    if (expiration !== -1) {
      kvData.expiration = expiration;
    }

    // Convert the data to a JSON string for storage
    const shortUrl = `${new URL(c.req.url).origin}/${shortCode}`;

    // Store in KV

    await c.env.URL_SHORTENER.put(`link:${shortCode}`, JSON.stringify(kvData));
    const response: ShortenResponse = { shortUrl, originalUrl, success: true };
    return c.json(response, 201);
  } catch (error) {
    console.error("Error storing URL in KV:", error);
    return c.json(
      {
        success: false,
        message: "Failed to store shortened URL",
      } as ShortenResponse,
      500
    );
  } finally {
    // Always release the lock, even if an error occurred
    await releaseLock(c, originalUrl, lockId);
  }
});

/**
 * ------- dashboard api ---------
 */

// get all shortened url
app.get("/api/dashboard/all", async (c) => {
  console.log("/api/dashboard/all called.");
  // Fetch all keys from the KV store
  const { keys } = await c.env.URL_SHORTENER.list({ prefix: "link:" });

  // Initialize an array to store all URL data
  const allUrlData: KVPair[] = [];

  // Iterate through each key and fetch its corresponding data
  for (const key of keys) {
    const urlData = await c.env.URL_SHORTENER.get(key.name);
    if (urlData) {
      try {
        const parsedData = JSON.parse(urlData) as KVData;
        const kvPair: KVPair = {
          shortCode: key.name.replace("link:", ""),
          originalUrl: parsedData.originalUrl,
          urlId: parsedData.urlId,
        };

        // Only add expiration if it exists
        if (parsedData.expiration !== undefined) {
          kvPair.expiration = parsedData.expiration;
        }

        // Only add description if it exists
        if (parsedData.description !== undefined) {
          kvPair.description = parsedData.description;
        }

        allUrlData.push(kvPair);
      } catch (error) {
        console.error(
          `/api/dashboard/all Error parsing data for key ${key.name}:`,
          error
        );
        console.log("/api/dashboard/all Error parsing data for", urlData);
        // Optionally, you can skip this entry or add an error entry
      }
    }
  }

  const result = {
    success: true,
    data: allUrlData,
  } as ListAllResponse;

  console.log(
    "/api/dashboard/all called success with kv pair: ",
    allUrlData.length
  );

  // Return the collected data
  return c.json(result);
});

app.get("/api/analytics/url/:urlId", async (c) => {
  const urlId = c.req.param("urlId");
  const startDateTimestamp = c.req.query("startDate");
  const endDateTimestamp = c.req.query("endDate");

  if (!urlId) {
    console.log("/api/analytics/:urlId failed as no urlId provided");
    return c.json({
      success: false,
      message: "No urlId is provided.",
    } as AnalyticsResponseType);
  }

  let startDate: Date;
  let endDate: Date;

  if (!startDateTimestamp || !endDateTimestamp) {
    // If dates are not provided, default to the last 30 days
    endDate = new Date();
    startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    startDate = new Date(parseInt(startDateTimestamp));
    endDate = new Date(parseInt(endDateTimestamp));

    if (startDate >= endDate) {
      console.log("/api/analytics: startDate is not before endDate");
      return c.json(
        {
          success: false,
          message: "Start date must be before end date.",
        } as AnalyticsResponseType,
        400
      );
    }
  }
  
  const query = `
    SELECT 
        blob1 as urlId, 
        blob2 as shortCode, 
        formatDateTime(timestamp, '%Y-%m-%d') as date, 
        count() as count
    FROM TEST
    WHERE blob1 = '${urlId}' AND
    timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY urlId, shortCode, date
    ORDER BY date
  `;


  const API = `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/analytics_engine/sql`;

  try {
    const analyticsEngineResponse = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.API_TOKEN}`,
      },
      body: query,
    });

    if (!analyticsEngineResponse.ok) {
      const errorText = await analyticsEngineResponse.text();
      console.error(
        `Analytics engine error: ${analyticsEngineResponse.status} ${analyticsEngineResponse.statusText}`,
        errorText
      );
      return c.json(
        {
          success: false,
          message: "Error querying analytics data.",
        } as AnalyticsResponseType,
        500
      );
    }

    const analyticsData: any = await analyticsEngineResponse.json();

    console.log(analyticsData);

    const response: AnalyticsResponseType = {
      success: true,
      urlId,
      shortCodes: {},
      totalClicks: 0,
    };

    analyticsData.data.forEach((row: any) => {
      const { shortCode, date, count } = row;
      if (!response.shortCodes![shortCode]) {
        response.shortCodes![shortCode] = [];
      }
      response.shortCodes![shortCode].push({
        date,
        count: parseInt(count, 10),
      });
      response.totalClicks! += parseInt(count, 10);
    });

    return c.json(response);
  } catch (error) {
    console.error("Error processing analytics request:", error);
    return c.json(
      {
        success: false,
        message:
          "An unexpected error occurred while processing the analytics request.",
      } as AnalyticsResponseType,
      500
    );
  }
});

app.get("/api/analytics/overview", async (c: Context<{ Bindings: Bindings }>) => {
  try {

    const { keys } = await c.env.URL_SHORTENER.list({ prefix: "link:" });

    if (!keys.length) {
      return c.json({
        success: true,
        overview: {
          totalClicks: 0,
          totalLinks: 0,
          avgClicksPerLink: 0
        },
        recentLinks: []
      });
    }

    const analyticsData = await fetchAnalyticsData(c);
    
    if (!analyticsData) {
      return c.json({ success: false, message: "Failed to fetch analytics data" }, 500);
    }

    const { totalClicks } = analyticsData;
    const totalLinks = keys.length;
    const avgClicksPerLink = totalLinks ? totalClicks / totalLinks : 0;

    const response: AnalyticsOverviewResponse = {
      success: true,
      data: {
        totalClicks,
        totalLinks,
        avgClicksPerLink: parseFloat(avgClicksPerLink.toFixed(1)),
      },
    };

    return c.json(response);
  } catch (error) {
    console.error("Error fetching analytics overview:", error);
    return c.json({ success: false, message: "Failed to fetch analytics data" } as AnalyticsOverviewResponse, 500);
  }
});

/**
 * ------- redirect with short code ---------
 */

app.get("/:shortCode", async (c) => {
  const shortCode = c.req.param("shortCode");
  const urlData = await c.env.URL_SHORTENER.get("link:" + shortCode);

  if (!urlData) {
    return c.notFound();
  }

  const { originalUrl, expiration, urlId }:KVData = JSON.parse(urlData);

  if (expiration && Date.now() > expiration) {
    await c.env.URL_SHORTENER.delete("link:" + shortCode);
    return c.notFound();
  }

  // Log analytics
  await logAnalytics(c, shortCode, urlId);

  return c.redirect(originalUrl);
});

export default app;
