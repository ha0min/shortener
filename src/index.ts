import { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';


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
};

type ShortenResponse = {
  shortUrl: string;
  originalUrl: string;
  success: boolean;
};

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
  const token = getCookie(c, "auth_token");
  console.log("authMiddleware token", token);
  if (!token) {
    console.log("authMiddleware token not found, redirecting to login");
    return c.redirect("/auth/login");
  }
  // Verify token with GitHub
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  console.log("authMiddleware userResponse", userResponse);

  if (!userResponse.ok) {
    return c.redirect("/auth/login");
  }
  const user = (await userResponse.json()) as { login: string };
  console.log("authMiddleware user", user);
  if (user.login !== c.env.THE_GITHUB_USERNAME) {
    return c.text("Unauthorized", 401);
  }
  return next();
}

// Authentication routes
app.get("/auth/login", (c: Context<{ Bindings: Bindings }>) => {
  const url = `https://github.com/login/oauth/authorize?client_id=${c.env.GITHUB_CLIENT_ID}`;
  return c.redirect(url);
});

app.get("/auth/callback", async (c: Context<{ Bindings: Bindings }>) => {
  const code = c.req.query("code");
  // console.log("auth/callback code", code);

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

  // console.log("auth/callback tokenResponse", tokenResponse);

  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };

  // console.log("auth/callback access_token", access_token);

  // Get user info
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${access_token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "YourAppName/1.0" // Add this line
    },
  });

  // console.log("auth/callback userResponse", userResponse);

  if (!userResponse.ok) {
    console.error("Failed to fetch user data:", await userResponse.text());
    return c.text("Authentication failed", 500);
  }

  const userData: { login: string } = await userResponse.json();
  const username = userData.login;

  // console.log("auth/callback user", username);
  // console.log("auth/callback c.env.THE_GITHUB_USERNAME", c.env.THE_GITHUB_USERNAME);
  if (username === c.env.THE_GITHUB_USERNAME) {
    // Set the cookie with more specific options
    setCookie(c, "auth_token", access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax", // Changed from "Strict" to "Lax"
      path: "/", // Explicitly set the path
      maxAge: 60 * 60 * 24, // 1 day
    });
    return c.redirect("/auth/success");
  } else {
    return c.text("Unauthorized", 401);
  }
});

app.get("/auth/success", (c: Context<{ Bindings: Bindings }>) => {
  return c.text("Authentication successful");
});

// Add a new route to check the cookie
app.get("/auth/check", (c: Context<{ Bindings: Bindings }>) => {
  const token = getCookie(c, "auth_token");
  if (token) {
    return c.json({ authenticated: true, token });
  } else {
    return c.json({ authenticated: false });
  }
});


/**
 * ------- short url api ---------
 */

// Create KV pair (shorten URL)
app.post("/api/shorten", async (c) => {
  const body: ShortenRequest = await c.req.json();
  const { originalUrl, shortCode = generateShortCode(), expiration } = body;

  // Check if shortCode already exists
  const existingUrl = await c.env.URL_SHORTENER.get(shortCode);
  if (existingUrl) {
    return c.json(
      { success: false, message: "Short code already exists" },
      400
    );
  }

  const shortUrl = `${new URL(c.req.url).origin}/${shortCode}`;

  // Store in KV
  await c.env.URL_SHORTENER.put(
    shortCode,
    JSON.stringify({
      originalUrl,
      expiration,
    }),
    {
      expirationTtl: expiration
        ? Math.floor((expiration - Date.now()) / 1000)
        : undefined,
    }
  );

  const response: ShortenResponse = { shortUrl, originalUrl, success: true };
  return c.json(response, 201);
});

// mock
app.get("/api/:endpoint", async (c) => {
  const endpoint = c.req.param("endpoint");
  const response: ShortenResponse = { shortUrl: "http://localhost:8787/" + endpoint, originalUrl: "http://localhost:8787/" + endpoint, success: true };
  return c.json(response, 201);
});


/** 
 * ------- dashboard api ---------
 */


/**
 * ------- redirect with short code ---------
 */

app.get("/:shortCode", async (c) => {
  const shortCode = c.req.param("shortCode");
  const urlData = await c.env.URL_SHORTENER.get(shortCode);

  if (!urlData) {
    return c.notFound();
  }

  const { originalUrl, expiration } = JSON.parse(urlData);

  if (expiration && Date.now() > expiration) {
    await c.env.URL_SHORTENER.delete(shortCode);
    return c.notFound();
  }

  // Log analytics
  await logAnalytics(c, shortCode, originalUrl);

  // return c.redirect(originalUrl);

  // mock redirect here
  return c.text("Redirecting to " + originalUrl);
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

app.use("/api/*", authMiddleware);

export default app