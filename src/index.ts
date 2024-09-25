import { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { nanoid } from 'nanoid';
import { getGitHubUsername } from './utils';

/**
 * ------- types ---------
 */

type Bindings = {
  URL_SHORTENER: KVNamespace;
  URL_CLICK_TRACKING: AnalyticsEngineDataset;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  THE_GITHUB_USERNAME: string;
};


type ShortenRequest = {
  originalUrl: string;
  shortCode?: string;
  expiration?: number; // Unix timestamp
  description?: string;
};

type ShortenResponse = {
  shortUrl: string;
  originalUrl?: string;
  success?: boolean;
  message?: string; // used for error
};

type KVData = {
  originalUrl: string;
  expiration?: number; // Unix timestamp
  description?: string;
}

type KVPair = {
  shortCode: string;
  originalUrl: string;
  expiration?: number; // Unix timestamp
  description?: string;
}

type ListAllResponse = {
  success: boolean;
  message?: string;
  data?: KVPair[];
}
/**
 * ------- start ---------
 */

const app = new Hono<{ Bindings: Bindings }>()
// Enable CORS
app.use("*", cors());

app.get('/ping', (c) => {
  return c.text('PONG!')
})

app.get('/', (c) => {
  return c.text('Hello World')
})


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
    console.log("authMiddleware session data not found, not pass the middleware");
    return c.json({ success: false, message: "Session not found" }, 403);
  }

  return next();
}

// Authentication route
app.post("/auth/callback", async (c: Context<{ Bindings: Bindings }>) => {
  const { code } = await c.req.json();
  console.log("auth/callback code", code);

  if (!code) {
    return c.json({ success: false, message: "No code provided", url_shortener_gh_session: null });
  }

  // check if already authenticated
  const sessionId = getCookie(c, "url_shortener_gh_session");
  if (sessionId) {
    return c.json({ success: true, message: "Already authenticated", url_shortener_gh_session: sessionId });
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
    console.error("Failed to fetch access token:", await tokenResponse.text());
    return c.json({ success: false, message: tokenResponse, url_shortener_gh_session: null });
  }

  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };

  if (!access_token) {
    return c.json({ success: false, message: tokenResponse, url_shortener_gh_session: null });
  }

  console.log("auth/callback access_token", access_token);

  // Get user info from github
  const username = await getGitHubUsername(access_token).catch((error) => {
    console.error("auth/callback error", error);
    return null;
  });

  if (!username) {
    return c.json({ success: false, message: "Failed to fetch user data", url_shortener_gh_session: null });
  }

  console.log("auth/callback user", username);
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
    console.log("auth/callback success");
    // TODO: redirect to web app dashboard
    return c.json({ success: true, message: "Authentication successful", url_shortener_gh_session: sessionId });
  } else {
    return c.json({ success: false, message: "Authentication failed", url_shortener_gh_session: null });
  }

});
// Add a new route to check the cookie
app.get("/auth/validate", async (c: Context<{ Bindings: Bindings }>) => {
  const sessionId = getCookie(c, "url_shortener_gh_session");
  if (!sessionId) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
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
    return c.json({ success: false, message: "Session not found" });
  }

  return c.json({ success: true, message: "Session found", isValid: true });
  
});

app.post("/auth/logout", async (c: Context<{ Bindings: Bindings }>) => {
  // Get the request body
  const body = await c.req.json();

  // Check if the body contains the expected data
  if (!body || typeof body !== 'object') {
    return c.json({ success: false, message: "Invalid request body" });
  }

  const sessionId = body.sessionId;

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
    let keys = await c.env.URL_SHORTENER.list();
    
    // Delete only session KV pairs
    let deletedCount = 0;
    for (const key of keys.keys) {
      if (key.name.startsWith('session:')) {
        await c.env.URL_SHORTENER.delete(key.name);
        deletedCount++;
      }
    }
    
    return c.json({ success: true, message: `${deletedCount} session KV pairs cleared successfully` });
  } catch (error) {
    console.error("Error clearing session KV pairs:", error);
    return c.json({ success: false, message: "Failed to clear session KV pairs" }, 500);
  }
});

/**
 * ------- short url api ---------
 */

app.use("/api/*", authMiddleware);

app.get("/api/ping", (c) => {
  return c.json({ success: true, message: "pong" });
});

