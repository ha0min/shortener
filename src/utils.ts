export async function getGitHubUsername(accessToken: string): Promise<string | null> {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "YourAppName/1.0"
      },
    });
  
    if (!userResponse.ok) {
      console.error("Failed to fetch user data:", await userResponse.text());
      return null;
    }
  
    const userData: { login: string } = await userResponse.json();
    return userData.login;
  }