// Create KV pair (shorten URL)
app.post("/api/shorten", async (c) => {
  const body: ShortenRequest = await c.req.json();
  const { originalUrl, shortCode = generateShortCode(), expiration = -1, description = "" } = body;

  
  // Check if shortCode already exists
  const existingUrl = await c.env.URL_SHORTENER.get("link:"+shortCode);
  if (existingUrl) {
    return c.json(
      { success: false, message: "Short code already exists" } as ShortenResponse,
      400
    );
  }

  // Validate the request parameters
  console.log("/api/shorten create pair:", originalUrl, shortCode, expiration, description);

  // Prepare the data to be stored in KV
  const kvData: KVData = {
    originalUrl,
    description,
  };

  // Only set expiration if it's not -1
  if (expiration !== -1) {
    kvData.expiration = expiration;
  }

  // Convert the data to a JSON string for storage
  const shortUrl = `${new URL(c.req.url).origin}/${shortCode}`;

  // Store in KV
  try {
    await c.env.URL_SHORTENER.put(
      `link:${shortCode}`,
      JSON.stringify(kvData)
    );
  } catch (error) {
    console.error("Error storing URL in KV:", error);
    return c.json({ success: false, message: "Failed to store shortened URL" } as ShortenResponse, 500);
  }

  const response: ShortenResponse = { shortUrl, originalUrl, success: true };
  return c.json(response, 201);
});


/** 
 * ------- dashboard api ---------
 */

// get all shortened url
app.get("/api/dashboard/all", async (c) => {
  console.log("/api/dashboard/all called.");
  // Fetch all keys from the KV store
  const { keys } = await c.env.URL_SHORTENER.list({ prefix: 'link:' });
  
  // Initialize an array to store all URL data
  const allUrlData: KVPair[] = [];

  // Iterate through each key and fetch its corresponding data
  for (const key of keys) {
    const urlData = await c.env.URL_SHORTENER.get(key.name);
    if (urlData) {
      try {
        const parsedData = JSON.parse(urlData) as KVData;
        const kvPair: KVPair = {
          shortCode: key.name.replace('link:', ''),
          originalUrl: parsedData.originalUrl,
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
        console.error(`/api/dashboard/all Error parsing data for key ${key.name}:`, error);
        // Optionally, you can skip this entry or add an error entry
      }
    }
  }

  const result =  {
    success: true,
    data: allUrlData
  } as ListAllResponse;

  console.log("/api/dashboard/all called success with kv pair: ", allUrlData.length);

  // Return the collected data
  return c.json(result);
});


/**
 * ------- redirect with short code ---------
 */

app.get("/:shortCode", async (c) => {
  const shortCode = c.req.param("shortCode");
  const urlData = await c.env.URL_SHORTENER.get("link:"+shortCode);

  if (!urlData) {
    return c.notFound();
  }

  const { originalUrl, expiration } = JSON.parse(urlData);

  if (expiration && Date.now() > expiration) {
    await c.env.URL_SHORTENER.delete("link:"+shortCode);
    return c.notFound();
  }

  // Log analytics
  await logAnalytics(c, "link:"+shortCode, originalUrl);

  return c.redirect(originalUrl);

  // mock redirect here
  // return c.text("Redirecting to " + originalUrl);
});

/**
 * ------- utils ---------
 */

async function logAnalytics(c: any, shortCode: string, originalUrl: string) {
  const cfProperties = c.req.raw.cf;
  if (!cfProperties) {
    console.error("logAnalytics cfProperties not found");
    return;
  };

  // console.log("logAnalytics cfProperties", cfProperties);

  const dataPoint = {
    shortCode,
    originalUrl,
    city: cfProperties.city,
    country: cfProperties.country,
    continent: cfProperties.continent,
    region: cfProperties.region,
    regionCode: cfProperties.regionCode,
    timezone: cfProperties.timezone,
  }

  // console.log("logAnalytics dataPoint", dataPoint);

  c.env.URL_CLICK_TRACKING.writeDataPoint({
    blobs: [
        dataPoint
    ],
    doubles: [
      cfProperties.metroCode,
      cfProperties.longitude,
      cfProperties.latitude,
    ],
    indexes: [cfProperties.postalCode],
  });
}

function generateShortCode(length: number = 4): string {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += characters.charAt(randomValues[i] % characters.length);
  }
  return result;
}


export default app